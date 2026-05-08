import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getDb } from "../db.js";
import type { ServerRow } from "../drivers/types.js";
import { changeServerListenPort } from "../services/portChange.js";
import { insertVpnServerRecord } from "../services/vpnServerInsert.js";
import { runProvisionAmneziaAwg } from "../provision/runner.js";
import { parseVlessRealityJson } from "../vlessUri.js";

const vlessRealityShape = z
  .object({
    pbk: z.string().min(1).max(512),
    sni: z.string().min(1).max(255),
    sid: z.string().min(1).max(64),
    fp: z.string().max(64).optional(),
    spx: z.string().max(512).optional(),
    type: z.string().max(32).optional(),
    encryption: z.string().max(32).optional(),
    security: z.string().max(32).optional(),
    flow: z.string().max(64).optional(),
  })
  .optional();

const serverCreate = z
  .object({
    name: z.string().min(1).max(128),
    sshHost: z.string().min(1).max(255),
    sshPort: z.coerce.number().int().min(1).max(65535).default(22),
    sshUser: z.string().min(1).max(64),
    sshPrivateKey: z.string().max(65535).default(""),
    sshPassword: z.string().max(2048).default(""),
    dockerWgContainer: z.string().min(1).max(128),
    wgInterface: z.string().regex(/^(?:wg|awg)[0-9]+$/).default("wg0"),
    vpnSubnetCidr: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/24$/),
    endpointHost: z.string().min(1).max(255),
    listenPort: z.coerce.number().int().min(1).max(65535).default(51820),
    dockerComposePath: z.string().max(512).nullable().optional(),
    composeServiceName: z.string().max(128).nullable().optional(),
    portChangeHookCmd: z.string().max(512).nullable().optional(),
    driverMode: z.enum(["ssh", "mock"]).default("ssh"),
    /** Параметры Reality для экспорта vless:// (опционально). */
    vlessReality: vlessRealityShape,
  })
  .superRefine((b, ctx) => {
    if (b.driverMode !== "ssh") return;
    if (!b.sshPrivateKey.trim() && !b.sshPassword.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Для SSH укажите приватный ключ (OpenSSH/RSA PEM) или пароль.",
        path: ["sshPrivateKey"],
      });
    }
  });

const portBody = z.object({
  port: z.coerce.number().int().min(1024).max(65535),
});

const serverProvision = z
  .object({
    name: z.string().min(1).max(128),
    sshHost: z.string().min(1).max(255),
    sshPort: z.coerce.number().int().min(1).max(65535).default(22),
    sshUser: z.string().min(1).max(64).default("root"),
    sshPrivateKey: z.string().max(65535).default(""),
    sshPassword: z.string().max(2048).default(""),
    endpointHost: z.string().min(1).max(255).optional(),
    listenPort: z.coerce.number().int().min(1).max(65535).default(51820),
    vpnSubnetCidr: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/24$/).default("10.8.0.0/24"),
    vlessReality: vlessRealityShape,
  })
  .superRefine((b, ctx) => {
    if (b.sshUser !== "root") {
      ctx.addIssue({
        code: "custom",
        message: "Провижининг поддерживается только для SSH-пользователя root.",
        path: ["sshUser"],
      });
    }
    if (!b.sshPrivateKey.trim() && !b.sshPassword.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "Для SSH укажите приватный ключ (OpenSSH/RSA PEM) или пароль.",
        path: ["sshPrivateKey"],
      });
    }
  });

async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return (req.user as { sub: string }).sub;
}

export async function serverRoutes(app: FastifyInstance): Promise<void> {
  app.post("/servers/provision", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const parsed = serverProvision.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;
    const endpointHost = (b.endpointHost?.trim() || b.sshHost).trim();
    const result = await runProvisionAmneziaAwg(sub, {
      name: b.name,
      sshHost: b.sshHost,
      sshPort: b.sshPort,
      sshUser: b.sshUser,
      sshPrivateKey: b.sshPrivateKey,
      sshPassword: b.sshPassword,
      endpointHost,
      listenPort: b.listenPort,
      vpnSubnetCidr: b.vpnSubnetCidr,
      vlessReality: b.vlessReality,
    });
    if (!result.ok) {
      return reply.code(502).send({
        error: "provision_failed",
        message: result.message,
        steps: result.steps,
      });
    }
    return { id: result.serverId, steps: result.steps };
  });

  app.get("/servers", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const rows = getDb().prepare(`SELECT * FROM vpn_servers ORDER BY created_at DESC`).all() as ServerRow[];
    return rows.map(sanitizeServer);
  });

  app.post("/servers", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const parsed = serverCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const b = parsed.data;
    const id = insertVpnServerRecord(sub, {
      name: b.name,
      sshHost: b.sshHost,
      sshPort: b.sshPort,
      sshUser: b.sshUser,
      sshPrivateKey: b.sshPrivateKey,
      sshPassword: b.sshPassword,
      dockerWgContainer: b.dockerWgContainer,
      wgInterface: b.wgInterface,
      vpnSubnetCidr: b.vpnSubnetCidr,
      endpointHost: b.endpointHost,
      listenPort: b.listenPort,
      dockerComposePath: b.dockerComposePath ?? null,
      composeServiceName: b.composeServiceName ?? null,
      portChangeHookCmd: b.portChangeHookCmd ?? null,
      driverMode: b.driverMode,
      vlessReality: b.vlessReality,
    });
    return { id };
  });

  app.get("/servers/:id", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const id = (req.params as { id: string }).id;
    const row = getDb().prepare(`SELECT * FROM vpn_servers WHERE id = ?`).get(id) as ServerRow | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    return sanitizeServer(row);
  });

  app.post("/servers/:id/listen-port", async (req, reply) => {
    const sub = await requireUser(req, reply);
    if (!sub) return;
    const id = (req.params as { id: string }).id;
    const parsed = portBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const row = getDb().prepare(`SELECT * FROM vpn_servers WHERE id = ?`).get(id) as ServerRow | undefined;
    if (!row) return reply.code(404).send({ error: "not_found" });
    const result = await changeServerListenPort({
      server: row,
      newPort: parsed.data.port,
      adminId: sub,
    });
    return result;
  });
}

function sanitizeServer(s: ServerRow) {
  return {
    id: s.id,
    name: s.name,
    sshHost: s.ssh_host,
    sshPort: s.ssh_port,
    sshUser: s.ssh_user,
    dockerWgContainer: s.docker_wg_container,
    wgInterface: s.wg_interface,
    vpnSubnetCidr: s.vpn_subnet_cidr,
    endpointHost: s.endpoint_host,
    listenPort: s.listen_port,
    dockerComposePath: s.docker_compose_path,
    composeServiceName: s.compose_service_name,
    portChangeHookCmd: s.port_change_hook_cmd,
    driverMode: s.driver_mode,
    vlessReality: parseVlessRealityJson(s.vless_reality_json ?? undefined),
    createdAt: s.created_at,
  };
}
