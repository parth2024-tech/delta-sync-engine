# API Reference - Deltasync Sync Engine

## Authentication

All API requests require authentication via either:

1. **Session Cookie** - For browser-based clients
2. **API Key** - For CLI and programmatic access (Bearer token in `Authorization` header)

### API Keys

API keys are 256-bit cryptographically secure credentials prefixed with `dks_`.

**Format:** `dks_<base64url-44-chars>`

**Storage:** Keys are stored as SHA-256 hashes in the database. Only the plaintext key is shown once during creation.

**Usage:**
```bash
curl -H "Authorization: Bearer dks_your-key-here" https://api.example.com/api/public/sync/files
```

### JWT Sessions

Sessions are created via login endpoint and stored as secure HTTP-only cookies.
Token expiry: 30 days
Token algorithm: HS256 (HMAC with SHA-256)

## Endpoints

### POST /api/public/sync/negotiate

**Purpose:** Request a file sync negotiation before upload

**Request:**
```json
{
  "path": "documents/report.pdf",
  "chunking": "cdc",
  "blockSize": 4096,
  "newSize": 5242880,
  "contentSha256": "sha256_hash_of_file",
  "chunks": [
    {
      "strongHash": "chunk_sha256_hash",
      "length": 4096,
      "weakHash": 12345
    }
  ],
  "snapshotCurrentVersionId": "version-id-or-null"
}
```

**Response:**
```json
{
  "negotiationId": "neg_123456",
  "expiresAt": "2026-05-25T11:23:29Z",
  "preSignedUrl": "https://s3.example.com/blocks?...",
  "preSignedUrlExpiry": 3600
}
```

**Status Codes:**
- `200 OK` - Negotiation created successfully
- `400 Bad Request` - Invalid input (missing fields, invalid hashes, etc.)
- `401 Unauthorized` - Missing or invalid authentication
- `429 Too Many Requests` - Rate limit exceeded

### POST /api/public/sync/upload

**Purpose:** Upload file chunks using delta encoding

**Request:**
- Content-Type: `multipart/form-data`
- Fields:
  - `negotiationId` - from /negotiate response
  - `metadata` - JSON with chunk operations
  - `delta` - binary data (literal bytes)

**Metadata Example:**
```json
{
  "ops": [
    { "type": "literal", "length": 1024 },
    { "type": "copy", "offset": 2048, "length": 512 }
  ]
}
```

**Response:**
```json
{
  "uploadId": "upload_789",
  "received": 50331648,
  "remaining": 0
}
```

**Status Codes:**
- `200 OK` - Upload received
- `400 Bad Request` - Invalid upload format
- `401 Unauthorized` - Invalid authentication or API key
- `413 Payload Too Large` - Exceeds 500MB limit
- `429 Too Many Requests` - Rate limit exceeded

### POST /api/public/sync/commit

**Purpose:** Finalize an upload and create file version

**Request:**
```json
{
  "negotiationId": "neg_123456",
  "path": "documents/report.pdf"
}
```

**Response:**
```json
{
  "fileId": "file_abc",
  "versionId": "version_123",
  "versionNo": 1,
  "size": 5242880,
  "contentSha256": "file_sha256_hash",
  "createdAt": "2026-05-25T10:23:29Z"
}
```

**Status Codes:**
- `201 Created` - Version created successfully
- `400 Bad Request` - Invalid negotiation or path
- `401 Unauthorized` - Invalid authentication
- `404 Not Found` - Negotiation ID not found
- `409 Conflict` - File is being modified concurrently

### GET /api/public/sync/download

**Purpose:** Download a file or specific version

**Query Parameters:**
- `fileId` - File ID (required)
- `version` - Version number (optional, defaults to latest)
- `Range` - HTTP range header for resumable downloads

**Response:**
- Content-Type: `application/octet-stream`
- Body: Binary file data (streamed)

**Status Codes:**
- `200 OK` - Full file
- `206 Partial Content` - Partial file (from Range header)
- `400 Bad Request` - Missing or invalid fileId
- `401 Unauthorized` - Invalid authentication
- `404 Not Found` - File or version not found

### GET /api/public/sync/files

**Purpose:** List all user files with metadata

**Query Parameters:**
- `skip` - Pagination offset (default: 0)
- `take` - Pagination limit (default: 20, max: 100)
- `sort` - Sort field: `name`, `size`, `updated` (default: `name`)

**Response:**
```json
{
  "files": [
    {
      "id": "file_123",
      "path": "documents/report.pdf",
      "versionCount": 3,
      "totalSize": 5242880,
      "currentVersionId": "version_latest",
      "updatedAt": "2026-05-25T10:23:29Z"
    }
  ],
  "total": 45,
  "skip": 0,
  "take": 20
}
```

**Status Codes:**
- `200 OK` - Files listed
- `401 Unauthorized` - Invalid authentication

## Error Responses

All error responses follow this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": "Additional context if available"
}
```

### Common Error Codes

- `INVALID_INPUT` - Request validation failed
- `NOT_FOUND` - Resource not found
- `UNAUTHORIZED` - Missing or invalid auth
- `RATE_LIMITED` - Too many requests
- `CONFLICT` - Concurrent modification
- `SERVER_ERROR` - Internal server error

## Rate Limiting

API endpoints are rate-limited per user:

- Negotiation requests: 100 per minute
- Upload requests: 1000 per hour
- Download requests: Unlimited
- File listing: 1000 per hour

Rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1234567890
```

## Security Headers

All responses include security headers:

```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: ...
```

## Pre-Signed S3 URLs

The `/negotiate` endpoint returns pre-signed S3 URLs for direct block uploads:

- Expiry: 15 minutes
- Method: PUT
- Bucket: `deltasync-blocks`
- Key: Block content hash (SHA-256)

**Example:**
```bash
curl -X PUT \
  --data-binary @block.dat \
  --header "Content-Length: 4096" \
  'https://s3.example.com/deltasync-blocks/sha256hash?X-Amz-Algorithm=...'
```

## Chunking Modes

### CDC (Content-Defined Chunking)

- Produces variable-sized chunks based on content boundaries
- More efficient for textual changes
- Recommended for most use cases

### Fixed

- Produces fixed-size blocks (typically 4096 bytes)
- Simple and predictable
- Legacy mode for backwards compatibility

## Versioning

Files support multiple versions. All versions are retained by default.

- Version numbers are 1-indexed
- Versions are immutable once committed
- Download specific versions via `?version=N` parameter
- Version retention can be configured per user

## Blob Format

Uploaded chunks are streamed as binary blobs:

- No framing or length prefixes
- De-chunked on server using metadata ops
- Checksum validation not enforced (rely on TLS)

## Related Documentation

- [Environment Variables](./ENVIRONMENT.md)
- [Deployment Guide](./DEPLOYMENT.md)
- [Security Hardening](./SECURITY.md)
- [CLI Usage](../cli/README.md)
