import type { ServerRow } from "../drivers/types.js";
import { buildSshAuthFromServer } from "./buildAuth.js";
import {
  dockerContainerExists,
  dockerDetectIfaceSlash24Prefix,
  dockerResolveWgIface,
} from "./client.js";

/** Подсеть `a.b.c.0/24` с реального awg/wg в Docker; null если не удалось (нет `ip`, /32 и т.д.). */
export async function sshDetectVpnSubnetCidr(server: ServerRow): Promise<string | null> {
  if (server.driver_mode !== "ssh") return null;
  try {
    const auth = buildSshAuthFromServer(server);
    const ok = await dockerContainerExists(auth, server.docker_wg_container);
    if (!ok) return null;
    const iface = await dockerResolveWgIface(auth, server.docker_wg_container, server.wg_interface);
    const prefix = await dockerDetectIfaceSlash24Prefix(auth, server.docker_wg_container, iface);
    if (!prefix) return null;
    return `${prefix}.0/24`;
  } catch {
    return null;
  }
}
