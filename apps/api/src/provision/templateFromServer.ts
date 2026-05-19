import type { ServerRow } from "../drivers/types.js";
import { execRemote, shellQuote } from "../ssh/client.js";
import { buildSshAuthFromServer } from "../ssh/buildAuth.js";
import { discoverComposeOnReferenceServer } from "./discoverHostLayout.js";
import { type AwgHostLayout, parseAwgLayoutFromCompose } from "./layout.js";
import { buildPanelWgNatScript } from "./panelNatScript.js";
import { PANEL_WG_NAT_SCRIPT_BASENAME } from "./panelNatScript.js";

export type AwgDeployBundle = {
  composeYaml: string;
  natScript: string;
  layout: AwgHostLayout;
  /** Порт и подсеть с образца (можно переопределить при провижне). */
  referenceListenPort: number;
  referenceVpnSubnetCidr: string;
};

/**
 * Считывает с уже работающего сервера в панели: docker-compose, panel-nat.sh, пути.
 * Ключи awg0.conf **не** копируются — на новом VPS генерируются заново.
 */
export async function fetchAwgDeployBundleFromServer(reference: ServerRow): Promise<AwgDeployBundle> {
  const auth = buildSshAuthFromServer(reference);
  const { composePath, composeYaml, awgDir } = await discoverComposeOnReferenceServer(reference);
  const layout = parseAwgLayoutFromCompose(composeYaml, {
    composePath,
    containerName: reference.docker_wg_container?.trim() || undefined,
    awgDir,
    composeServiceName: reference.compose_service_name?.trim() || undefined,
  });

  const natPath = `${layout.awgDir}/${PANEL_WG_NAT_SCRIPT_BASENAME}`;
  const natR = await execRemote(auth, `cat ${shellQuote(natPath)}`);
  const natScript =
    natR.code === 0 && natR.stdout.trim().length > 0 ? natR.stdout : buildPanelWgNatScript();

  return {
    composeYaml,
    natScript,
    layout,
    referenceListenPort: reference.listen_port,
    referenceVpnSubnetCidr: reference.vpn_subnet_cidr,
  };
}
