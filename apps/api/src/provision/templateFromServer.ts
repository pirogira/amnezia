import type { ServerRow } from "../drivers/types.js";
import { execRemote, shellQuote } from "../ssh/client.js";
import { buildSshAuthFromServer } from "../ssh/buildAuth.js";
import { discoverComposeOnReferenceServer } from "./discoverHostLayout.js";
import { normalizeProvisionComposeYaml } from "./dockerImage.js";
import { PROVISION_AWG_DIR, PROVISION_COMPOSE_PATH, PROVISION_CONTAINER_NAME } from "./compose.js";
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
  const { composePath, composeYaml: rawCompose, awgDir } = await discoverComposeOnReferenceServer(reference);
  const containerHint = reference.docker_wg_container?.trim() || undefined;
  const composeYaml = normalizeProvisionComposeYaml(rawCompose, { containerName: containerHint });
  /** На целевом VPS — стандартные пути/имя контейнера панели, не копия имени с образца (amnezia-awg2). */
  const layout = parseAwgLayoutFromCompose(composeYaml, {
    composePath: PROVISION_COMPOSE_PATH,
    containerName: PROVISION_CONTAINER_NAME,
    awgDir: PROVISION_AWG_DIR,
    composeServiceName: PROVISION_CONTAINER_NAME,
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
