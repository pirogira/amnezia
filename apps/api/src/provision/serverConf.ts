import { formatAwgInterfaceLines, hostIpFromOctet, parseSubnetLastOctets } from "../wgConf.js";
import { PANEL_WG_NAT_SCRIPT_BASENAME } from "./panelNatScript.js";

export function buildAwg0ServerConf(params: {
  serverPrivateKey: string;
  vpnSubnetCidr: string;
  listenPort: number;
  awgParams: Record<string, string>;
  /**
   * Без PostUp клиенты устанавливают WG, но трафик в интернет не NATится.
   * Скрипт `panel-nat.sh`: `-I FORWARD 1` / `-I POSTROUTING 1` (UFW), выбор iptables-legacy,
   * `%i` = имя интерфейса, rp_filter на туннеле.
   */
  omitPostUp?: boolean;
}): string {
  const { prefix } = parseSubnetLastOctets(params.vpnSubnetCidr);
  const serverIp = hostIpFromOctet(prefix, 1);
  const awgBlock = formatAwgInterfaceLines(params.awgParams);
  const subnet24 = `${prefix}.0/24`;
  const nat =
    params.omitPostUp === true
      ? ""
      : `PostUp = /bin/sh /etc/wireguard/${PANEL_WG_NAT_SCRIPT_BASENAME} up %i ${subnet24}
PostDown = /bin/sh /etc/wireguard/${PANEL_WG_NAT_SCRIPT_BASENAME} down %i ${subnet24}
`;
  return `[Interface]
PrivateKey = ${params.serverPrivateKey}
Address = ${serverIp}/24
ListenPort = ${params.listenPort}
MTU = 1280
${awgBlock}${nat}`;
}
