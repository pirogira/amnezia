import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getDb } from "../db.js";
import { decryptSecret } from "../crypto.js";
import { getEncryptionMaster } from "../cryptoEnv.js";
import { writeAudit } from "../audit.js";
import type { CreateClientRequest } from "@amnesia-veb/shared";
import type { ServerRow } from "../drivers/types.js";
import { createVpnClient, revokeVpnClient } from "../services/clients.js";
import { buildAmneziaVpnUriForAwgClient } from "../amneziaVpnUri.js";

const createBody = z.object({
  name: z.string().min(1).max(128),
  protocol: z.enum(["amneziawg", "wireguard", "openvpn", "cloak", "vless"]),
  listenPort: z.coerce.number().int().min(1).max(65535),
  security: z
    .object({
      junkPacketCount: z.number().int().optional(),
      junkPacketMinSize: z.number().int().optional(),
      junkPacketMaxSize: z.number().int().optional(),
      initPacketJunkSize: z.number().int().optional(),
      responsePacketJunkSize: z.number().int().optional(),
      presharedKey: z.string().max(256).optional(),
      dns: z.string().max(255).optional(),
      includeIpv6DefaultRoute: z.boolean().optional(),
      mtu: z.coerce.number().int().min(576).max(1500).optional(),
    })
    .default({}),
  expiresAt: z.string().max(40).nullable().optional(),
});

async function requireUser(req: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return (req.user as { sub: string }).sub;
}

export async function clientRoutes(app: FastifyInstance): Promise<void> {
  app.get("/servers/:serverId/clients", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const serverId = (req.params as { serverId: string }).serverId;
    const rows = getDb()
      .prepare(
        `SELECT id, server_id, name, protocol, public_key, assigned_ip, listen_port, endpoint_host,
                revoked_at, expires_at, created_at
         FROM vpn_clients WHERE server_id = ? ORDER BY created_at DESC`,
      )
      .all(serverId) as Record<string, unknown>[];
    return rows;
  });

  app.post("/servers/:serverId/clients", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const serverId = (req.params as { serverId: string }).serverId;
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const row = getDb().prepare(`SELECT * FROM vpn_servers WHERE id = ?`).get(serverId) as ServerRow | undefined;
    if (!row) return reply.code(404).send({ error: "server_not_found" });
    const body = parsed.data as CreateClientRequest;
    if (
      row.driver_mode === "ssh" &&
      body.protocol !== "wireguard" &&
      body.protocol !== "amneziawg" &&
      body.protocol !== "vless"
    ) {
      return reply.code(400).send({ error: "protocol_not_supported_for_ssh_driver" });
    }
    try {
      const created = await createVpnClient(row, body);
      writeAudit(sub, "client_create", { clientId: created.id, serverId });
      return created;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      writeAudit(sub, "client_create_failed", { serverId, msg });
      return reply.code(500).send({ error: "create_failed", message: msg });
    }
  });

  app.delete("/clients/:clientId", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const clientId = (req.params as { clientId: string }).clientId;
    const row = getDb()
      .prepare(`SELECT * FROM vpn_clients WHERE id = ?`)
      .get(clientId) as { server_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    const server = getDb()
      .prepare(`SELECT * FROM vpn_servers WHERE id = ?`)
      .get(row.server_id) as ServerRow | undefined;
    if (!server) return reply.code(404).send({ error: "server_not_found" });
    try {
      await revokeVpnClient(server, clientId);
      writeAudit(sub, "client_revoke", { clientId });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      return reply.code(500).send({ error: "revoke_failed", message: msg });
    }
  });

  app.get("/clients/:clientId/wg.conf", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const clientId = (req.params as { clientId: string }).clientId;
    const row = getDb()
      .prepare(`SELECT client_conf_enc, revoked_at FROM vpn_clients WHERE id = ?`)
      .get(clientId) as { client_conf_enc: string | null; revoked_at: string | null } | undefined;
    if (!row || row.revoked_at) return reply.code(404).send({ error: "not_found" });
    if (!row.client_conf_enc) return reply.code(404).send({ error: "no_config" });
    const conf = decryptSecret(row.client_conf_enc, getEncryptionMaster());
    reply.header("Content-Type", "text/plain; charset=utf-8");
    return conf;
  });

  /** Ссылка `vpn://…` для импорта в приложение Amnezia (только AmneziaWG). */
  app.get("/clients/:clientId/vpn", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const clientId = (req.params as { clientId: string }).clientId;
    const row = getDb()
      .prepare(
        `SELECT c.protocol, c.client_conf_enc, c.public_key, c.listen_port, c.security_json, c.revoked_at,
                s.name as server_name, s.endpoint_host, s.docker_wg_container, s.vpn_subnet_cidr
         FROM vpn_clients c JOIN vpn_servers s ON c.server_id = s.id WHERE c.id = ?`,
      )
      .get(clientId) as
      | {
          protocol: string;
          client_conf_enc: string | null;
          public_key: string;
          listen_port: number;
          security_json: string | null;
          revoked_at: string | null;
          server_name: string;
          endpoint_host: string;
          docker_wg_container: string;
          vpn_subnet_cidr: string;
        }
      | undefined;
    if (!row || row.revoked_at) return reply.code(404).send({ error: "not_found" });
    if (row.protocol !== "amneziawg") {
      return reply.code(404).send({ error: "not_amneziawg", message: "vpn:// только для протокола AmneziaWG" });
    }
    if (!row.client_conf_enc) return reply.code(404).send({ error: "no_config" });
    const conf = decryptSecret(row.client_conf_enc, getEncryptionMaster());
    let security: { dns?: string } = {};
    try {
      if (row.security_json) security = JSON.parse(row.security_json) as { dns?: string };
    } catch {
      /* ignore */
    }
    try {
      const vpnUri = buildAmneziaVpnUriForAwgClient(
        row.server_name,
        {
          endpoint_host: row.endpoint_host,
          docker_wg_container: row.docker_wg_container,
          vpn_subnet_cidr: row.vpn_subnet_cidr,
        },
        row.listen_port,
        row.public_key,
        conf,
        security.dns,
      );
      return { vpnUri };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      return reply.code(500).send({ error: "vpn_uri_build_failed", message: msg });
    }
  });
}
