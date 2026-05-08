import { randomBytes } from "node:crypto";
import { Client, type ClientChannel } from "ssh2";

export type SshAuth = {
  host: string;
  port: number;
  username: string;
  /** OpenSSH / RSA PEM; PuTTY .ppk не подходит — конвертируйте или используйте password. */
  privateKey?: string;
  password?: string;
};

function assertNoShellInjection(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
}

/** Container/image-safe name segment */
export const SAFE_CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
/** WireGuard: wg0; AmneziaWG в контейнере часто awg0 / awg1 */
export const SAFE_IFACE = /^(?:wg|awg)[0-9]+$/;
export const SAFE_HOOK_PATH = /^\/[a-zA-Z0-9/_-]+\.sh$/;
export const SAFE_COMPOSE_PATH = /^\/[a-zA-Z0-9/_.-]+\.(ya?ml)$/;

/**
 * Для awg* в образах вроде amneziavpn/amneziawg-go чаще в PATH есть `wg` (симлинк на awg), а команда `awg` отсутствует.
 * Пробуем `wg` и абсолютные пути раньше, чтобы не получать «executable file not found» при ручном docker exec.
 */
const AWG_IFACE_EXE_PROBE = ["wg", "/usr/bin/wg", "awg", "/usr/bin/awg", "/usr/local/bin/awg"] as const;

const ALLOWED_WG_EXE = new Set<string>([...AWG_IFACE_EXE_PROBE]);

function assertWgExe(exe: string): void {
  if (!ALLOWED_WG_EXE.has(exe)) throw new Error("invalid wg executable");
}

/**
 * Для интерфейса awg* нужен userspace `awg` (часто не тот же бинарь, что `wg`), иначе `wg set` → fopen / netlink.
 * Выбираем тот `awg`, для которого реально проходит `show IFACE`.
 */
export async function dockerResolveWgExe(
  auth: SshAuth,
  container: string,
  iface: string,
): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  if (!/^awg\d+$/.test(iface)) return "wg";
  for (const exe of AWG_IFACE_EXE_PROBE) {
    const cmd = `docker exec ${shellQuote(container)} ${shellQuote(exe)} show ${shellQuote(iface)}`;
    const r = await execRemoteAfterContainerRunning(auth, container, cmd);
    if (r.code === 0) return exe;
  }
  return "wg";
}

export type ExecRemoteResult = { stdout: string; stderr: string; code: number | null };

function dockerDaemonReportsContainerRestarting(combinedOut: string): boolean {
  return /is restarting,?\s*wait until the container is running/i.test(combinedOut);
}

function trimLogSnippet(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * Ждёт, пока `docker inspect` вернёт Status=running (не restarting/exited).
 * При exited/dead или таймауте — сообщение с хвостом docker logs.
 */
export async function dockerWaitUntilRunning(
  auth: SshAuth,
  container: string,
  opts?: { maxAttempts?: number; delayMs?: number },
): Promise<{ ok: true } | { ok: false; message: string }> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  const maxAttempts = opts?.maxAttempts ?? 90;
  const delayMs = opts?.delayMs ?? 2000;

  for (let i = 0; i < maxAttempts; i++) {
    const r = await execRemote(
      auth,
      `docker inspect --format '{{.State.Status}}' ${shellQuote(container)} 2>/dev/null || echo missing`,
    );
    const status = r.stdout.trim();
    if (status === "running") return { ok: true };
    if (status === "exited" || status === "dead") {
      const logsR = await execRemote(auth, `docker logs --tail 100 ${shellQuote(container)} 2>&1`);
      const logs = trimLogSnippet(logsR.stdout || logsR.stderr, 2500);
      return {
        ok: false,
        message: `Контейнер ${container} остановлен (${status}). Часто так бывает при падении awg-quick/wg-quick внутри образа. Логи:\n${logs}`,
      };
    }
    if (status === "missing" || status === "") {
      if (i >= 8) {
        return {
          ok: false,
          message: `Контейнер ${container} не найден (docker inspect). Проверьте имя контейнера.`,
        };
      }
    }
    await new Promise((res) => setTimeout(res, delayMs));
  }

  const logsR = await execRemote(auth, `docker logs --tail 120 ${shellQuote(container)} 2>&1`);
  const logs = trimLogSnippet(logsR.stdout || logsR.stderr, 2500);
  const ins = await execRemote(
    auth,
    `docker inspect ${shellQuote(container)} --format '{{.State.Status}}' 2>/dev/null`,
  );
  return {
    ok: false,
    message: `Таймаут ожидания running для ${container} (последний status: ${ins.stdout.trim() || "?"}). Контейнер может быть в цикле перезапусков — смотрите логи на сервере. Логи:\n${logs}`,
  };
}

