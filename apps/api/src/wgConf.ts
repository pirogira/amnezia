import type { SecurityProfile } from "@amnesia-veb/shared";

export function buildClientConf(params: {
  clientPrivateKey: string;
  assignedIp: string;
  serverPublicKey: string;
  endpoint: string;
  listenPort: number;
  security: SecurityProfile;
}): string {
  const dnsLine = params.security.dns
    ? `DNS = ${params.security.dns}\n`
    : "";
  const psk = params.security.presharedKey
    ? `PresharedKey = ${params.security.presharedKey}\n`
    : "";
  const junkLines = formatJunkComments(params.security);
  return `[Interface]
PrivateKey = ${params.clientPrivateKey}
Address = ${params.assignedIp}/32
${dnsLine}${junkLines}[Peer]
PublicKey = ${params.serverPublicKey}
${psk}AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = ${params.endpoint}:${params.listenPort}
PersistentKeepalive = 25
`;
}

function formatJunkComments(s: SecurityProfile): string {
  const parts: string[] = [];
  if (s.junkPacketCount != null) parts.push(`# junk_packet_count = ${s.junkPacketCount}`);
  if (s.junkPacketMinSize != null) parts.push(`# junk_packet_min_size = ${s.junkPacketMinSize}`);
  if (s.junkPacketMaxSize != null) parts.push(`# junk_packet_max_size = ${s.junkPacketMaxSize}`);
  if (s.initPacketJunkSize != null) parts.push(`# init_packet_junk_size = ${s.initPacketJunkSize}`);
  if (s.responsePacketJunkSize != null) parts.push(`# response_packet_junk_size = ${s.responsePacketJunkSize}`);
  if (!parts.length) return "";
  return parts.join("\n") + "\n";
}

export function parseSubnetLastOctets(cidr: string): { prefix: string; maxHost: number } {
  const m = /^(\d+\.\d+\.\d+)\.(\d+)\/(\d+)$/.exec(cidr.trim());
  if (!m) throw new Error("invalid CIDR");
  const bits = Number(m[3]);
  if (bits !== 24) throw new Error("only /24 subnets supported in MVP");
  return { prefix: m[1], maxHost: 254 };
}

export function hostIpFromOctet(prefix: string, octet: number): string {
  if (octet < 2 || octet > 254) throw new Error("octet out of range");
  return `${prefix}.${octet}`;
}
