import { randomBytes } from "node:crypto";
import type { CreateClientRequest } from "@amnesia-veb/shared";
import { buildClientConf, hostIpFromOctet, parseSubnetLastOctets } from "../wgConf.js";
import type { ServerRow, VpnDriver } from "./types.js";

function fakeWgKey(): string {
  const b = randomBytes(32);
  return Buffer.from(b).toString("base64").replace(/=+$/, "");
}

export const mockDriver: VpnDriver = {
  async createClient(server, body: CreateClientRequest, _decrypt, nextIpOctet) {
    if (body.protocol === "openvpn" || body.protocol === "cloak") {
      const { prefix } = parseSubnetLastOctets(server.vpn_subnet_cidr);
      const assignedIp = hostIpFromOctet(prefix, nextIpOctet);
      const stub = `# ${body.protocol} stub (MVP)\n# Assign name=${body.name} ip=${assignedIp}\n`;
      return {
        publicKey: "stub",
        privateKey: "stub",
        assignedIp,
        clientConf: stub,
      };
    }
    const { prefix } = parseSubnetLastOctets(server.vpn_subnet_cidr);
    const assignedIp = hostIpFromOctet(prefix, nextIpOctet);
    const priv = fakeWgKey();
    const pub = fakeWgKey();
    const serverPub = fakeWgKey();
    const conf = buildClientConf({
      clientPrivateKey: priv,
      assignedIp,
      serverPublicKey: serverPub,
      endpoint: server.endpoint_host,
      listenPort: body.listenPort,
      security: body.security,
      protocol: body.protocol === "amneziawg" ? "amneziawg" : "wireguard",
    });
    return { publicKey: pub, privateKey: priv, assignedIp, clientConf: conf };
  },
  async revokeClient() {
    /* no-op */
  },
};
