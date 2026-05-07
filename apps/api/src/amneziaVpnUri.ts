import zlib from "node:zlib";
import { AWG_CONF_LINE_ORDER } from "./wgConf.js";

/** Как в экспорте официального клиента Amnezia (объект `awg` и `last_config`). */
const AWG_JSON_PARAM_ORDER = [
  "H1",
  "H2",
  "H3",
  "H4",
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "Jc",
  "Jmax",
  "Jmin",
  "S1",
  "S2",
  "S3",
  "S4",
] as const;

export type ParsedPanelWgConf = {
  privateKey: string;
  address: string;
  peerPublicKey: string;
  presharedKey: string;
  endpoint: string;
  awgNative: Record<string, string>;
};

const AWG_KEYS = new Set<string>(AWG_CONF_LINE_ORDER as unknown as string[]);

/** Разбор .conf, который собирает панель (Interface / Peer, опционально строки AmneziaWG). */
export function parseWireGuardConfFromPanel(conf: string): ParsedPanelWgConf {
  let section: "none" | "interface" | "peer" = "none";
  let privateKey = "";
  let address = "";
  let peerPublicKey = "";
  let presharedKey = "";
  let endpoint = "";
  const awgNative: Record<string, string> = {};

  for (const rawLine of conf.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[Interface]") {
      section = "interface";
      continue;
    }
    if (line === "[Peer]") {
      section = "peer";
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (section === "interface") {
      if (k === "PrivateKey") privateKey = v;
      else if (k === "Address") address = v;
      else if (AWG_KEYS.has(k)) awgNative[k] = v;
    } else if (section === "peer") {
      if (k === "PublicKey") peerPublicKey = v;
      else if (k === "PresharedKey") presharedKey = v;
      else if (k === "Endpoint") endpoint = v;
    }
  }

  if (!privateKey || !address || !peerPublicKey || !endpoint) {
    throw new Error("incomplete wireguard conf for Amnezia export");
  }

  return { privateKey, address, peerPublicKey, presharedKey, endpoint, awgNative };
}

function subnetBaseFromServerCidr(cidr: string): string {
  const m = /^(\d+\.\d+\.\d+)\.\d+\/\d+$/.exec(cidr.trim());
  if (!m) throw new Error("only /24 style CIDR supported for Amnezia vpn://");
  return `${m[1]}.0`;
}

function awgFlatFromParsed(parsed: ParsedPanelWgConf): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of AWG_JSON_PARAM_ORDER) {
    out[k] = parsed.awgNative[k] ?? "";
  }
  return out;
}

function buildExportConfigText(
  parsed: ParsedPanelWgConf,
  awgFlat: Record<string, string>,
): string {
  const lines: string[] = [
    "[Interface]",
    `Address = ${parsed.address}`,
    "DNS = $PRIMARY_DNS, $SECONDARY_DNS",
    `PrivateKey = ${parsed.privateKey}`,
  ];
  for (const k of AWG_CONF_LINE_ORDER) {
    const v = awgFlat[k] ?? "";
    lines.push(`${k} = ${v}`);
  }
  lines.push("", "[Peer]", `PublicKey = ${parsed.peerPublicKey}`);
  if (parsed.presharedKey.length > 0) {
    lines.push(`PresharedKey = ${parsed.presharedKey}`);
  }
  lines.push(
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `Endpoint = ${parsed.endpoint}`,
    "PersistentKeepalive = 25",
    "",
  );
  return lines.join("\n");
}

export type AmneziaAwgVpnRootInput = {
  serverName: string;
  hostName: string;
  dns1: string;
  dns2: string;
  dockerContainer: string;
  listenPort: number;
  vpnSubnetCidr: string;
  clientPublicKey: string;
  clientConfPlain: string;
};

/** Корневой JSON как у официального Amnezia-клиента (импорт по `vpn://…`). */
export function buildAmneziaAwgVpnRoot(input: AmneziaAwgVpnRootInput): Record<string, unknown> {
  const parsed = parseWireGuardConfFromPanel(input.clientConfPlain);
  const awgFlat = awgFlatFromParsed(parsed);
  const addrHost = parsed.address.replace(/\/\d+$/, "");
  const configStr = buildExportConfigText(parsed, awgFlat);
  const port = input.listenPort;
  const inner: Record<string, unknown> = {};
  for (const k of AWG_JSON_PARAM_ORDER) {
    inner[k] = awgFlat[k] ?? "";
  }
  inner.allowed_ips = ["0.0.0.0/0", "::/0"];
  inner.clientId = input.clientPublicKey;
  inner.client_ip = addrHost;
  inner.client_priv_key = parsed.privateKey;
  inner.client_pub_key = input.clientPublicKey;
  inner.config = configStr;
  inner.hostName = input.hostName;
  inner.mtu = "1376";
  inner.persistent_keep_alive = "25";
  inner.port = port;
  inner.psk_key = parsed.presharedKey;
  inner.server_pub_key = parsed.peerPublicKey;
  const lastConfig = JSON.stringify(inner, null, 4);
  const awgTop: Record<string, unknown> = {};
  for (const k of AWG_JSON_PARAM_ORDER) {
    awgTop[k] = awgFlat[k] ?? "";
  }
  awgTop.last_config = lastConfig;
  awgTop.port = String(port);
  awgTop.protocol_version = "2";
  awgTop.subnet_address = subnetBaseFromServerCidr(input.vpnSubnetCidr);
  awgTop.transport_proto = "udp";
  return {
    containers: [{ awg: awgTop, container: input.dockerContainer }],
    defaultContainer: input.dockerContainer,
    description: input.serverName,
    dns1: input.dns1,
    dns2: input.dns2,
    hostName: input.hostName,
  };
}

export function encodeVpnUri(config: unknown): string {
  const jsonStr = JSON.stringify(config, null, 4);
  const jsonBytes = Buffer.from(jsonStr, "utf8");
  const compressed = zlib.deflateSync(jsonBytes);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(jsonBytes.length, 0);
  const payload = Buffer.concat([header, compressed]);
  return `vpn://${payload.toString("base64url").replace(/=+$/, "")}`;
}

export function buildAmneziaVpnUriForAwgClient(
  serverName: string,
  server: {
    endpoint_host: string;
    docker_wg_container: string;
    vpn_subnet_cidr: string;
  },
  listenPort: number,
  clientPublicKey: string,
  clientConfPlain: string,
  securityDns?: string,
): string {
  const dns1 = securityDns?.split(",")[0]?.trim() || "1.1.1.1";
  const dns2 = securityDns?.split(",")[1]?.trim() || "1.0.0.1";
  const root = buildAmneziaAwgVpnRoot({
    serverName,
    hostName: server.endpoint_host,
    dns1,
    dns2,
    dockerContainer: server.docker_wg_container,
    listenPort,
    vpnSubnetCidr: server.vpn_subnet_cidr,
    clientPublicKey,
    clientConfPlain,
  });
  return encodeVpnUri(root);
}