/**
 * Выполняет SSH-команду; если Docker отвечает, что контейнер перезапускается, ждёт running и повторяет exec.
 */
export type ExecRemoteAfterContainerOpts = {
  /** По умолчанию 40×2s; для плотных циклов (провижн) — меньше, чтобы не «висеть» внутри одного await. */
  waitRunningMaxAttempts?: number;
  maxOuterRetries?: number;
};

export async function execRemoteAfterContainerRunning(
  auth: SshAuth,
  container: string,
  command: string,
  stdin?: string,
  opts?: ExecRemoteAfterContainerOpts,
): Promise<ExecRemoteResult> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  const maxOuter = opts?.maxOuterRetries ?? 12;
  const waitAttempts = opts?.waitRunningMaxAttempts ?? 40;
  let last = await execRemote(auth, command, stdin);
  for (let i = 0; i < maxOuter; i++) {
    const combined = `${last.stderr}${last.stdout}`;
    if (last.code === 0 || !dockerDaemonReportsContainerRestarting(combined)) {
      return last;
    }
    const w = await dockerWaitUntilRunning(auth, container, { maxAttempts: waitAttempts, delayMs: 2000 });
    if (!w.ok) {
      return {
        stdout: last.stdout,
        stderr: `${combined.trim()}\n---\n${w.message}`,
        code: last.code ?? 1,
      };
    }
    last = await execRemote(auth, command, stdin);
  }
  return last;
}

export async function execRemote(
  auth: SshAuth,
  command: string,
  stdin?: string,
): Promise<ExecRemoteResult> {
  const hasKey = Boolean(auth.privateKey && auth.privateKey.length > 0);
  const hasPwd = Boolean(auth.password && auth.password.length > 0);
  if (!hasKey && !hasPwd) {
    return Promise.reject(new Error("SSH key or password required"));
  }
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        conn.exec(command, (err: Error | undefined, stream: ClientChannel) => {
          if (err) {
            conn.end();
            reject(err);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code: number | null) => {
              conn.end();
              resolve({ stdout, stderr, code });
            })
            .on("data", (d: Buffer) => {
              stdout += d.toString("utf8");
            })
            .stderr.on("data", (d: Buffer) => {
              stderr += d.toString("utf8");
            });
          if (stdin !== undefined) {
            stream.end(stdin);
          }
        });
      })
      .on("error", reject)
      .connect({
        host: auth.host,
        port: auth.port,
        username: auth.username,
        ...(auth.privateKey && auth.privateKey.length > 0 ? { privateKey: auth.privateKey } : {}),
        ...(auth.password && auth.password.length > 0 ? { password: auth.password } : {}),
        readyTimeout: 20000,
      });
  });
}

