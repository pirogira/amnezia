import type { CreateClientRequest } from "@amnesia-veb/shared";
import {
  dockerContainerExists,
  dockerExecWgGenkey,
  dockerExecWgGenpsk,
  dockerExecWgPubkey,
  dockerExecWgRemovePeer,
  dockerExecWgSetPeer,
  dockerExecWgShowDump,
  dockerExecWgShowPublicKey,
  dockerResolveWgExe,
  dockerResolveWgIface,
} from "../ssh/client.js";
import { buildSshAuthFromServer } from "../ssh/buildAuth.js";
import {
  buildClientConf,
  hostIpFromOctet,
  parseAwgParamsFromWgShow,
  parseSubnetLastOctets,
} from "../wgConf.js";
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
    const wgExe = await dockerResolveWgExe(auth, server.docker_wg_container, iface);

    const clientPriv = await dockerExecWgGenkey(auth, server.docker_wg_container, wgExe);
    const clientPub = await dockerExecWgPubkey(auth, server.docker_wg_container, clientPriv, wgExe);
    const serverPub = await dockerExecWgShowPublicKey(auth, server.docker_wg_container, iface, wgExe);

    const { prefix } = parseSubnetLastOctets(server.vpn_subnet_cidr);
    const assignedIp = hostIpFromOctet(prefix, nextIpOctet);
    const allowed = `${assignedIp}/32`;

    /** AmneziaWG / многие инсталляции ждут PSK в .conf; без него клиент импортируется, но туннель не поднимается. */
    const psk = await dockerExecWgGenpsk(auth, server.docker_wg_container, wgExe);
    await dockerExecWgSetPeer(auth, server.docker_wg_container, iface, clientPub, allowed, psk, wgExe);

    let awgNative: Record<string, string> | undefined;
    if (body.protocol === "amneziawg") {
      const dump = await dockerExecWgShowDump(auth, server.docker_wg_container, iface, wgExe);
      const parsed = parseAwgParamsFromWgShow(dump);
      if (Object.keys(parsed).length > 0) awgNative = parsed;
    }

    const conf = buildClientConf({
      clientPrivateKey: clientPriv.trim(),
      assignedIp,
      serverPublicKey: serverPub.trim(),
      endpoint: server.endpoint_host,
      listenPort: body.listenPort,
      security: { ...body.security, presharedKey: psk },
      awgNativeParams: awgNative,
      protocol: body.protocol,
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
    const wgExe = await dockerResolveWgExe(auth, server.docker_wg_container, iface);
    await dockerExecWgRemovePeer(auth, server.docker_wg_container, iface, publicKey, wgExe);
  },
};
