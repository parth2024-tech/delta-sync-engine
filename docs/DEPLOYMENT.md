# Deployment Guide - Deltasync

## Table of Contents

1. [Pre-Deployment](#pre-deployment)
2. [Local Development](#local-development)
3. [Docker Deployment](#docker-deployment)
4. [Kubernetes Deployment](#kubernetes-deployment)
5. [AWS ECS Deployment](#aws-ecs-deployment)
6. [Database Setup](#database-setup)
7. [S3 Configuration](#s3-configuration)
8. [Monitoring](#monitoring)
9. [Troubleshooting](#troubleshooting)

---

## Pre-Deployment

### 1. Prerequisites

- Node.js 22+
- Docker & Docker Compose (for containerized deployments)
- PostgreSQL 14+ (for production)
- S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, etc.)
- Git

### 2. Security Checklist

Before deploying to production, complete ALL items in [SECURITY.md](./SECURITY.md):

- [ ] JWT_SECRET is cryptographically random
- [ ] S3 credentials are not defaults (not `devaccesskey`/`devsecretkey`)
- [ ] `.env` is in `.gitignore`
- [ ] All environment variables are validated
- [ ] TLS/HTTPS is configured
- [ ] Rate limiting is tested

### 3. Clone & Install

```bash
git clone https://github.com/parth2024-tech/delta-sync-engine.git
cd delta-sync-engine

# Install dependencies
npm install

# (Optional) Compile native addon for better performance
cd native
cargo build --release
cd ..
```

---

## Local Development

### Quick Start with Docker Compose

```bash
# Start all services (API, MinIO, PostgreSQL)
docker-compose up -d

# Verify services
docker-compose ps

# Logs
docker-compose logs -f api
```

**Services:**
- API: http://localhost:5000
- MinIO Console: http://localhost:9001
- PostgreSQL: localhost:5432

### Manual Development Setup

```bash
# Tab 1: API Server
npm run dev

# Tab 2: Event Dispatcher (background jobs)
npx tsx --env-file=.env server/outbox-dispatcher.ts

# Tab 3: CLI (optional)
cd cli && npm run dev
```

**Verify it works:**

```bash
curl -X GET http://localhost:5000/api/public/sync/files \
  -H "Authorization: Bearer <api-key>"
```

---

## Docker Deployment

### Build Image

```bash
# Build for production
docker build --target production -t deltasync:latest .

# Verify build
docker run --rm deltasync:latest node --version
```

### Run Container

```bash
docker run \
  --name deltasync-api \
  -e JWT_SECRET=$(openssl rand -base64 32) \
  -e S3_REGION=us-east-1 \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_ACCESS_KEY_ID=$(aws configure get aws_access_key_id) \
  -e S3_SECRET_ACCESS_KEY=$(aws configure get aws_secret_access_key) \
  -e S3_BUCKET_NAME=company-deltasync-prod \
  -e DATABASE_URL=postgresql://user:pass@postgres:5432/deltasync \
  -e LOG_LEVEL=info \
  -e NODE_ENV=production \
  -e DB_BACKEND=postgres \
  -p 5000:5000 \
  deltasync:latest
```

### Docker Compose for Production

```yaml
# docker-compose.prod.yml
version: '3.8'

services:
  api:
    image: deltasync:latest
    ports:
      - "5000:5000"
    environment:
      JWT_SECRET: ${JWT_SECRET}
      S3_REGION: ${S3_REGION}
      S3_ENDPOINT: ${S3_ENDPOINT}
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY}
      S3_BUCKET_NAME: ${S3_BUCKET_NAME}
      DATABASE_URL: ${DATABASE_URL}
      NODE_ENV: production
      DB_BACKEND: postgres
    depends_on:
      - postgres
      - redis
    restart: unless-stopped
    networks:
      - deltasync

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: deltasync
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: deltasync
    volumes:
      - postgres_data:/var/lib/postgresql/data
    networks:
      - deltasync
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    networks:
      - deltasync
    restart: unless-stopped

volumes:
  postgres_data:

networks:
  deltasync:
```

**Deploy:**

```bash
docker-compose -f docker-compose.prod.yml up -d
```

---

## Kubernetes Deployment

### 1. Create Namespace

```bash
kubectl create namespace deltasync
```

### 2. Create Secrets

```bash
kubectl create secret generic deltasync-secrets \
  --from-literal=jwt-secret=$(openssl rand -base64 32) \
  --from-literal=s3-access-key-id=<your-key> \
  --from-literal=s3-secret-access-key=<your-secret> \
  --from-literal=db-password=<strong-password> \
  -n deltasync
```

### 3. Deploy PostgreSQL

```yaml
# k8s/postgres-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: postgres
  namespace: deltasync
spec:
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:16-alpine
        env:
        - name: POSTGRES_USER
          value: deltasync
        - name: POSTGRES_DB
          value: deltasync
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: deltasync-secrets
              key: db-password
        ports:
        - containerPort: 5432
        volumeMounts:
        - name: data
          mountPath: /var/lib/postgresql/data
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "1000m"
      volumes:
      - name: data
        emptyDir: {}  # Or use PersistentVolumeClaim for production
```

### 4. Deploy API

```yaml
# k8s/api-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: deltasync-api
  namespace: deltasync
spec:
  replicas: 3  # Scale horizontally
  selector:
    matchLabels:
      app: deltasync-api
  template:
    metadata:
      labels:
        app: deltasync-api
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsReadOnlyRootFilesystem: true
      containers:
      - name: api
        image: deltasync:latest
        ports:
        - containerPort: 5000
        env:
        - name: JWT_SECRET
          valueFrom:
            secretKeyRef:
              name: deltasync-secrets
              key: jwt-secret
        - name: S3_REGION
          value: "us-east-1"
        - name: S3_ENDPOINT
          value: "https://s3.amazonaws.com"
        - name: S3_ACCESS_KEY_ID
          valueFrom:
            secretKeyRef:
              name: deltasync-secrets
              key: s3-access-key-id
        - name: S3_SECRET_ACCESS_KEY
          valueFrom:
            secretKeyRef:
              name: deltasync-secrets
              key: s3-secret-access-key
        - name: S3_BUCKET_NAME
          value: "company-deltasync-prod"
        - name: DATABASE_URL
          value: "postgresql://deltasync:$(POSTGRES_PASSWORD)@postgres:5432/deltasync"
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: deltasync-secrets
              key: db-password
        - name: NODE_ENV
          value: "production"
        - name: DB_BACKEND
          value: "postgres"
        - name: LOG_LEVEL
          value: "info"
        livenessProbe:
          httpGet:
            path: /health
            port: 5000
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /ready
            port: 5000
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "2000m"
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        volumeMounts:
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: tmp
        emptyDir: {}
```

### 5. Create Service

```yaml
# k8s/api-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: deltasync-api
  namespace: deltasync
spec:
  type: LoadBalancer
  selector:
    app: deltasync-api
  ports:
  - protocol: TCP
    port: 80
    targetPort: 5000
```

### Deploy

```bash
kubectl apply -f k8s/
kubectl get deployments -n deltasync
kubectl get svc -n deltasync
```

---

## AWS ECS Deployment

### 1. Create Task Definition

```json
{
  "family": "deltasync-api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "deltasync-api",
      "image": "123456789.dkr.ecr.us-east-1.amazonaws.com/deltasync:latest",
      "portMappings": [
        {
          "containerPort": 5000,
          "hostPort": 5000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {
          "name": "NODE_ENV",
          "value": "production"
        },
        {
          "name": "DB_BACKEND",
          "value": "postgres"
        }
      ],
      "secrets": [
        {
          "name": "JWT_SECRET",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:deltasync/jwt-secret"
        },
        {
          "name": "S3_ACCESS_KEY_ID",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:deltasync/s3-access-key"
        },
        {
          "name": "S3_SECRET_ACCESS_KEY",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:deltasync/s3-secret-key"
        },
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:us-east-1:123456789:secret:deltasync/db-url"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/deltasync",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ],
  "executionRoleArn": "arn:aws:iam::123456789:role/ecs-task-execution-role",
  "taskRoleArn": "arn:aws:iam::123456789:role/ecs-task-role"
}
```

### 2. Create Service

```bash
aws ecs create-service \
  --cluster deltasync-prod \
  --service-name deltasync-api \
  --task-definition deltasync-api \
  --desired-count 3 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-123,subnet-456],securityGroups=[sg-789]}"
```

---

## Database Setup

### PostgreSQL with Backups

```bash
# Create database
createdb deltasync

# Run migrations
DATABASE_URL=postgresql://user:pass@localhost/deltasync \
  npx drizzle-kit push

# Verify
psql deltasync -c "\dt"
```

### Automated Backups

```bash
#!/bin/bash
# scripts/backup-db.sh

BACKUP_DIR="/backups/deltasync"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup database
pg_dump $DATABASE_URL | gzip > $BACKUP_DIR/db-$TIMESTAMP.sql.gz

# Upload to S3
aws s3 cp $BACKUP_DIR/db-$TIMESTAMP.sql.gz s3://backups/deltasync/

# Cleanup old backups (keep 30 days)
find $BACKUP_DIR -name "db-*.sql.gz" -mtime +30 -delete
```

**Schedule with cron:**

```bash
0 2 * * * /path/to/backup-db.sh
```

---

## S3 Configuration

### Create Bucket

```bash
aws s3 mb s3://company-deltasync-prod --region us-east-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket company-deltasync-prod \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket company-deltasync-prod \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'
```

### IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:HeadObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::company-deltasync-prod/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket"
      ],
      "Resource": "arn:aws:s3:::company-deltasync-prod"
    }
  ]
}
```

---

## Monitoring

### Health Check Endpoints

```bash
# Liveness probe
curl http://localhost:5000/health

# Readiness probe  
curl http://localhost:5000/ready
```

### Prometheus Metrics (Optional)

```bash
# Metrics endpoint
curl http://localhost:5000/metrics
```

### CloudWatch Logs

```bash
# View logs
aws logs tail /ecs/deltasync --follow

# Search for errors
aws logs filter-log-events \
  --log-group-name /ecs/deltasync \
  --filter-pattern "ERROR"
```

---

## Troubleshooting

### Container won't start

```bash
# Check logs
docker logs deltasync-api

# Verify environment variables
docker inspect deltasync-api | grep -A 20 Environment
```

### Database connection failed

```bash
# Test connection
psql postgresql://user:pass@host:5432/deltasync

# Check credentials in secrets manager
aws secretsmanager get-secret-value --secret-id deltasync/db-url
```

### S3 upload failures

```bash
# Verify S3 credentials
aws s3 ls s3://company-deltasync-prod/

# Check bucket policy
aws s3api get-bucket-policy --bucket company-deltasync-prod

# Verify IAM role
aws iam get-role-policy --role-name ecs-task-role --policy-name s3-access
```

### High memory usage

```bash
# Check Node memory
ps aux | grep node

# Enable memory profiling
NODE_DEBUG=memwatch node app.js
```

### Rate limiting issues

```bash
# Check rate limit headers
curl -v http://localhost:5000/api/public/sync/files | grep -i rate-limit

# Check Redis connectivity
redis-cli ping
```

---

## Performance Tuning

### Node.js

```bash
# Increase max file descriptors
ulimit -n 65536

# Enable HTTP/2 Server Push
export NODE_OPTIONS="--experimental-http2-push"
```

### PostgreSQL

```sql
-- Optimize for production
ALTER SYSTEM SET shared_buffers = '256MB';
ALTER SYSTEM SET effective_cache_size = '4GB';
ALTER SYSTEM SET maintenance_work_mem = '64MB';
ALTER SYSTEM SET checkpoint_completion_target = 0.9;
SELECT pg_reload_conf();
```

### S3

- Enable S3 Transfer Acceleration (if using AWS S3)
- Use multi-part uploads for large files
- Configure appropriate ACLs and policies

---

## See Also

- [SECURITY.md](./SECURITY.md) - Security hardening guide
- [ENVIRONMENT.md](./ENVIRONMENT.md) - Environment variables reference
- [API.md](./API.md) - API endpoint documentation