export async function dockerExecWgGenkey(
  auth: SshAuth,
  container: string,
  exe = "wg",
): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertWgExe(exe);
  const cmd = `docker exec ${shellQuote(container)} ${shellQuote(exe)} genkey`;
  const r = await execRemoteAfterContainerRunning(auth, container, cmd);
  if (r.code !== 0) throw new Error(`wg genkey failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export async function dockerExecWgPubkey(
  auth: SshAuth,
  container: string,
  privateKey: string,
  exe = "wg",
): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertWgExe(exe);
  if (!/^[A-Za-z0-9+/=_\n-]+$/.test(privateKey.trim())) {
    throw new Error("privateKey has unexpected characters");
  }
  const cmd = `docker exec -i ${shellQuote(container)} ${shellQuote(exe)} pubkey`;
  const r = await execRemoteAfterContainerRunning(auth, container, cmd, privateKey.trim() + "\n");
  if (r.code !== 0) throw new Error(`wg pubkey failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * В БД часто wg0, в Amnezia контейнере — только awg0. Берём имя из `wg show` на контейнере.
 */
export async function dockerResolveWgIface(auth: SshAuth, container: string, prefer: string): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(prefer, SAFE_IFACE, "iface");
  let r = await execRemoteAfterContainerRunning(auth, container, `docker exec ${shellQuote(container)} wg show`);
  if (r.code !== 0 || !/^\s*interface:/m.test(r.stdout)) {
    r = await execRemoteAfterContainerRunning(auth, container, `docker exec ${shellQuote(container)} awg show`);
  }
  if (r.code !== 0) throw new Error(`wg/awg show failed: ${r.stderr || r.stdout}`);
  const names: string[] = [];
  const re = /^interface:\s*(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(r.stdout)) !== null) {
    names.push(m[1]);
  }
  if (names.length === 0) {
    throw new Error(`wg show: нет interface: в выводе: ${r.stdout.slice(0, 400)}`);
  }
  if (names.includes(prefer)) return prefer;
  const awg = names.find((n) => /^awg\d+$/.test(n));
  if (awg) return awg;
  const wg = names.find((n) => /^wg\d+$/.test(n));
  if (wg) return wg;
  return names[0];
}

/**
 * Первые три октета подсети /24 с интерфейса в контейнере (например `10.8.1` из `10.8.1.1/24`).
 * Нужно, чтобы IP клиента совпадали с подсетью NAT Amnezia, а не с ошибочным CIDR в карточке панели.
 */
export async function dockerDetectIfaceSlash24Prefix(
  auth: SshAuth,
  container: string,
  iface: string,
): Promise<string | null> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  const cmd = `docker exec ${shellQuote(container)} ip -4 -o addr show dev ${shellQuote(iface)} 2>/dev/null || true`;
  const r = await execRemoteAfterContainerRunning(auth, container, cmd);
  const m = /\binet\s+(\d+\.\d+\.\d+)\.\d+\/(24)\b/.exec(r.stdout);
  if (!m) return null;
  return m[1];
}

export async function dockerExecWgShowPublicKey(
  auth: SshAuth,
  container: string,
  iface: string,
  exe = "wg",
): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  assertWgExe(exe);
  const cmd = `docker exec ${shellQuote(container)} ${shellQuote(exe)} show ${shellQuote(iface)}`;
  const r = await execRemoteAfterContainerRunning(auth, container, cmd);
  if (r.code !== 0) throw new Error(`wg show failed: ${r.stderr || r.stdout}`);
  const head = r.stdout.split(/\npeer:/i)[0] ?? r.stdout;
  const pk = /public key:\s*([A-Za-z0-9+/=]+)/.exec(head);
  if (!pk) {
    throw new Error(`wg show: не найден public key интерфейса: ${r.stdout.slice(0, 400)}`);
  }
  return pk[1].trim();
}

