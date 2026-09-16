import crypto from "node:crypto";
import { env } from "../env.js";

// AES-256-GCM for stored secrets. Key = sha256(SETTINGS_ENCRYPTION_KEY), falling back to JWT_SECRET —
// set a dedicated key in production.
const keyMaterial = process.env.SETTINGS_ENCRYPTION_KEY?.trim() || env.JWT_SECRET;
const KEY = crypto.createHash("sha256").update(keyMaterial).digest();

/** Returns "iv:authTag:ciphertext" (all base64). */
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(":");
}

export function decryptSecret(blob: string): string {
  const [iv, tag, data] = blob.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
