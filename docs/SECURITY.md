# Security Hardening Guide - Deltasync

## Pre-Deployment Security Checklist

Before deploying Deltasync to production, ensure all items are completed:

### Critical (MUST FIX)

- [ ] **Environment Secrets**: All secrets in `.env.example` (no defaults in code)
- [ ] **JWT Secret**: Set `JWT_SECRET` to a cryptographically random value (min 16 chars)
  ```bash
  export JWT_SECRET=$(openssl rand -base64 32)
  ```
- [ ] **S3 Credentials**: Use real AWS IAM credentials, NOT defaults like `devaccesskey`
- [ ] **API Keys**: Generated keys are 256-bit, stored as SHA-256 hashes
- [ ] **Database Passwords**: Strong passwords for PostgreSQL connections
- [ ] **HTTPS Enabled**: All endpoints behind TLS 1.3+ reverse proxy
- [ ] **No `.env` in Git**: Ensure `.env` is in `.gitignore` (use `.env.local` or secrets manager)

### High Priority (MUST FIX BEFORE PROD)

- [ ] **Security Headers**: Verify HSTS, CSP, X-Frame-Options headers enabled
- [ ] **Rate Limiting**: Configured and tested under load
- [ ] **CORS**: Restricted to known origins
- [ ] **Input Validation**: All endpoints validated with Zod schemas
- [ ] **Error Messages**: Don't leak internal details in error responses
- [ ] **Logging**: Secrets not logged (never log tokens, keys, hashes)
- [ ] **Database**: Use encrypted connections (PostgreSQL SSL mode=require)
- [ ] **S3 Permissions**: Bucket policy restricts to required operations only

### Medium Priority (RECOMMENDED)

- [ ] **IP Whitelisting**: Restrict API access by IP if applicable
- [ ] **API Key Rotation**: Implement key expiration and rotation process
- [ ] **Audit Logging**: Track file access, API key usage, permission changes
- [ ] **Backup Strategy**: Automated database backups with encryption
- [ ] **Monitoring**: Set up alerts for failed logins, rate limit breaches
- [ ] **DDoS Protection**: Use WAF or Cloudflare in front of API

---

## Environment Security

### 1. Secret Management

**Never store secrets in `.env` committed to Git:**

```bash
# BAD ❌
.env (tracked in git) with JWT_SECRET=my-secret

# GOOD ✅
.env.example (safe to track, no secrets)
.env.local (not tracked, has real secrets)
```

**Use a secrets manager in production:**

- **AWS Secrets Manager**
  ```bash
  aws secretsmanager create-secret \
    --name deltasync/jwt-secret \
    --secret-string "$(openssl rand -base64 32)"
  ```

- **HashiCorp Vault**
  ```bash
  vault kv put secret/deltasync/prod \
    jwt_secret="$(openssl rand -base64 32)" \
    s3_access_key_id="..." \
    s3_secret_access_key="..."
  ```

- **GitHub Secrets** (for CI/CD)
  ```yaml
  - name: Deploy
    env:
      JWT_SECRET: ${{ secrets.JWT_SECRET }}
      S3_ACCESS_KEY_ID: ${{ secrets.S3_ACCESS_KEY_ID }}
  ```

### 2. API Key Security

**API Key Format & Generation:**

```typescript
// Generated keys are 256-bit, prefixed with 'dks_'
// Format: dks_<base64url-44-chars>
// Example: dks_KR-gKzAM_wN8...

import { generateApiKey, hashApiKey } from './server/api-key';

const key = generateApiKey(); // User sees this once
const hash = hashApiKey(key); // Store this in database
```

**Key Rotation Process:**

1. User generates new API key via dashboard
2. Both old and new keys work for 30 days (grace period)
3. User must manually revoke old key
4. After 30 days, old key stops working

**Invalidate Keys on User Logout:**

```typescript
// When user logs out
await db.update(apiKeys)
  .set({ revokedAt: new Date() })
  .where(eq(apiKeys.userId, userId))
  .run();
```

### 3. JWT Token Security

**Configuration:**
- Algorithm: HS256 (HMAC-SHA256)
- Expiry: 30 days
- Secret: From `JWT_SECRET` environment variable
- Signing: Immediate on login, never transmitted

**Session Invalidation:**

