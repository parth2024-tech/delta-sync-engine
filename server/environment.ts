/**
 * Environment variable validation.
 *
 * Validates all required environment variables at startup.
 * Prevents silent failures from missing credentials.
 * Should be called as early as possible in the application lifecycle.
 */

export interface EnvironmentConfig {
  jwtSecret: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3BucketName: string;
  logLevel: string;
  nodeEnv: string;
  dbBackend: "sqlite" | "postgres";
  databaseUrl?: string;
  redisUrl?: string;
  maxFileSize?: number;
  maxRequestSize?: number;
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentValidationError";
  }
}

export function validateEnvironment(): EnvironmentConfig {
  const errors: string[] = [];
  const nodeEnv = process.env.NODE_ENV || 'development';

  // Check critical security variables
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    errors.push('JWT_SECRET is required');
  } else if (
    nodeEnv === 'production' && (
      jwtSecret === 'deltasync-dev-secret-please-change-in-production' ||
      jwtSecret === 'your-secret-key-here-change-in-production'
    )
  ) {
    errors.push('JWT_SECRET must not use the default development value in production. Generate a secure key with: openssl rand -base64 32');
  } else if (jwtSecret.length < 16) {
    errors.push('JWT_SECRET must be at least 16 characters long');
  }

  // Check S3 configuration
  const s3Region = process.env.S3_REGION;
  const s3Endpoint = process.env.S3_ENDPOINT;
  const s3AccessKeyId = process.env.S3_ACCESS_KEY_ID;
  const s3SecretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const s3BucketName = process.env.S3_BUCKET_NAME;

  if (!s3Region) errors.push('S3_REGION is required');
  if (!s3Endpoint) errors.push('S3_ENDPOINT is required');
  if (!s3AccessKeyId)
    errors.push('S3_ACCESS_KEY_ID is required');
  if (!s3SecretAccessKey)
    errors.push('S3_SECRET_ACCESS_KEY is required');
  if (!s3BucketName) errors.push('S3_BUCKET_NAME is required');

  // Check sensitive values aren't using defaults in production
  if (
    nodeEnv === 'production' && (
      s3AccessKeyId === 'devaccesskey' ||
      s3SecretAccessKey === 'devsecretkey'
    )
  ) {
    errors.push('S3 credentials must not use default development values in production');
  }

  // Database configuration
  const dbBackend = (process.env.DB_BACKEND || 'sqlite') as 'sqlite' | 'postgres';
  if (dbBackend === 'postgres') {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      errors.push('DATABASE_URL is required when DB_BACKEND=postgres');
    } else if (!databaseUrl.startsWith('postgres://') && !databaseUrl.startsWith('postgresql://')) {
      errors.push('DATABASE_URL must be a valid PostgreSQL connection string');
    }
  }

  // Log level validation
  const logLevel = process.env.LOG_LEVEL || 'info';
  const validLogLevels = ['debug', 'info', 'warn', 'error', 'fatal'];
  if (!validLogLevels.includes(logLevel)) {
    errors.push(`LOG_LEVEL must be one of: ${validLogLevels.join(', ')}`);
  }

  // Node environment validation
  const validNodeEnvs = ['development', 'production', 'test'];
  if (!validNodeEnvs.includes(nodeEnv)) {
    errors.push(`NODE_ENV must be one of: ${validNodeEnvs.join(', ')}`);
  }

  if (errors.length > 0) {
    const message = `Environment validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`;
    throw new ValidationError(message);
  }

  // Parse optional numeric values
  const maxFileSize = process.env.MAX_FILE_SIZE
    ? parseInt(process.env.MAX_FILE_SIZE, 10)
    : undefined;
  const maxRequestSize = process.env.MAX_REQUEST_SIZE
    ? parseInt(process.env.MAX_REQUEST_SIZE, 10)
    : undefined;

  if (maxFileSize && isNaN(maxFileSize)) {
    throw new ValidationError('MAX_FILE_SIZE must be a valid number');
  }
  if (maxRequestSize && isNaN(maxRequestSize)) {
    throw new ValidationError('MAX_REQUEST_SIZE must be a valid number');
  }

  return {
    jwtSecret: jwtSecret!,
    s3Region: s3Region!,
    s3Endpoint: s3Endpoint!,
    s3AccessKeyId: s3AccessKeyId!,
    s3SecretAccessKey: s3SecretAccessKey!,
    s3BucketName: s3BucketName!,
    logLevel,
    nodeEnv,
    dbBackend,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    maxFileSize,
    maxRequestSize,
  };
}

/**
 * Log which environment variables are loaded (without exposing values).
 */
export function logEnvironmentStatus(config: EnvironmentConfig): void {
  console.info('[ENV] Environment validation passed:');
  console.info(`  - JWT_SECRET: configured (${config.jwtSecret.length} chars)`);
  console.info(`  - S3_REGION: ${config.s3Region}`);
  console.info(`  - S3_ENDPOINT: ${config.s3Endpoint}`);
  console.info(`  - S3_BUCKET_NAME: ${config.s3BucketName}`);
  console.info(`  - DB_BACKEND: ${config.dbBackend}`);
  console.info(`  - LOG_LEVEL: ${config.logLevel}`);
  console.info(`  - NODE_ENV: ${config.nodeEnv}`);
  if (config.maxFileSize) console.info(`  - MAX_FILE_SIZE: ${config.maxFileSize} bytes`);
  if (config.maxRequestSize) console.info(`  - MAX_REQUEST_SIZE: ${config.maxRequestSize} bytes`);
}
