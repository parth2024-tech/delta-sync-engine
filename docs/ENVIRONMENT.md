# Environment Variables Reference

## Required Variables

### Security

#### `JWT_SECRET`
- **Type:** String
- **Required:** Yes
- **Description:** Secret key for signing JWT tokens
- **Security:** Must be cryptographically random, at least 16 characters
- **Example:** `openssl rand -base64 32`
- **Note:** Do NOT use default values like `deltasync-dev-secret-please-change-in-production`

### S3 / Block Store

#### `S3_REGION`
- **Type:** String
- **Required:** Yes
- **Description:** AWS region or `auto` for auto-detection (e.g., Cloudflare R2)
- **Example:** `us-east-1` or `auto`

#### `S3_ENDPOINT`
- **Type:** URL
- **Required:** Yes
- **Description:** S3-compatible endpoint URL
- **Example:** `https://s3.amazonaws.com` or `https://your-r2-account.r2.cloudflarestorage.com`

#### `S3_ACCESS_KEY_ID`
- **Type:** String
- **Required:** Yes
- **Description:** S3 access key
- **Security:** Must NOT be tracked in git; use `.env.local` or secrets manager
- **Note:** Do NOT use default values like `devaccesskey`

#### `S3_SECRET_ACCESS_KEY`
- **Type:** String
- **Required:** Yes
- **Description:** S3 secret access key
- **Security:** Must NOT be tracked in git; use `.env.local` or secrets manager
- **Note:** Do NOT use default values like `devsecretkey`

#### `S3_BUCKET_NAME`
- **Type:** String
- **Required:** Yes
- **Description:** S3 bucket for storing file blocks
- **Example:** `deltasync-blocks`
- **Note:** Bucket must already exist and be accessible with provided credentials

### Database

#### `DATABASE_URL`
- **Type:** URL
- **Required:** When `DB_BACKEND=postgres`
- **Description:** Database connection string
- **Format:** `postgresql://user:password@host:port/database`
- **Example:** `postgresql://deltasync:mypassword@localhost:5432/deltasync`
- **Note:** For SQLite, this is ignored (uses `.deltasync/sqlite.db`)

#### `DB_BACKEND`
- **Type:** Enum (`sqlite` | `postgres`)
- **Default:** `sqlite`
- **Description:** Database backend to use
- **Recommendation:** Use `sqlite` for single-instance deployments, `postgres` for multi-instance

## Optional Variables

### Environment

#### `NODE_ENV`
- **Type:** Enum (`development` | `production` | `test`)
- **Default:** `development`
- **Description:** Application environment
- **Security:** Set to `production` to enable security headers like HSTS

#### `LOG_LEVEL`
- **Type:** Enum (`debug` | `info` | `warn` | `error` | `fatal`)
- **Default:** `info`
- **Description:** Logging verbosity level

### Upload Limits

#### `MAX_FILE_SIZE`
- **Type:** Integer (bytes)
- **Default:** `536870912` (500 MB)
- **Description:** Maximum file size for uploads
- **Example:** `1073741824` (1 GB)

#### `MAX_REQUEST_SIZE`
- **Type:** Integer (bytes)
- **Default:** `10485760` (10 MB)
- **Description:** Maximum request body size
- **Note:** Should be less than `MAX_FILE_SIZE`

### Caching (Optional)

#### `REDIS_URL`
- **Type:** URL
- **Required:** No
- **Description:** Redis connection for distributed rate limiting and caching
- **Format:** `redis://[:password]@host:port/[db]`
- **Example:** `redis://localhost:6379/0`
- **Note:** If not set, uses in-memory store (not suitable for multi-instance)

## Security Best Practices

### 1. Never Commit `.env` to Git
Use `.env.local` for local development:

```bash
# .gitignore
.env
.env.*.local
!.env.example
```

### 2. Generate Secrets Securely
```bash
# Generate JWT_SECRET
openssl rand -base64 32

# Generate API keys (done programmatically, but use crypto.randomBytes)
node -e "console.log('dks_' + require('crypto').randomBytes(32).toString('base64url'))"
```

### 3. Use Secrets Manager in Production
Instead of `.env` files:

**AWS Secrets Manager:**
```bash
aws secretsmanager get-secret-value --secret-id deltasync/prod
```

**Vault:**
```bash
vault kv get secret/deltasync/prod
```

**GitHub Secrets:**
```yaml
env:
  JWT_SECRET: ${{ secrets.JWT_SECRET }}
  S3_ACCESS_KEY_ID: ${{ secrets.S3_ACCESS_KEY_ID }}
```

