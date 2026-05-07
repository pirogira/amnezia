import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

function deriveKey(master: string, salt: Buffer): Buffer {
  return scryptSync(master, salt, 32);
}

export function encryptSecret(plaintext: string, masterSecret: string): string {
  if (!masterSecret || masterSecret.length < 16) {
    throw new Error("PANEL_ENCRYPTION_KEY must be set to a long random string (16+ chars)");
  }
  const salt = randomBytes(16);
  const key = deriveKey(masterSecret, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload: string, masterSecret: string): string {
  const buf = Buffer.from(payload, "base64");
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const enc = buf.subarray(44);
  const key = deriveKey(masterSecret, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
