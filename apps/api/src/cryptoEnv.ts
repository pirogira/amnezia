import { config } from "./config.js";

export function getEncryptionMaster(): string {
  if (config.encryptionKey && config.encryptionKey.length >= 16) return config.encryptionKey;
  if (process.env.NODE_ENV === "production") {
    throw new Error("PANEL_ENCRYPTION_KEY must be set in production (16+ chars)");
  }
  return `${config.jwtSecret}:dev-fallback-encryption`;
}
