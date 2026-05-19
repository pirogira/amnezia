import { readFileSync } from "node:fs";
import { getDb } from "../db.js";
import type { ServerRow } from "../drivers/types.js";
import { buildSshAuthFromServer } from "../ssh/buildAuth.js";
import { execRemote, shellQuote, type SshAuth } from "../ssh/client.js";
import { config } from "../config.js";

export type HostStatsSnapshot = {
  cpuPercent: number;
  cpuCores: number;
  memUsedBytes: number;
  memTotalBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskMount: string;
};

/** Скрипт на Linux: один JSON в stdout. */
const REMOTE_STATS_SCRIPT = `set -eu
cores=$(nproc 2>/dev/null || echo 1)
read -r _ u1 n1 s1 id1 iw1 irq1 si1 st1 _ < /proc/stat
sleep 1
read -r _ u2 n2 s2 id2 iw2 irq2 si2 st2 _ < /proc/stat
dt=$((u2-u1+n2-n1+s2-s1+id2-id1+iw2-iw1+irq2-irq1+si2-si1+st2-st1))
did=$((id2-id1))
cpu=0
if [ "$dt" -gt 0 ]; then cpu=$(awk -v t="$dt" -v i="$did" 'BEGIN{printf "%.2f", (1-i/t)*100}'); fi
mt=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
ma=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
st=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
sf=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
du=$(df -B1 --output=used / 2>/dev/null | tail -1 | tr -d ' ')
dt=$(df -B1 --output=size / 2>/dev/null | tail -1 | tr -d ' ')
printf '{"cpuPercent":%s,"cpuCores":%s,"memUsedBytes":%s,"memTotalBytes":%s,"swapUsedBytes":%s,"swapTotalBytes":%s,"diskUsedBytes":%s,"diskTotalBytes":%s,"diskMount":"/"}\\n' \\
  "$cpu" "$cores" "$(( (mt-ma)*1024 ))" "$(( mt*1024 ))" "$(( (st-sf)*1024 ))" "$(( st*1024 ))" "$du" "$dt"
`;

function panelHostSshAuth(): SshAuth | null {
  const h = config.panelHostSsh;
  if (!h.host) return null;
  const privateKey = h.privateKeyPath
    ? readFileSync(h.privateKeyPath, "utf8").trim()
    : h.privateKey.trim();
  const password = h.password.trim();
  if (!privateKey && !password) return null;
  if (password) {
    return { host: h.host, port: h.port, username: h.user, password };
  }
  return { host: h.host, port: h.port, username: h.user, privateKey };
}

export function resolvePanelHostStatsAuth(): SshAuth | null {
  const direct = panelHostSshAuth();
  if (direct) return direct;
  const id = config.panelStatsServerId;
  if (id) {
    const row = getDb().prepare(`SELECT * FROM vpn_servers WHERE id = ?`).get(id) as ServerRow | undefined;
    if (row) {
      try {
        return buildSshAuthFromServer(row);
      } catch {
        /* fall through */
      }
    }
  }
  /** Если панель на том же VPS, что и первый сервер в списке — метрики хоста без отдельного .env. */
  const first = getDb()
    .prepare(`SELECT * FROM vpn_servers ORDER BY created_at ASC LIMIT 1`)
    .get() as ServerRow | undefined;
  if (!first) return null;
  try {
    return buildSshAuthFromServer(first);
  } catch {
    return null;
  }
}

export async function fetchHostStatsViaSsh(auth: SshAuth): Promise<HostStatsSnapshot> {
  const r = await execRemote(auth, `bash -lc ${shellQuote(REMOTE_STATS_SCRIPT)}`);
  if (r.code !== 0) {
    throw new Error((r.stderr || r.stdout || "stats script failed").trim().slice(0, 400));
  }
  const line = r.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) throw new Error("Пустой ответ скрипта метрик");
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Невалидный JSON метрик: ${line.slice(0, 120)}`);
  }
  return normalizeStats(raw);
}

export async function fetchServerHostStats(server: ServerRow): Promise<HostStatsSnapshot> {
  const auth = buildSshAuthFromServer(server);
  return fetchHostStatsViaSsh(auth);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normalizeStats(raw: unknown): HostStatsSnapshot {
  const o = raw as Record<string, unknown>;
  return {
    cpuPercent: Math.min(100, Math.max(0, num(o.cpuPercent))),
    cpuCores: Math.max(1, Math.floor(num(o.cpuCores))),
    memUsedBytes: Math.max(0, num(o.memUsedBytes)),
    memTotalBytes: Math.max(0, num(o.memTotalBytes)),
    swapUsedBytes: Math.max(0, num(o.swapUsedBytes)),
    swapTotalBytes: Math.max(0, num(o.swapTotalBytes)),
    diskUsedBytes: Math.max(0, num(o.diskUsedBytes)),
    diskTotalBytes: Math.max(0, num(o.diskTotalBytes)),
    diskMount: typeof o.diskMount === "string" && o.diskMount ? o.diskMount : "/",
  };
}
