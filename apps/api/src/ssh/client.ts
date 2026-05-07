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

/** Кандидаты для AmneziaWG: `awg` не всегда в PATH у `sh`, тогда остаётся только полный путь. */
const AWG_PROBE_EXES = ["awg", "/usr/bin/awg", "/usr/local/bin/awg"] as const;

function assertWgExe(exe: string): void {
  if (exe === "wg") return;
  if ((AWG_PROBE_EXES as readonly string[]).includes(exe)) return;
  throw new Error("invalid wg executable");
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
  for (const awgExe of AWG_PROBE_EXES) {
    const cmd = `docker exec ${shellQuote(container)} ${shellQuote(awgExe)} show ${shellQuote(iface)}`;
    const r = await execRemote(auth, cmd);
    if (r.code === 0) return awgExe;
  }
  return "wg";
}

export async function execRemote(
  auth: SshAuth,
  command: string,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
  const r = await execRemote(auth, cmd);
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
  const r = await execRemote(auth, cmd, privateKey.trim() + "\n");
  if (r.code !== 0) throw new Error(`wg pubkey failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/**
 * В БД часто wg0, в Amnezia контейнере — только awg0. Берём имя из `wg show` на контейнере.
 */
export async function dockerResolveWgIface(auth: SshAuth, container: string, prefer: string): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(prefer, SAFE_IFACE, "iface");
  const cmd = `docker exec ${shellQuote(container)} wg show`;
  const r = await execRemote(auth, cmd);
  if (r.code !== 0) throw new Error(`wg show failed: ${r.stderr || r.stdout}`);
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
  const r = await execRemote(auth, cmd);
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
  const r = await execRemote(auth, cmd);
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
  const r = await execRemote(auth, cmd);
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
  const pskTail =
    presharedKey !== undefined && presharedKey.length > 0
      ? ` preshared-key ${shellQuote(presharedKey)}`
      : "";
  const cmd = `docker exec ${shellQuote(container)} ${shellQuote(exe)} set ${shellQuote(iface)} peer ${shellQuote(clientPub)} allowed-ips ${shellQuote(allowedIps)}${pskTail}`;
  const r = await execRemote(auth, cmd);
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
  const r = await execRemote(auth, cmd);
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
