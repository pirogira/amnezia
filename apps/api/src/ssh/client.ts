import { Client, type ClientChannel } from "ssh2";

export type SshAuth = {
  host: string;
  port: number;
  username: string;
  privateKey: string;
};

function assertNoShellInjection(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`Invalid ${label}`);
}

/** Container/image-safe name segment */
export const SAFE_CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const SAFE_IFACE = /^wg[0-9]+$/;
export const SAFE_HOOK_PATH = /^\/[a-zA-Z0-9/_-]+\.sh$/;
export const SAFE_COMPOSE_PATH = /^\/[a-zA-Z0-9/_.-]+\.(ya?ml)$/;

export async function execRemote(
  auth: SshAuth,
  command: string,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
        privateKey: auth.privateKey,
        readyTimeout: 20000,
      });
  });
}

export async function dockerExecWgGenkey(auth: SshAuth, container: string): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  const cmd = `docker exec ${shellQuote(container)} wg genkey`;
  const r = await execRemote(auth, cmd);
  if (r.code !== 0) throw new Error(`wg genkey failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export async function dockerExecWgPubkey(
  auth: SshAuth,
  container: string,
  privateKey: string,
): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  if (!/^[A-Za-z0-9+/=_\n-]+$/.test(privateKey.trim())) {
    throw new Error("privateKey has unexpected characters");
  }
  const cmd = `docker exec -i ${shellQuote(container)} wg pubkey`;
  const r = await execRemote(auth, cmd, privateKey.trim() + "\n");
  if (r.code !== 0) throw new Error(`wg pubkey failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export async function dockerExecWgShowPublicKey(
  auth: SshAuth,
  container: string,
  iface: string,
): Promise<string> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  const cmd = `docker exec ${shellQuote(container)} wg show ${shellQuote(iface)} public-key`;
  const r = await execRemote(auth, cmd);
  if (r.code !== 0) throw new Error(`wg show public-key failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

export async function dockerExecWgSetPeer(
  auth: SshAuth,
  container: string,
  iface: string,
  clientPub: string,
  allowedIps: string,
): Promise<void> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  if (!/^[A-Za-z0-9+/=]+$/.test(clientPub)) throw new Error("invalid client public key");
  if (!/^[\d./a-f:,]+$/.test(allowedIps)) throw new Error("invalid allowed ips");
  const cmd = `docker exec ${shellQuote(container)} wg set ${shellQuote(iface)} peer ${shellQuote(clientPub)} allowed-ips ${shellQuote(allowedIps)}`;
  const r = await execRemote(auth, cmd);
  if (r.code !== 0) throw new Error(`wg set peer failed: ${r.stderr || r.stdout}`);
}

export async function dockerExecWgRemovePeer(
  auth: SshAuth,
  container: string,
  iface: string,
  clientPub: string,
): Promise<void> {
  assertNoShellInjection(container, SAFE_CONTAINER, "container");
  assertNoShellInjection(iface, SAFE_IFACE, "iface");
  if (!/^[A-Za-z0-9+/=]+$/.test(clientPub)) throw new Error("invalid client public key");
  const cmd = `docker exec ${shellQuote(container)} wg set ${shellQuote(iface)} peer ${shellQuote(clientPub)} remove`;
  const r = await execRemote(auth, cmd);
  if (r.code !== 0) throw new Error(`wg remove peer failed: ${r.stderr || r.stdout}`);
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
