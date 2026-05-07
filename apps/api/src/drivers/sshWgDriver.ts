import type { CreateClientRequest } from "@amnesia-veb/shared";
import {
  dockerContainerExists,
  dockerExecWgGenkey,
  dockerExecWgPubkey,
  dockerExecWgRemovePeer,
  dockerExecWgSetPeer,
  dockerExecWgShowPublicKey,
  type SshAuth,
} from "../ssh/client.js";
import { buildClientConf, hostIpFromOctet, parseSubnetLastOctets } from "../wgConf.js";
import type { ServerRow, VpnDriver } from "./types.js";

function authFrom(server: ServerRow, privateKey: string): SshAuth {
  return {
    host: server.ssh_host,
    port: server.ssh_port,
    username: server.ssh_user,
    privateKey,
  };
}

export const sshWgDriver: VpnDriver = {
  async createClient(server, body: CreateClientRequest, decryptSshKey, nextIpOctet) {
    if (body.protocol !== "wireguard" && body.protocol !== "amneziawg") {
      throw new Error("SSH driver supports wireguard/amneziawg only in MVP");
    }
    const key = decryptSshKey();
    const auth = authFrom(server, key);
    const ok = await dockerContainerExists(auth, server.docker_wg_container);
    if (!ok) throw new Error(`docker container not found: ${server.docker_wg_container}`);

    const clientPriv = await dockerExecWgGenkey(auth, server.docker_wg_container);
    const clientPub = await dockerExecWgPubkey(auth, server.docker_wg_container, clientPriv);
    const serverPub = await dockerExecWgShowPublicKey(
      auth,
      server.docker_wg_container,
      server.wg_interface,
    );

    const { prefix } = parseSubnetLastOctets(server.vpn_subnet_cidr);
    const assignedIp = hostIpFromOctet(prefix, nextIpOctet);
    const allowed = `${assignedIp}/32`;

    await dockerExecWgSetPeer(
      auth,
      server.docker_wg_container,
      server.wg_interface,
      clientPub,
      allowed,
    );

    const conf = buildClientConf({
      clientPrivateKey: clientPriv.trim(),
      assignedIp,
      serverPublicKey: serverPub.trim(),
      endpoint: server.endpoint_host,
      listenPort: body.listenPort,
      security: body.security,
    });

    return {
      publicKey: clientPub.trim(),
      privateKey: clientPriv.trim(),
      assignedIp,
      clientConf: conf,
    };
  },

  async revokeClient(server, publicKey, decryptSshKey) {
    const auth = authFrom(server, decryptSshKey());
    await dockerExecWgRemovePeer(
      auth,
      server.docker_wg_container,
      server.wg_interface,
      publicKey,
    );
  },
};
