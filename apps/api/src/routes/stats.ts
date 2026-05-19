import type { FastifyInstance } from "fastify";
import { getDb } from "../db.js";
import type { ServerRow } from "../drivers/types.js";
import {
  fetchServerHostStats,
  fetchHostStatsViaSsh,
  resolvePanelHostStatsAuth,
} from "../services/hostStats.js";

async function requireUser(req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return (req.user as { sub: string }).sub;
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/host/stats", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const auth = resolvePanelHostStatsAuth();
    if (!auth) {
      return reply.code(503).send({
        error: "host_stats_unconfigured",
        message:
          "Добавьте сервер в панель (SSH на этот VPS) или задайте PANEL_HOST_SSH_* / PANEL_STATS_SERVER_ID в .env.",
      });
    }
    try {
      const stats = await fetchHostStatsViaSsh(auth);
      return { ok: true, stats };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(502).send({ error: "host_stats_failed", message: msg });
    }
  });

  app.get("/servers/:id/stats", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const id = (req.params as { id: string }).id;
    const row = getDb().prepare(`SELECT * FROM vpn_servers WHERE id = ?`).get(id) as ServerRow | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    try {
      const stats = await fetchServerHostStats(row);
      return { ok: true, stats };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.code(502).send({ error: "host_stats_failed", message: msg });
    }
  });
}
