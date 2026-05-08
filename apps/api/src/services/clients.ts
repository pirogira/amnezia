import { randomUUID } from "node:crypto";
import type { CreateClientRequest } from "@amnesia-veb/shared";
import { getDb } from "../db.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { getEncryptionMaster } from "../cryptoEnv.js";
import { getDriver } from "../drivers/index.js";
import { parseSubnetLastOctets } from "../wgConf.js";
import { buildAmneziaVpnUriForAwgClient } from "../amneziaVpnUri.js";
import { sshDetectVpnSubnetCidr } from "../ssh/tunnelSubnet.js";
import { buildVlessRealityUri, parseVlessRealityJson } from "../vlessUri.js";
import type { ServerRow } from "../drivers/types.js";

function nextOctetForServer(serverId: string, cidr: string): number {
  const { prefix } = parseSubnetLastOctets(cidr);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT assigned_ip FROM vpn_clients WHERE server_id = ? AND revoked_at IS NULL`,
    )
    .all(serverId) as { assigned_ip: string }[];
  let max = 1;
  const re = new RegExp(`^${prefix.replace(/\./g, "\\.")}\\.(\\d+)$`);
  for (const r of rows) {
    const m = re.exec(r.assigned_ip);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.min(max + 1, 254);
}

export async function createVpnClient(server: ServerRow, body: CreateClientRequest) {
  const db = getDb();

  if (body.protocol === "vless") {
    const reality = parseVlessRealityJson(server.vless_reality_json);
    if (!reality) {
      throw new Error(
        "Для VLESS задайте JSON Reality на сервере (pbk, sni, sid, …) — блок при добавлении сервера.",
      );
    }
    const uuid = randomUUID();
    const uri = buildVlessRealityUri({
      uuid,
      address: server.endpoint_host,
      port: body.listenPort,
      name: body.name,
      reality,
    });
    const id = randomUUID();
    const now = new Date().toISOString();
    const privEnc = encryptSecret("", getEncryptionMaster());
    const confEnc = encryptSecret(uri, getEncryptionMaster());
    db.prepare(
      `INSERT INTO vpn_clients (
      id, server_id, name, protocol, public_key, private_key_enc, client_conf_enc, assigned_ip, listen_port,
      security_json, endpoint_host, revoked_at, expires_at, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      server.id,
      body.name,
      body.protocol,
      uuid,
      privEnc,
      confEnc,
      "-",
      body.listenPort,
      JSON.stringify(body.security),
      server.endpoint_host,
      null,
      body.expiresAt ?? null,
      now,
    );
    return {
      id,
      clientConf: uri,
      publicKey: uuid,
      assignedIp: "-",
      createdAt: now,
    };
  }

  const driver = getDriver(server);
  const detectedCidr = await sshDetectVpnSubnetCidr(server);
  const effectiveCidr = detectedCidr ?? server.vpn_subnet_cidr;
  const serverForWg =
    detectedCidr != null && detectedCidr !== server.vpn_subnet_cidr
      ? { ...server, vpn_subnet_cidr: effectiveCidr }
      : server;
  const octet = nextOctetForServer(server.id, effectiveCidr);
  if (octet > 254) throw new Error("subnet exhausted");

  const decryptSshKey = () =>
    decryptSecret(server.ssh_private_key_enc, getEncryptionMaster());

  const created = await driver.createClient(serverForWg, body, decryptSshKey, octet);
  const id = randomUUID();
  const now = new Date().toISOString();
  const privEnc = encryptSecret(created.privateKey, getEncryptionMaster());
  const confEnc = encryptSecret(created.clientConf, getEncryptionMaster());
  const storedListenPort =
    body.protocol === "wireguard" || body.protocol === "amneziawg" ? server.listen_port : body.listenPort;

  db.prepare(
    `INSERT INTO vpn_clients (
      id, server_id, name, protocol, public_key, private_key_enc, client_conf_enc, assigned_ip, listen_port,
      security_json, endpoint_host, revoked_at, expires_at, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    server.id,
    body.name,
    body.protocol,
    created.publicKey,
    privEnc,
    confEnc,
    created.assignedIp,
    storedListenPort,
    JSON.stringify(body.security),
    server.endpoint_host,
    null,
    body.expiresAt ?? null,
    now,
  );

  let vpnUri: string | undefined;
  if (body.protocol === "amneziawg") {
    try {
      vpnUri = buildAmneziaVpnUriForAwgClient(
        server.name,
        serverForWg,
        server.listen_port,
        created.publicKey,
        created.clientConf,
        body.security.dns,
      );
    } catch {
      /* .conf без AWG / неполный разбор — только .conf */
    }
  }

  return {
    id,
    clientConf: created.clientConf,
    vpnUri,
    publicKey: created.publicKey,
    assignedIp: created.assignedIp,
    createdAt: now,
  };
}

export async function revokeVpnClient(server: ServerRow, clientId: string) {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM vpn_clients WHERE id = ? AND server_id = ?`)
    .get(clientId, server.id) as
    | {
        id: string;
        public_key: string;
        revoked_at: string | null;
        protocol: string;
      }
    | undefined;
  if (!row) throw new Error("client not found");
  if (row.revoked_at) return;

  if (row.protocol !== "vless") {
    const driver = getDriver(server);
    const decryptSshKey = () =>
      decryptSecret(server.ssh_private_key_enc, getEncryptionMaster());
    await driver.revokeClient(server, row.public_key, decryptSshKey);
  }

  db.prepare(`UPDATE vpn_clients SET revoked_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    clientId,
  );
}
