import { formatAwgInterfaceLines, hostIpFromOctet, parseSubnetLastOctets } from "../wgConf.js";

export function buildAwg0ServerConf(params: {
  serverPrivateKey: string;
  vpnSubnetCidr: string;
  listenPort: number;
  awgParams: Record<string, string>;
  /**
   * Без PostUp клиенты устанавливают WG, но трафик в интернет не NATится.
   * `-I FORWARD 1` / `-I POSTROUTING 1`: при UFW политика FORWARD часто DROP, а `-A` в конец
   * цепочки не спасает — пакеты не доходят до наших ACCEPT. MASQUERADE по `-s VPN/24` без `-o`.
   * rp_filter=0 на awg0 снимает обрыв форварда на VPS со strict reverse-path.
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
      : `PostUp = sysctl -w net.ipv4.conf.awg0.rp_filter=0 2>/dev/null || true; iptables -I FORWARD 1 -i awg0 -j ACCEPT; iptables -I FORWARD 1 -o awg0 -j ACCEPT; iptables -t nat -I POSTROUTING 1 -s ${subnet24} ! -d ${subnet24} -j MASQUERADE
PostDown = iptables -t nat -D POSTROUTING -s ${subnet24} ! -d ${subnet24} -j MASQUERADE; iptables -D FORWARD -o awg0 -j ACCEPT; iptables -D FORWARD -i awg0 -j ACCEPT; sysctl -w net.ipv4.conf.awg0.rp_filter=2 2>/dev/null || true
`;
  return `[Interface]
PrivateKey = ${params.serverPrivateKey}
Address = ${serverIp}/24
ListenPort = ${params.listenPort}
MTU = 1280
${awgBlock}${nat}`;
}