### 4. Rotate Credentials Regularly
- S3 credentials: Every 90 days
- JWT_SECRET: When team members leave or if compromised
- Database passwords: Every 90 days

### 5. Use IAM Roles When Possible
Instead of access keys:

**AWS EC2:**
```bash
# Use EC2 IAM role attached to instance
# No need for S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY
```

**Cloudflare R2:**
Use service tokens tied to specific buckets

## Example Configurations

### Local Development (SQLite)
```bash
DATABASE_URL=postgres:///deltasync
REDIS_URL=redis://localhost:6379
JWT_SECRET=dev-secret-change-me
S3_REGION=auto
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_BUCKET_NAME=deltasync-blocks
LOG_LEVEL=debug
NODE_ENV=development
DB_BACKEND=sqlite
```

### Production (PostgreSQL + S3)
```bash
DATABASE_URL=postgresql://user:strong-password@prod-db.example.com:5432/deltasync
REDIS_URL=redis://:strong-password@prod-redis.example.com:6379/0
JWT_SECRET=<generate-with-openssl>
S3_REGION=us-east-1
S3_ENDPOINT=https://s3.amazonaws.com
S3_ACCESS_KEY_ID=<from-AWS-IAM>
S3_SECRET_ACCESS_KEY=<from-AWS-IAM>
S3_BUCKET_NAME=company-deltasync-prod
LOG_LEVEL=info
NODE_ENV=production
DB_BACKEND=postgres
MAX_FILE_SIZE=1073741824
HSTS_MAX_AGE=31536000
```

### Multi-Instance with Postgres
```bash
DATABASE_URL=postgresql://user:pass@postgres-cluster.example.com/deltasync
REDIS_URL=redis://redis-cluster.example.com:6379/0
JWT_SECRET=<secure-random>
S3_REGION=auto
S3_ENDPOINT=https://r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<R2-token>
S3_SECRET_ACCESS_KEY=<R2-secret>
S3_BUCKET_NAME=company-deltasync-blocks
NODE_ENV=production
DB_BACKEND=postgres
```

## Validation

The application validates all environment variables on startup:

```
[ENV] Environment validation passed:
  - JWT_SECRET: configured (32 chars)
  - S3_REGION: us-east-1
  - S3_ENDPOINT: https://s3.amazonaws.com
  - S3_BUCKET_NAME: deltasync-blocks
  - DB_BACKEND: postgres
  - LOG_LEVEL: info
  - NODE_ENV: production
  - MAX_FILE_SIZE: 1073741824 bytes
```

If validation fails:

```
CRITICAL: Environment validation failed:
  - JWT_SECRET must not use the default development value
  - S3_ACCESS_KEY_ID: configured but using dev default
  - DATABASE_URL is required when DB_BACKEND=postgres
```

## Migration Guide

### From Development to Production

1. **Generate new JWT_SECRET:**
   ```bash
   openssl rand -base64 32
   ```

2. **Set up PostgreSQL:**
   ```bash
   createdb deltasync
   DATABASE_URL=postgresql://user:pass@host/deltasync npm run migrate
   ```

3. **Set up S3 bucket:**
   ```bash
   aws s3 mb s3://company-deltasync-prod --region us-east-1
   ```

4. **Create S3 IAM user with policy:**
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "s3:GetObject",
           "s3:PutObject",
           "s3:HeadObject"
         ],
         "Resource": "arn:aws:s3:::company-deltasync-prod/*"
       }
     ]
   }
   ```

5. **Copy `.env.example` to `.env` and update:**
   ```bash
   cp .env.example .env
   # Edit .env with production values
   ```

6. **Verify with dry run:**
   ```bash
   NODE_ENV=production npm run validate-env
   ```

## Troubleshooting

### "JWT_SECRET must be at least 16 characters"
```bash
# Generate with: openssl rand -base64 32
JWT_SECRET=$(openssl rand -base64 32)
```

### "S3 credentials must not use default development values"
Update S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY with real credentials from AWS IAM.

### "DATABASE_URL is required when DB_BACKEND=postgres"
Set DATABASE_URL environment variable with your PostgreSQL connection string.

### "S3 bucket does not exist"
Create the bucket:
```bash
aws s3 mb s3://deltasync-blocks --region us-east-1
```

## See Also
- [Security Hardening Guide](./SECURITY.md)
- [Deployment Guide](./DEPLOYMENT.md)
- [API Reference](./API.md)
