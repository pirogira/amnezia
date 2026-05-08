import {
  dockerDetectIfaceSlash24Prefix,
  dockerResolveWgExe,
  dockerResolveWgIface,
  execRemote,
  SAFE_CONTAINER,
  shellQuote,
} from "./client.js";
import type { SshAuth } from "./client.js";

export type WgDockerDiscoveryOk = {
  ok: true;
  dockerWgContainer: string;
  wgInterface: string;
  listenPort: number;
  /** Подсеть /24 с интерфейса в контейнере, иначе null — оставьте поле в форме как есть. */
  vpnSubnetCidr: string | null;
  image: string;
};

export type WgDockerDiscoveryErr = {
  ok: false;
  message: string;
  triedContainers: string[];
};

export type WgDockerDiscoveryResult = WgDockerDiscoveryOk | WgDockerDiscoveryErr;

type Row = { name: string; image: string; score: number };

function scoreContainer(name: string, image: string): number {
  const n = name.toLowerCase();
  const i = image.toLowerCase();
  let s = 0;
  if (/amnezia|awg/.test(n)) s += 20;
  if (/amnezia|awg/.test(i)) s += 15;
  if (/wireguard|wg-quick|awg-quick/.test(i)) s += 8;
  if (/\bwg\b/.test(n) || /wireguard/.test(n)) s += 5;
  return s;
}

function parseListeningPort(showDump: string): number | null {
  const head = showDump.split(/\npeer:/i)[0] ?? showDump;
  const m = /listening port:\s*(\d+)/i.exec(head);
  if (!m) return null;
  const p = Number(m[1]);
  return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
}

/**
 * Парсит вывод `docker port CONTAINER`: ищет опубликованный UDP-порт на хосте для containerUdpPort внутри контейнера.
 */
function parseHostUdpPortFromDockerPort(stdout: string, containerUdpPort: number): number | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const m = /^(\d+)\/udp\s*->\s*.+:(\d+)\s*$/.exec(line);
    if (!m) continue;
    const inner = Number(m[1]);
    const host = Number(m[2]);
    if (inner === containerUdpPort && Number.isInteger(host) && host > 0) return host;
  }
  return null;
}

export async function discoverWgDockerOnHost(auth: SshAuth): Promise<WgDockerDiscoveryResult> {
  const tried: string[] = [];
  const r = await execRemote(auth, "docker ps -a --format '{{.Names}}\t{{.Image}}'");
  if (r.code !== 0) {
    return { ok: false, message: `docker ps: ${r.stderr || r.stdout}`.trim(), triedContainers: tried };
  }

  const rows: Row[] = [];
  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const tab = t.indexOf("\t");
    if (tab < 0) continue;
    const name = t.slice(0, tab).trim();
    const image = t.slice(tab + 1).trim();
    if (!SAFE_CONTAINER.test(name)) continue;
    rows.push({ name, image, score: scoreContainer(name, image) });
  }

  rows.sort((a, b) => b.score - a.score);

  for (const row of rows) {
    tried.push(row.name);

    let iface: string;
    try {
      iface = await dockerResolveWgIface(auth, row.name, "wg0");
    } catch {
      continue;
    }

    let exe: string;
    try {
      exe = await dockerResolveWgExe(auth, row.name, iface);
    } catch {
      exe = "wg";
    }

    const showR = await execRemote(
      auth,
      `docker exec ${shellQuote(row.name)} ${shellQuote(exe)} show ${shellQuote(iface)}`,
    );
    if (showR.code !== 0) continue;

    const innerPort = parseListeningPort(showR.stdout);
    if (innerPort == null) continue;

    const portOut = await execRemote(auth, `docker port ${shellQuote(row.name)}`);
    const hostPort =
      portOut.code === 0 && portOut.stdout.trim().length > 0
        ? parseHostUdpPortFromDockerPort(portOut.stdout, innerPort)
        : null;
    const listenPort = hostPort ?? innerPort;

    const prefix = await dockerDetectIfaceSlash24Prefix(auth, row.name, iface);
    const vpnSubnetCidr = prefix ? `${prefix}.0/24` : null;

    return {
      ok: true,
      dockerWgContainer: row.name,
      wgInterface: iface,
      listenPort,
      vpnSubnetCidr,
      image: row.image,
    };
  }

  return {
    ok: false,
    message:
      tried.length === 0
        ? "Нет подходящих контейнеров (docker ps пуст или имена не проходят проверку безопасности)."
        : "Не найден контейнер с рабочим WireGuard/AmneziaWG (docker exec … wg/awg show). Проверьте, что VPN-контейнер запущен.",
    triedContainers: tried,
  };
}
