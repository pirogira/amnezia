import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { config } from "./config.js";
import { hashPassword } from "./password.js";

export function ensureBootstrapAdmin(): void {
  const db = getDb();
  const n = db.prepare(`SELECT COUNT(*) as c FROM admins`).get() as { c: number };

  /** Явный сброс пароля админа из .env (и после install.sh). В production — только по флагу; уберите из .env после входа. */
  const syncPwd =
    process.env.PANEL_BOOTSTRAP_UPDATE_PASSWORD === "true" && Boolean(config.bootstrapPassword);

  if (n.c > 0) {
    if (syncPwd) {
      const row = db
        .prepare(`SELECT id FROM admins WHERE username = ?`)
        .get(config.bootstrapUsername) as { id: string } | undefined;
      if (row) {
        const h = hashPassword(config.bootstrapPassword);
        db.prepare(`UPDATE admins SET password_hash = ? WHERE id = ?`).run(h, row.id);
        console.warn(
          `[panel] Обновлён пароль для "${config.bootstrapUsername}". Удалите PANEL_BOOTSTRAP_UPDATE_PASSWORD из .env после входа.`,
        );
      }
    }
    return;
  }

  const pwd = config.bootstrapPassword;
  if (!pwd) {
    console.warn(
      "[panel] Нет админов. Задайте PANEL_BOOTSTRAP_PASSWORD в .env и перезапустите API (или npm run db:reset).",
    );
    return;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const h = hashPassword(pwd);
  db.prepare(`INSERT INTO admins (id, username, password_hash, created_at) VALUES (?,?,?,?)`).run(
    id,
    config.bootstrapUsername,
    h,
    now,
  );
  console.warn(`[panel] Создан админ "${config.bootstrapUsername}" (bootstrap).`);
}
