import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";

export function writeAudit(
  adminId: string | null,
  action: string,
  detail: Record<string, unknown> | string,
): void {
  const d = getDb();
  const detailStr = typeof detail === "string" ? detail : JSON.stringify(detail);
  d.prepare(
    `INSERT INTO audit_logs (id, admin_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(randomUUID(), adminId, action, detailStr, new Date().toISOString());
}