/** Полный вывод `wg show IFACE` (разбор Amnezia-параметров для .conf). */
export async function dockerExecWgShowDump(
  auth: SshAuth,
  container: string,
  iface: string,
  exe = "wg",
): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  assertWgExe(exe);
  const cmd = `docker exec ${shellQuote(container)} ${shellQuote(exe)} show ${shellQuote(iface)}`;
  const r = await execRemoteAfterContainerRunning(auth, container, cmd);
  if (r.code !== 0) throw new Error(`wg show failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function dockerExecWgGenpsk(
  auth: SshAuth,
  container: string,
  exe = "wg",
): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertWgExe(exe);
  const cmd = `docker exec ${shellQuote(container)} ${shellQuote(exe)} genpsk`;
  const r = await execRemoteAfterContainerRunning(auth, container, cmd);
  if (r.code !== 0) throw new Error(`wg genpsk failed: ${r.stderr || r.stdout}`);
  const psk = r.stdout.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(psk)) throw new Error("invalid wg genpsk output");
  return psk;
}

export async function dockerExecWgSetPeer(
  auth: SshAuth,
  container: string,
  iface: string,
  clientPub: string,
  allowedIps: string,
  presharedKey?: string,
  exe = "wg",
): Promise<void> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  assertWgExe(exe);
  if (!/^[A-Za-z0-9+/=]+$/.test(clientPub)) throw new Error("invalid client public key");
  if (!/^[\d./a-f:,]+$/.test(allowedIps)) throw new Error("invalid allowed ips");
  if (presharedKey !== undefined && !/^[A-Za-z0-9+/=]+$/.test(presharedKey)) {
    throw new Error("invalid preshared key");
  }

  /** `wg`/`awg` ожидают у `preshared-key` путь к файлу с base64, не сам ключ — иначе fopen на «имени файла». */
  if (presharedKey !== undefined && presharedKey.length > 0) {
    const tmpBase = `panel-wpsk-${randomBytes(16).toString("hex")}`;
    if (!/^panel-wpsk-[a-f0-9]{32}$/.test(tmpBase)) throw new Error("internal tmp name");
    const tmpPath = `/tmp/${tmpBase}`;
    const script = `umask 077; cat >${shellQuote(tmpPath)} && ${shellQuote(exe)} set ${shellQuote(iface)} peer ${shellQuote(clientPub)} allowed-ips ${shellQuote(allowedIps)} preshared-key ${shellQuote(tmpPath)}; e=$?; rm -f ${shellQuote(tmpPath)}; exit $e`;
    const cmd = `docker exec -i ${shellQuote(container)} sh -c ${shellQuote(script)}`;
    const r = await execRemoteAfterContainerRunning(auth, container, cmd, `${presharedKey}\n`);
    if (r.code !== 0) throw new Error(`${exe} set peer failed: ${r.stderr || r.stdout}`);
    return;
  }

  const cmd = `docker exec ${shellQuote(container)} ${shellQuote(exe)} set ${shellQuote(iface)} peer ${shellQuote(clientPub)} allowed-ips ${shellQuote(allowedIps)}`;
  const r = await execRemoteAfterContainerRunning(auth, container, cmd);
  if (r.code !== 0) throw new Error(`${exe} set peer failed: ${r.stderr || r.stdout}`);
}

export async function dockerExecWgRemovePeer(
  auth: SshAuth,
  container: string,
  iface: string,
  clientPub: string,
  exe = "wg",
): Promise<void> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  assertWgExe(exe);
  if (!/^[A-Za-z0-9+/=]+$/.test(clientPub)) throw new Error("invalid client public key");
  const cmd = `docker exec ${shellQuote(container)} ${shellQuote(exe)} set ${shellQuote(iface)} peer ${shellQuote(clientPub)} remove`;
  const r = await execRemoteAfterContainerRunning(auth, container, cmd);
  if (r.code !== 0) throw new Error(`${exe} remove peer failed: ${r.stderr || r.stdout}`);
}

export async function dockerContainerExists(
  auth: SshAuth,
  container: string,
): Promise<boolean> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  const cmd = `docker inspect --format '{{.Id}}' ${shellQuote(container)}`;
  const r = await execRemote(auth, cmd);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export async function dockerComposeConfigQuiet(
  auth: SshAuth,
  composePath: string,
): Promise<{ ok: boolean; stderr: string }> {
  assertNoShellInjection(composePath, SAFE_COMPOSE_PATH, "composePath");
  const cmd = `docker compose -f ${shellQuote(composePath)} config --quiet`;
  const r = await execRemote(auth, cmd);
  return { ok: r.code === 0, stderr: r.stderr };
}

export async function runPortHook(
  auth: SshAuth,
  hookPath: string,
  port: number,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  assertNoShellInjection(hookPath, SAFE_HOOK_PATH, "hookPath");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid port");
  const cmd = `${shellQuote(hookPath)} ${port}`;
  const r = await execRemote(auth, cmd);
  return { ok: r.code === 0, ...r };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
