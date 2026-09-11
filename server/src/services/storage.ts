import crypto from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { env } from "../env.js";

/* ------------------------------------------------------------------ *
 *  S3 object storage — used for admin-uploaded branding assets (logos
 *  + favicon). Credentials are env-only (server/.env, AWS_* vars) — not
 *  configurable from the admin UI. The client is rebuilt whenever the
 *  config changes.
 * ------------------------------------------------------------------ */

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string; // optional — for S3-compatible providers (R2, MinIO, …)
  publicUrl: string; // optional — CDN / custom base URL for returned links
}

export function s3Config(): S3Config {
  return {
    bucket: env.AWS_S3_BUCKET,
    region: env.AWS_S3_REGION || "us-east-1",
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpoint: env.AWS_S3_ENDPOINT,
    publicUrl: env.AWS_S3_PUBLIC_URL,
  };
}

export function isStorageConfigured(): boolean {
  const c = s3Config();
  return Boolean(c.bucket && c.accessKeyId && c.secretAccessKey);
}

let cached: { client: S3Client; signature: string } | null = null;

function getClient(c: S3Config): S3Client {
  // Rebuild only when the effective config actually changes.
  const signature = `${c.region}|${c.accessKeyId}|${c.secretAccessKey}|${c.endpoint}`;
  if (cached && cached.signature === signature) return cached.client;
  const client = new S3Client({
    region: c.region,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    ...(c.endpoint ? { endpoint: c.endpoint, forcePathStyle: true } : {}),
  });
  cached = { client, signature };
  return client;
}

function extFor(mime: string, fallbackName: string): string {
  const byMime: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
    "image/gif": "gif",
  };
  if (byMime[mime]) return byMime[mime];
  const dot = fallbackName.lastIndexOf(".");
  return dot >= 0 ? fallbackName.slice(dot + 1).toLowerCase() : "bin";
}

function publicUrlFor(c: S3Config, key: string): string {
  if (c.publicUrl) return `${c.publicUrl.replace(/\/$/, "")}/${key}`;
  if (c.endpoint) return `${c.endpoint.replace(/\/$/, "")}/${c.bucket}/${key}`;
  return `https://${c.bucket}.s3.${c.region}.amazonaws.com/${key}`;
}

export interface UploadResult {
  url: string;
  key: string;
}

/** Upload a buffer under the given prefix and return its public URL + key. */
export async function uploadObject(
  prefix: string,
  body: Buffer,
  mime: string,
  originalName: string,
): Promise<UploadResult> {
  const c = s3Config();
  if (!isStorageConfigured()) {
    throw new Error("File storage is not configured. Add the AWS_* keys in server/.env and restart the API.");
  }
  const ext = extFor(mime, originalName);
  const key = `${prefix.replace(/^\/|\/$/g, "")}/${crypto.randomUUID()}.${ext}`;
  await getClient(c).send(
    new PutObjectCommand({
      Bucket: c.bucket,
      Key: key,
      Body: body,
      ContentType: mime || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return { url: publicUrlFor(c, key), key };
}

/** Best-effort delete of an object by its key (no-op if storage is unset). */
export async function deleteObject(key: string): Promise<void> {
  if (!key || !isStorageConfigured()) return;
  const c = s3Config();
  try {
    await getClient(c).send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
  } catch {
    /* best-effort — a stale asset left in the bucket is harmless */
  }
}

/* ------------------------------------------------------------------ *
 *  JSON blobs — cold storage for archived call transcripts. See
 *  services/callArchive.ts.
 *
 *  Kept apart from `uploadObject` because these use a CALLER-CHOSEN, stable
 *  key (one per call) instead of a random UUID: the archiver has to be able to
 *  re-derive a call's key, and a re-run must overwrite rather than litter the
 *  bucket with orphans nothing points at.
 * ------------------------------------------------------------------ */

/** Write `value` as JSON at an exact key. Overwrites whatever was there. */
export async function putJsonObject(key: string, value: unknown): Promise<void> {
  const c = s3Config();
  if (!isStorageConfigured()) {
    throw new Error("File storage is not configured. Add the AWS_* keys in server/.env and restart the API.");
  }
  await getClient(c).send(
    new PutObjectCommand({
      Bucket: c.bucket,
      Key: key,
      Body: Buffer.from(JSON.stringify(value), "utf8"),
      ContentType: "application/json",
    }),
  );
}

/**
 * Read a JSON object back by key.
 *
 * Returns null when the key is missing, storage is unconfigured, or the body
 * won't parse. A call whose blob has gone astray then renders with an empty
 * transcript instead of 500-ing the owner's inbox — the row itself still holds
 * every field the page actually needs (caller, duration, outcome, summary).
 */
export async function getJsonObject<T = unknown>(key: string): Promise<T | null> {
  if (!key || !isStorageConfigured()) return null;
  const c = s3Config();
  try {
    const out = await getClient(c).send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
    const body = await out.Body?.transformToString();
    return body ? (JSON.parse(body) as T) : null;
  } catch {
    return null;
  }
}
