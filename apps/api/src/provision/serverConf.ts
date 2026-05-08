import { formatAwgInterfaceLines, hostIpFromOctet, parseSubnetLastOctets } from "../wgConf.js";

export function buildAwg0ServerConf(params: {
  serverPrivateKey: string;
  vpnSubnetCidr: string;
  listenPort: number;
  awgParams: Record<string, string>;
  /**
   * Без PostUp клиенты устанавливают WG, но трафик в интернет не NATится.
   * Раньше использовали `-o eth0` — в Docker часто нет `eth0`. MASQUERADE по `-s VPN/24`
   * не требует имени внешнего интерфейса.
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
      : `PostUp = iptables -A FORWARD -i awg0 -j ACCEPT; iptables -A FORWARD -o awg0 -j ACCEPT; iptables -t nat -A POSTROUTING -s ${subnet24} -j MASQUERADE
PostDown = iptables -D FORWARD -i awg0 -j ACCEPT; iptables -D FORWARD -o awg0 -j ACCEPT; iptables -t nat -D POSTROUTING -s ${subnet24} -j MASQUERADE
`;
  return `[Interface]
PrivateKey = ${params.serverPrivateKey}
Address = ${serverIp}/24
ListenPort = ${params.listenPort}
MTU = 1280
${awgBlock}${nat}`;
}
