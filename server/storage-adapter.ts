import fs from "node:fs";
import path from "node:path";
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  NoSuchKey,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Client } from "./s3-client";
import pino from "pino";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const BUCKET_NAME = process.env.S3_BUCKET_NAME || "deltasync-blocks";

export interface StorageAdapter {
  name: "s3" | "local";
  putObject(key: string, data: Uint8Array): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  headObject(key: string): Promise<boolean>;
  deleteObject(key: string): Promise<void>;
  getUploadUrl(key: string, expiresInSeconds?: number): Promise<string>;
}

export class S3StorageAdapter implements StorageAdapter {
  name = "s3" as const;

  async putObject(key: string, data: Uint8Array): Promise<void> {
    const s3 = getS3Client();
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: data,
        ContentLength: data.length,
      }),
    );
  }

  async getObject(key: string): Promise<Uint8Array> {
    const s3 = getS3Client();
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }),
    );
    const buf = await response.Body?.transformToByteArray();
    if (!buf) throw new Error(`Object ${key} returned empty body`);
    return buf;
  }

  async headObject(key: string): Promise<boolean> {
    try {
      const s3 = getS3Client();
      await s3.send(
        new HeadObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
        }),
      );
      return true;
    } catch (err: unknown) {
      if (err instanceof NoSuchKey) return false;
      const error = err as { Code?: string; name?: string };
      if (error?.Code === "NotFound" || error?.name === "NotFound") return false;
      return false;
    }
  }

  async deleteObject(key: string): Promise<void> {
    const s3 = getS3Client();
    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }),
    );
  }

  async getUploadUrl(key: string, expiresInSeconds = 3600): Promise<string> {
    const s3 = getS3Client();
    return getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        ContentType: "application/octet-stream",
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  name = "local" as const;
  private blocksDir: string;

  constructor() {
    this.blocksDir = path.resolve(process.cwd(), ".deltasync", "blocks");
    if (!fs.existsSync(this.blocksDir)) {
      fs.mkdirSync(this.blocksDir, { recursive: true });
    }
  }

  private getFilePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_\-/]/g, "_");
    const fullPath = path.join(this.blocksDir, safeKey);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return fullPath;
  }

  async putObject(key: string, data: Uint8Array): Promise<void> {
    const filePath = this.getFilePath(key);
    await fs.promises.writeFile(filePath, data);
  }

  async getObject(key: string): Promise<Uint8Array> {
    const filePath = this.getFilePath(key);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Local block not found: ${key}`);
    }
    const buf = await fs.promises.readFile(filePath);
    return new Uint8Array(buf);
  }

  async headObject(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);
    return fs.existsSync(filePath);
  }

  async deleteObject(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }

  async getUploadUrl(key: string): Promise<string> {
    const port = process.env.PORT || "5000";
    const host = process.env.APP_URL || `http://localhost:${port}`;
    return `${host}/api/public/storage/upload?key=${encodeURIComponent(key)}`;
  }
}

let storageInstance: StorageAdapter | null = null;

export function getStorageAdapter(): StorageAdapter {
  if (!storageInstance) {
    const driver = process.env.STORAGE_DRIVER || "s3";
    if (driver === "local") {
      log.info("[Storage] Initialized LocalStorageAdapter (.deltasync/blocks)");
      storageInstance = new LocalStorageAdapter();
    } else {
      log.info("[Storage] Initialized S3StorageAdapter");
      storageInstance = new S3StorageAdapter();
    }
  }
  return storageInstance;
}

export function resetStorageAdapter(): void {
  storageInstance = null;
}
