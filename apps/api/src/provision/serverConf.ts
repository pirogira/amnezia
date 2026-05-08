import { formatAwgInterfaceLines, hostIpFromOctet, parseSubnetLastOctets } from "../wgConf.js";

export function buildAwg0ServerConf(params: {
  serverPrivateKey: string;
  vpnSubnetCidr: string;
  listenPort: number;
  awgParams: Record<string, string>;
}): string {
  const { prefix } = parseSubnetLastOctets(params.vpnSubnetCidr);
  const serverIp = hostIpFromOctet(prefix, 1);
  const awgBlock = formatAwgInterfaceLines(params.awgParams);
  return `[Interface]
PrivateKey = ${params.serverPrivateKey}
Address = ${serverIp}/24
ListenPort = ${params.listenPort}
MTU = 1280
${awgBlock}
PostUp = iptables -A FORWARD -i awg0 -j ACCEPT; iptables -A FORWARD -o awg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
PostDown = iptables -D FORWARD -i awg0 -j ACCEPT; iptables -D FORWARD -o awg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o eth0 -j MASQUERADE
`;
}
