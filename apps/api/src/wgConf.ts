import type { SecurityProfile } from "@amnesia-veb/shared";

/** Ключи из `wg show` (нижний регистр) → имена в .conf AmneziaWG. */
const AWG_WGSHOW_TO_CONF: Record<string, string> = {
  jc: "Jc",
  jmin: "Jmin",
  jmax: "Jmax",
  s1: "S1",
  s2: "S2",
  s3: "S3",
  s4: "S4",
  h1: "H1",
  h2: "H2",
  h3: "H3",
  h4: "H4",
  i1: "I1",
  i2: "I2",
  i3: "I3",
  i4: "I4",
  i5: "I5",
};

/** Убрать ANSI из `wg show` (в TTY ключи вроде `jc` идут с bold — иначе парсер не находит поля). */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Порядок строк AmneziaWG в .conf и в `vpn://` JSON. */
export const AWG_CONF_LINE_ORDER = [
  "Jc",
  "Jmin",
  "Jmax",
  "S1",
  "S2",
  "S3",
  "S4",
  "H1",
  "H2",
  "H3",
  "H4",
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
] as const;

/**
 * Парсит блок интерфейса из `wg show` (до первого peer:) — значения для «родного» AmneziaWG .conf.
 */
export function parseAwgParamsFromWgShow(dump: string): Record<string, string> {
  const peerIdx = dump.search(/\npeer:/i);
  const head = peerIdx >= 0 ? dump.slice(0, peerIdx) : dump;
  const headClean = stripAnsi(head);
  const out: Record<string, string> = {};
  for (const line of headClean.split("\n")) {
    const m = /^\s*([^:=]+)[:=]\s*(.+)$/.exec(line);
    if (!m) continue;
    const raw = m[1].trim().toLowerCase().replace(/\s+/g, "");
    const confKey = AWG_WGSHOW_TO_CONF[raw];
    if (!confKey) continue;
    out[confKey] = m[2].trim();
  }
  return out;
}

/**
 * Первая строка `wg show IFACE dump` (amneziawg-tools): табы, без ANSI; s3/s4 есть всегда.
 * Колонки 0–2: private, public, listen_port; 3–18: Jc…I5; 19: fwmark.
 */
export function parseAwgParamsFromWgShowMachineDump(text: string): Record<string, string> {
  const firstLine = (text.split(/\r?\n/)[0] ?? "").trim();
  if (!firstLine.includes("\t")) return {};
  const cols = firstLine.split("\t");
  const start = 3;
  if (cols.length < start + AWG_CONF_LINE_ORDER.length) return {};
  const out: Record<string, string> = {};
  for (let i = 0; i < AWG_CONF_LINE_ORDER.length; i++) {
    const k = AWG_CONF_LINE_ORDER[i];
    const v = (cols[start + i] ?? "").trim();
    if (v.length === 0 || v === "(null)") continue;
    out[k] = v;
  }
  return out;
}

/** Парсит только строки AmneziaWG из секции `[Interface]` серверного `.conf`. */
export function parseAwgInterfaceParamsFromWgConf(conf: string): Record<string, string> {
  let section: "none" | "interface" = "none";
  const out: Record<string, string> = {};
  const order = AWG_CONF_LINE_ORDER as readonly string[];
  for (const rawLine of conf.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[Interface]") {
      section = "interface";
      continue;
    }
    if (line.startsWith("[")) {
      section = "none";
      continue;
    }
    if (section !== "interface") continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (order.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * UAPI/`wg show` часто не выводит все поля (например S3/S4), а без них клиент ≠ сервер → нет трафика и «Legacy» в приложении.
 * Берём значение из дампа, если оно непустое, иначе — из серверного awg0.conf.
 */
export function mergeAwgDumpWithServerConf(
  fromDump: Record<string, string>,
  fromConfFile: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const k of AWG_CONF_LINE_ORDER) {
    const d = (fromDump[k] ?? "").trim();
    const f = (fromConfFile[k] ?? "").trim();
    /** UAPI может отдать 0, в .conf на сервере — реальные S3/S4; иначе клиент ≠ сервер. */
    if (d.length > 0 && !(d === "0" && f.length > 0 && f !== "0")) merged[k] = d;
    else merged[k] = f;
  }
  for (const [k, v] of Object.entries(fromDump)) {
    if ((AWG_CONF_LINE_ORDER as readonly string[]).includes(k)) continue;
    const t = v.trim();
    if (t.length > 0) merged[k] = t;
  }
  return merged;
}

export function formatAwgInterfaceLines(params: Record<string, string>): string {
  const lines: string[] = [];
  for (const k of AWG_CONF_LINE_ORDER) {
    const v = params[k];
    if (v !== undefined && v.length > 0) lines.push(`${k} = ${v}`);
  }
  for (const [k, v] of Object.entries(params)) {
    if ((AWG_CONF_LINE_ORDER as readonly string[]).includes(k)) continue;
    if (v.length > 0) lines.push(`${k} = ${v}`);
  }
  if (!lines.length) return "";
  return `${lines.join("\n")}\n`;
}

export function buildClientConf(params: {
  clientPrivateKey: string;
  assignedIp: string;
  serverPublicKey: string;
  endpoint: string;
  listenPort: number;
  security: SecurityProfile;
  /** Параметры AmneziaWG с сервера (`wg show`); только для протокола amneziawg. */
  awgNativeParams?: Record<string, string>;
  /** Для amneziawg подставляем MTU даже если с сервера не пришли Jc/Jmin… в дампе. */
  protocol?: "wireguard" | "amneziawg";
}): string {
  /** При AllowedIPs 0.0.0.0/0 без DNS ОС часто не шлёт запросы резолвингу через туннель — в браузере «не удаётся найти адрес». */
  const dnsRaw = params.security.dns?.trim();
  const dnsLine = `DNS = ${dnsRaw && dnsRaw.length > 0 ? dnsRaw : "1.1.1.1, 1.0.0.1"}\n`;
  const psk = params.security.presharedKey
    ? `PresharedKey = ${params.security.presharedKey}\n`
    : "";
  const native = Boolean(params.awgNativeParams && Object.keys(params.awgNativeParams).length > 0);
  const junkLines = native ? "" : formatJunkComments(params.security);
  const awgLines = native && params.awgNativeParams ? formatAwgInterfaceLines(params.awgNativeParams) : "";
  /** Только IPv4: иначе при ::/0 весь IPv6 идёт в WG без v6-NAT на сервере — «подключено», но интернет «мёртвый». */
  const allowedIps =
    params.security.includeIpv6DefaultRoute === true ? "0.0.0.0/0, ::/0" : "0.0.0.0/0";
  const mtuLine =
    params.security.mtu != null && params.security.mtu > 0
      ? `MTU = ${params.security.mtu}\n`
      : native || params.protocol === "amneziawg"
        ? "MTU = 1280\n"
        : "";
  return `[Interface]
PrivateKey = ${params.clientPrivateKey}
Address = ${params.assignedIp}/32
${mtuLine}${dnsLine}${junkLines}${awgLines}[Peer]
PublicKey = ${params.serverPublicKey}
${psk}AllowedIPs = ${allowedIps}
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

/** Октет хоста в /24: 1 — шлюз VPN (сервер), 2–254 — клиенты и прочие хосты. */
export function hostIpFromOctet(prefix: string, octet: number): string {
  if (octet < 1 || octet > 254) throw new Error("octet out of range");
  return `${prefix}.${octet}`;
}
