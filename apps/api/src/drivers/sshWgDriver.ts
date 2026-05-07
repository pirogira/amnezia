import type { CreateClientRequest } from "@amnesia-veb/shared";
import {
  dockerContainerExists,
  dockerExecWgGenkey,
  dockerExecWgPubkey,
  dockerExecWgRemovePeer,
  dockerExecWgSetPeer,
  dockerExecWgShowPublicKey,
  dockerResolveWgIface,
} from "../ssh/client.js";
import { buildSshAuthFromServer } from "../ssh/buildAuth.js";
import { buildClientConf, hostIpFromOctet, parseSubnetLastOctets } from "../wgConf.js";
import type { ServerRow, VpnDriver } from "./types.js";

export const sshWgDriver: VpnDriver = {
  async createClient(server, body: CreateClientRequest, _decryptSshKey, nextIpOctet) {
    if (body.protocol !== "wireguard" && body.protocol !== "amneziawg") {
      throw new Error("SSH driver supports wireguard/amneziawg only in MVP");
    }
    const auth = buildSshAuthFromServer(server);
    const ok = await dockerContainerExists(auth, server.docker_wg_container);
    if (!ok) throw new Error(`docker container not found: ${server.docker_wg_container}`);

    const iface = await dockerResolveWgIface(auth, server.docker_wg_container, server.wg_interface);

    const clientPriv = await dockerExecWgGenkey(auth, server.docker_wg_container);
    const clientPub = await dockerExecWgPubkey(auth, server.docker_wg_container, clientPriv);
    const serverPub = await dockerExecWgShowPublicKey(auth, server.docker_wg_container, iface);

    const { prefix } = parseSubnetLastOctets(server.vpn_subnet_cidr);
    const assignedIp = hostIpFromOctet(prefix, nextIpOctet);
    const allowed = `${assignedIp}/32`;

    await dockerExecWgSetPeer(auth, server.docker_wg_container, iface, clientPub, allowed);

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

  async revokeClient(server, publicKey, _decryptSshKey) {
    const auth = buildSshAuthFromServer(server);
    const iface = await dockerResolveWgIface(auth, server.docker_wg_container, server.wg_interface);
    await dockerExecWgRemovePeer(auth, server.docker_wg_container, iface, publicKey);
  },
};
