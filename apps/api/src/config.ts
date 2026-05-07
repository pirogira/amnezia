import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveFromRepo } from "./paths.js";

export const config = {
  port: Number(process.env.PANEL_API_PORT ?? "3001"),
  host: process.env.PANEL_API_HOST ?? "0.0.0.0",
  /** Всегда относительно корня репо, а не `apps/api` (иначе bootstrap и логин смотрят в разные SQLite). */
  databasePath: resolveFromRepo(process.env.PANEL_DATABASE_PATH ?? "data/panel.sqlite"),
  jwtSecret:
    process.env.PANEL_JWT_SECRET ??
    (process.env.NODE_ENV === "production"
      ? (() => {
          throw new Error("PANEL_JWT_SECRET is required in production");
        })()
      : "dev-insecure-jwt-secret-change-me------"),
  encryptionKey: process.env.PANEL_ENCRYPTION_KEY ?? "",
  /** В dev разрешаем любой Origin — иначе localhost vs 127.0.0.1 vs ::1 и разные порты ломают вход с Opera/Chrome. */
  corsOrigin:
    process.env.NODE_ENV === "production"
      ? (process.env.PANEL_CORS_ORIGIN ?? true)
      : true,
  bootstrapUsername: (process.env.PANEL_BOOTSTRAP_USERNAME ?? "admin").trim(),
  bootstrapPassword: (process.env.PANEL_BOOTSTRAP_PASSWORD ?? "").trim(),
  allowRegister: process.env.ALLOW_REGISTER === "true",
  trustProxy: process.env.TRUST_PROXY === "true",
};

export function ensureDatabaseDir(): void {
  const dir = dirname(config.databasePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
