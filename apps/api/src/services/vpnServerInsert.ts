import { randomUUID } from "node:crypto";
import { getDb } from "../db.js";
import { encryptSecret } from "../crypto.js";
import { getEncryptionMaster } from "../cryptoEnv.js";
import { writeAudit } from "../audit.js";

export type VpnServerInsertInput = {
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKey: string;
  sshPassword: string;
  dockerWgContainer: string;
  wgInterface: string;
  vpnSubnetCidr: string;
  endpointHost: string;
  listenPort: number;
  dockerComposePath: string | null;
  composeServiceName: string | null;
  portChangeHookCmd: string | null;
  driverMode: "ssh" | "mock";
  vlessReality?: {
    pbk: string;
    sni: string;
    sid: string;
    fp?: string;
    spx?: string;
    type?: string;
    encryption?: string;
    security?: string;
    flow?: string;
  };
};

export function insertVpnServerRecord(adminId: string, b: VpnServerInsertInput): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  const master = getEncryptionMaster();
  const keyEnc = encryptSecret(b.sshPrivateKey.trim(), master);
  const pwdEnc = b.sshPassword.trim() ? encryptSecret(b.sshPassword.trim(), master) : null;
  const vlessJson = b.vlessReality ? JSON.stringify(b.vlessReality) : null;
  getDb()
    .prepare(
      `INSERT INTO vpn_servers (
        id, name, ssh_host, ssh_port, ssh_user, ssh_private_key_enc, ssh_password_enc,
        docker_wg_container, wg_interface, vpn_subnet_cidr, endpoint_host, listen_port,
        docker_compose_path, compose_service_name, port_change_hook_cmd, driver_mode, vless_reality_json, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      b.name,
      b.sshHost,
      b.sshPort,
      b.sshUser,
      keyEnc,
      pwdEnc,
      b.dockerWgContainer,
      b.wgInterface,
      b.vpnSubnetCidr,
      b.endpointHost,
      b.listenPort,
      b.dockerComposePath,
      b.composeServiceName,
      b.portChangeHookCmd,
      b.driverMode,
      vlessJson,
      now,
    );
  writeAudit(adminId, "server_create", { serverId: id, name: b.name });
  return id;
}
