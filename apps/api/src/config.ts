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
  /** SSH на хост с панелью (VPS), если панель в Docker. Иначе PANEL_STATS_SERVER_ID. */
  panelStatsServerId: (process.env.PANEL_STATS_SERVER_ID ?? "").trim(),
  panelHostSsh: {
    host: (process.env.PANEL_HOST_SSH_HOST ?? "").trim(),
    port: Number(process.env.PANEL_HOST_SSH_PORT ?? "22"),
    user: (process.env.PANEL_HOST_SSH_USER ?? "root").trim(),
    privateKey: (process.env.PANEL_HOST_SSH_PRIVATE_KEY ?? "").trim(),
    privateKeyPath: (process.env.PANEL_HOST_SSH_PRIVATE_KEY_FILE ?? "").trim(),
    password: (process.env.PANEL_HOST_SSH_PASSWORD ?? "").trim(),
  },
};

export function ensureDatabaseDir(): void {
  const dir = dirname(config.databasePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
