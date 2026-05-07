import { getDb } from "../db.js";
import { writeAudit } from "../audit.js";
import { dockerComposeConfigQuiet, dockerContainerExists, runPortHook } from "../ssh/client.js";
import { buildSshAuthFromServer } from "../ssh/buildAuth.js";
import type { ServerRow } from "../drivers/types.js";

export type PortChangeResult =
  | { status: "applied"; port: number; remoteLog: string }
  | { status: "db_only"; port: number; message: string }
  | { status: "preflight_failed"; reason: string };

export async function changeServerListenPort(params: {
  server: ServerRow;
  newPort: number;
  adminId: string | null;
}): Promise<PortChangeResult> {
  const { server, newPort, adminId } = params;
  if (!Number.isInteger(newPort) || newPort < 1024 || newPort > 65535) {
    return { status: "preflight_failed", reason: "invalid port" };
  }

  const auth = buildSshAuthFromServer(server);

  const exists = await dockerContainerExists(auth, server.docker_wg_container);
  if (!exists) {
    writeAudit(adminId, "port_change_preflight", { container: server.docker_wg_container, ok: false });
    return { status: "preflight_failed", reason: "container missing" };
  }

  if (server.docker_compose_path) {
    const cfg = await dockerComposeConfigQuiet(auth, server.docker_compose_path);
    writeAudit(adminId, "port_change_compose_config", {
      path: server.docker_compose_path,
      ok: cfg.ok,
    });
    if (!cfg.ok) {
      return { status: "preflight_failed", reason: `compose config: ${cfg.stderr}` };
    }
  }

  if (server.port_change_hook_cmd) {
    const hook = await runPortHook(auth, server.port_change_hook_cmd, newPort);
    writeAudit(adminId, "port_change_hook", {
      hook: server.port_change_hook_cmd,
      code: hook.code,
      stderr: hook.stderr,
    });
    if (!hook.ok) {
      return { status: "preflight_failed", reason: hook.stderr || "hook failed" };
    }
    const db = getDb();
    db.prepare(`UPDATE vpn_servers SET listen_port = ? WHERE id = ?`).run(newPort, server.id);
    return { status: "applied", port: newPort, remoteLog: hook.stdout };
  }

  const db = getDb();
  db.prepare(`UPDATE vpn_servers SET listen_port = ? WHERE id = ?`).run(newPort, server.id);
  writeAudit(adminId, "port_change_db_only", {
    serverId: server.id,
    port: newPort,
    hint: "Set port_change_hook_cmd on server to run firewall/docker publish on VPS",
  });
  return {
    status: "db_only",
    port: newPort,
    message:
      "Listen port updated in panel DB only. Configure port_change_hook_cmd (e.g. /opt/amnesia/set-port.sh) to remap Docker/firewall on the VPS.",
  };
}