```typescript
// Manually revoke all sessions for a user
await logout(userId); // Deletes refresh tokens

// After password change, invalidate old sessions
await invalidateAllSessions(userId);
```

### 4. Password Security

**Hashing:**
- Algorithm: bcryptjs with 12 salt rounds
- Never store plaintext passwords
- Never log passwords

**Requirements:**
- Minimum 8 characters
- No character complexity requirement (NIST 2017 guidelines)
- Prevent common passwords with zxcvbn library (optional)

```typescript
import { hashPassword } from './server/auth';

const hash = await hashPassword(password);
// Store hash in database, never the plaintext
```

---

## Network Security

### 1. TLS/HTTPS

**MUST use TLS 1.3:**

```nginx
# Nginx configuration
ssl_protocols TLSv1.3;
ssl_ciphers HIGH:!aNULL:!MD5;
ssl_prefer_server_ciphers on;
```

**Certificate Management:**

- Use Let's Encrypt for free, auto-renewing certificates
- Or: AWS Certificate Manager for AWS ALBs
- Certificate pinning for CLI (optional, for maximum security)

### 2. Security Headers

**All responses include:**

```
X-Content-Type-Options: nosniff              # Prevent MIME sniffing
X-Frame-Options: DENY                        # Prevent clickjacking
X-XSS-Protection: 1; mode=block             # Legacy XSS protection
Strict-Transport-Security: max-age=31536000  # Enforce HTTPS (1 year)
Content-Security-Policy: ...                 # Control resource loading
```

**CSP Policy:**

```
default-src 'self'
script-src 'self'
style-src 'self' 'unsafe-inline'  # Required for Tailwind
img-src 'self' data: https:
font-src 'self' data:
connect-src 'self'
frame-ancestors 'none'
base-uri 'self'
form-action 'self'
```

### 3. CORS

**Whitelist specific origins:**

```typescript
const allowedOrigins = [
  'https://app.example.com',
  'https://api.example.com',
];

export function corsMiddleware(origin: string): boolean {
  return allowedOrigins.includes(origin);
}
```

**Not safe:**

```typescript
// ❌ NEVER allow all origins
'Access-Control-Allow-Origin': '*'

// ❌ NEVER wildcard subdomains
'Access-Control-Allow-Origin': 'https://*.example.com'
```

---

## Database Security

### 1. PostgreSQL Configuration

**Enable SSL connections:**

```bash
# In connection string
postgresql://user:pass@host:5432/db?sslmode=require
```

**Strong password policy:**

```sql
-- Require strong passwords
ALTER ROLE deltasync WITH PASSWORD 'super-strong-32-char-password-here';
```

**Row-Level Security (Optional):**

```sql
-- Only users can see their own files
CREATE POLICY user_isolation ON files
  USING (user_id = current_user_id());
```

### 2. Encryption at Rest

**Database:**
- AWS RDS: Enable encryption at launch
- PostgreSQL: Use pgcrypto or transparent disk encryption (LUKS)

**S3 Blocks:**
- Enable S3 server-side encryption (SSE-S3 or SSE-KMS)

### 3. Backup & Recovery

**Automated backups:**

```bash
# Daily backup to S3
0 2 * * * pg_dump deltasync | gzip | aws s3 cp - s3://backups/db-$(date +%Y%m%d).sql.gz
```

**Test recovery:**

```bash
# Monthly: Restore backup to test environment
aws s3 cp s3://backups/db-latest.sql.gz - | gunzip | psql deltasync
```

---

## Input Validation

### 1. Path Validation

**Prevent path traversal:**

```typescript
import { z } from 'zod';

const pathSchema = z.string()
  .refine(path => {
    // Reject unsafe patterns
    if (path.includes('..')) return false;
    if (path.includes('./')) return false;
    if (path.startsWith('/')) return false;
    // Reject null bytes and control characters
    if (/[\x00-\x1f]/.test(path)) return false;
    return true;
  });
```

### 2. Hash Validation

**Validate cryptographic hashes:**

```typescript
const sha256Regex = /^[a-f0-9]{64}$/;

const chunkSchema = z.object({
  strongHash: z.string().regex(sha256Regex, 'Invalid SHA-256 hash'),
  length: z.number().positive().max(MAX_CHUNK_SIZE),
  weakHash: z.number().optional(),
});
```

### 3. File Size Limits

```typescript
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_REQUEST_SIZE = 10 * 1024 * 1024; // 10MB

// Validate in upload handler
if (fileSize > MAX_FILE_SIZE) {
  throw new Error('File exceeds 500MB limit');
}
```

---

## Rate Limiting

### 1. Per-User Rate Limits

```typescript
import { rateLimit } from './server/rate-limiter';

// Apply limits per endpoint
export async function negotiateHandler(req, res) {
  await rateLimit(userId, 'negotiate', { max: 100, windowMs: 60000 });
  // ... handler logic
}
```

**Limits:**
- `/negotiate`: 100 per minute
- `/upload`: 1000 per hour
- `/download`: Unlimited
- `/files`: 1000 per hour

### 2. Per-IP Rate Limits (Optional)

```typescript
// For unauthenticated endpoints
const ipLimit = await rateLimit(clientIP, 'global', {
  max: 1000,
  windowMs: 3600000, // 1 hour
});
```

---

## Monitoring & Logging

### 1. Structured Logging

**Never log secrets:**

```typescript
// ❌ BAD
console.log('User logged in with token:', token);

// ✅ GOOD
console.log('User logged in', { userId, timestamp: new Date() });
```

**Include correlation IDs:**

```typescript
const correlationId = crypto.randomUUID();
logger.info(
  { correlationId, userId, action: 'file-upload' },
  'File uploaded successfully'
);
```

### 2. Audit Logging

**Track sensitive operations:**

```typescript
// Log file access
await auditLog.create({
  userId,
  action: 'FILE_DOWNLOADED',
  resourceId: fileId,
  timestamp: new Date(),
  ipAddress: req.ip,
});

// Log permission changes
await auditLog.create({
  userId,
  action: 'API_KEY_CREATED',
  resourceId: apiKeyId,
  details: { prefix: extractKeyPrefix(apiKey) },
});
```

### 3. Alerting

**Alert on suspicious activity:**

```typescript
// Alert if user fails login 5 times in 5 minutes
if (failedAttempts > 5) {
  await sendSecurityAlert(userId, 'Multiple failed login attempts');
  // Lock account temporarily
}

// Alert if API key used from new IP
if (newIpDetected) {
  await sendVerificationEmail(userId, ipAddress);
}
```

---

## Deployment Security

### 1. Container Security

**Use minimal base images:**

```dockerfile
# ✅ Use distroless or alpine
FROM node:22-alpine

# ❌ Avoid
FROM ubuntu:latest
```

**Run as non-root:**

```dockerfile
RUN useradd -m deltasync
USER deltasync
```

### 2. Secret Injection

**Use Docker secrets or environment variables:**

```bash
# ❌ Bad: Hardcode in Dockerfile
ENV JWT_SECRET=mysecret

# ✅ Good: Inject at runtime
docker run -e JWT_SECRET=$(aws secretsmanager get-secret-value ...) ...
```

### 3. Kubernetes Security

```yaml
# deployment.yaml
apiVersion: v1
kind: Pod
metadata:
  name: deltasync-api
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    fsReadOnlyRootFilesystem: true
  containers:
  - name: api
    image: deltasync:latest
    env:
    - name: JWT_SECRET
      valueFrom:
        secretKeyRef:
          name: deltasync-secrets
          key: jwt_secret
    securityContext:
      allowPrivilegeEscalation: false
      readOnlyRootFilesystem: true
```

---

## Incident Response

### 1. Suspected Compromise

If you suspect a security breach:

1. **Immediate Actions:**
   - Revoke all API keys
   - Rotate JWT_SECRET
   - Invalidate all sessions

2. **Investigation:**
   - Check audit logs for suspicious activity
   - Review access logs for unauthorized IPs
   - Audit S3 bucket for unexpected files

3. **Communication:**
   - Notify affected users
   - Document timeline of events
   - File incident report

### 2. Password Breach

If user passwords are compromised:

1. Force password reset for all users
2. Invalidate all sessions
3. Require MFA re-enrollment
4. Monitor for unauthorized access

---

## References

- [OWASP Top 10](https://owasp.org/Top10/)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [API Security Checklist](https://github.com/shieldfy/API-Security-Checklist)
- [AWS Security Best Practices](https://aws.amazon.com/security/best-practices/)

---

## Support

For security concerns or to report vulnerabilities:
- Email: security@example.com
- Please do NOT open public GitHub issues for security vulnerabilities
