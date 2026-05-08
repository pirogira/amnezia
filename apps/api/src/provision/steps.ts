import {
  dockerWaitUntilRunning,
  execRemote,
  execRemoteAfterContainerRunning,
  SAFE_CONTAINER,
  SAFE_IFACE,
  shellQuote,
} from "../ssh/client.js";
import type { SshAuth } from "../ssh/client.js";
import {
  PROVISION_AWG_CONF,
  PROVISION_COMPOSE_PATH,
  PROVISION_AWG_DIR,
} from "./compose.js";

export type StepResult = { ok: true; detail?: string } | { ok: false; message: string };

function trimCmdOut(s: string, max = 800): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export async function stepDetectUbuntu(auth: SshAuth): Promise<StepResult> {
  const r = await execRemote(auth, "cat /etc/os-release");
  if (r.code !== 0) return { ok: false, message: `os-release: ${trimCmdOut(r.stderr || r.stdout)}` };
  const text = r.stdout;
  if (!/^ID=ubuntu$/m.test(text)) {
    return { ok: false, message: "Требуется Ubuntu (ID=ubuntu в /etc/os-release)." };
  }
  const m = /^VERSION_ID="?(22\.04|24\.04)"?$/m.exec(text);
  if (!m) {
    return {
      ok: false,
      message: `Поддерживаются только Ubuntu 22.04 и 24.04 (VERSION_ID). Получено: ${trimCmdOut(text, 400)}`,
    };
  }
  return { ok: true, detail: `Ubuntu ${m[1]}` };
}

export async function stepEnsureDocker(auth: SshAuth): Promise<StepResult> {
  const check = await execRemote(
    auth,
    "command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && echo ok || echo missing",
  );
  if (check.stdout.includes("ok")) return { ok: true, detail: "Docker уже установлен" };

  const script = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sh
systemctl enable docker 2>/dev/null || true
systemctl start docker 2>/dev/null || true
docker compose version
`;
  const r = await execRemote(auth, `bash -lc ${shellQuote(script)}`);
  if (r.code !== 0) {
    return { ok: false, message: `Установка Docker: ${trimCmdOut(r.stderr || r.stdout)}` };
  }
  return { ok: true, detail: "Docker установлен" };
}

export async function stepEnableIpv4Forward(auth: SshAuth): Promise<StepResult> {
  const script = `set -e
sysctl -w net.ipv4.ip_forward=1
grep -q '^net.ipv4.ip_forward=1' /etc/sysctl.conf 2>/dev/null || echo 'net.ipv4.ip_forward=1' >> /etc/sysctl.conf
`;
  const r = await execRemote(auth, `bash -lc ${shellQuote(script)}`);
  if (r.code !== 0) return { ok: false, message: `sysctl: ${trimCmdOut(r.stderr || r.stdout)}` };
  return { ok: true };
}

export async function stepWriteProvisionFiles(
  auth: SshAuth,
  composeYaml: string,
  awg0Conf: string,
): Promise<StepResult> {
  const b64Compose = Buffer.from(composeYaml, "utf8").toString("base64");
  const b64Conf = Buffer.from(awg0Conf, "utf8").toString("base64");
  const script = `set -euo pipefail
install -d -m 755 ${PROVISION_AWG_DIR}
echo ${shellQuote(b64Compose)} | base64 -d > ${PROVISION_COMPOSE_PATH}
chmod 644 ${PROVISION_COMPOSE_PATH}
echo ${shellQuote(b64Conf)} | base64 -d > ${PROVISION_AWG_CONF}
chmod 600 ${PROVISION_AWG_CONF}
`;
  const r = await execRemote(auth, `bash -lc ${shellQuote(script)}`);
  if (r.code !== 0) {
    return { ok: false, message: `Запись файлов: ${trimCmdOut(r.stderr || r.stdout)}` };
  }
  return { ok: true };
}

export async function stepDockerComposeUp(auth: SshAuth): Promise<StepResult> {
  const r = await execRemote(
    auth,
    `docker compose -f ${shellQuote(PROVISION_COMPOSE_PATH)} up -d`,
  );
  if (r.code !== 0) {
    return { ok: false, message: `docker compose up: ${trimCmdOut(r.stderr || r.stdout)}` };
  }
  return { ok: true };
}

function parseWgInterfaces(stdout: string): string[] {
  const names: string[] = [];
  const re = /^interface:\s*(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) names.push(m[1]);
  return names;
}

const WG_SHOW_PUBLIC_KEY = /\bpublic\s*key\s*:/i;

/** Укороченные ретраи: иначе один «restarting» держит await минутами, UI и дедлайн шага не продвигаются. */
const WG_WAIT_EXEC_OPTS = { waitRunningMaxAttempts: 12, maxOuterRetries: 4 } as const;

function wgListExeOrder(preferred: string): readonly ["awg", "wg"] | readonly ["wg", "awg"] {
  return /^awg\d+$/.test(preferred) ? (["awg", "wg"] as const) : (["wg", "awg"] as const);
}

function wgIfaceExeOrder(iface: string): readonly ["awg", "wg"] | readonly ["wg", "awg"] {
  return /^awg\d+$/.test(iface) ? (["awg", "wg"] as const) : (["wg", "awg"] as const);
}

/** Поднялся ли интерфейс с публичным ключом (деталь = имя интерфейса для БД). */
export async function stepWaitWgShow(auth: SshAuth, container: string, preferred: string): Promise<StepResult> {
  if (!SAFE_CONTAINER.test(container)) throw new Error("Invalid container");
  if (!SAFE_IFACE.test(preferred)) throw new Error("Invalid iface");

  const deadline = Date.now() + 5 * 60 * 1000;

  await new Promise((res) => setTimeout(res, 3000));
  if (Date.now() > deadline) {
    return { ok: false, message: `Таймаут ожидания WireGuard в ${container} (лимит шага).` };
  }

  const runningFirst = await dockerWaitUntilRunning(auth, container, { maxAttempts: 45, delayMs: 2000 });
  if (!runningFirst.ok) return runningFirst;

  const maxAttempts = 40;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() > deadline) {
      const logR = await execRemote(auth, `docker logs --tail 120 ${shellQuote(container)} 2>&1`);
      const logs = trimCmdOut(logR.stdout || logR.stderr, 2500);
      return {
        ok: false,
        message: `Таймаут ожидания WireGuard в ${container} (~5 мин). Интерфейс вроде ${preferred} не подтвердился (public key / awg). Логи:\n${logs}`,
      };
    }

    let listOut = "";
    for (const listExe of wgListExeOrder(preferred)) {
      const lr = await execRemoteAfterContainerRunning(
        auth,
        container,
        `docker exec ${shellQuote(container)} ${shellQuote(listExe)} show`,
        undefined,
        WG_WAIT_EXEC_OPTS,
      );
      if (lr.code === 0 && /interface:/m.test(lr.stdout)) {
        listOut = lr.stdout;
        break;
      }
    }
    const names = parseWgInterfaces(listOut);
    const candidates: string[] = [];
    if (names.includes(preferred)) candidates.push(preferred);
    for (const n of names) {
      if (/^awg\d+$/.test(n) && !candidates.includes(n)) candidates.push(n);
    }
    for (const n of names) {
      if (/^wg\d+$/.test(n) && !candidates.includes(n)) candidates.push(n);
    }
    for (const n of names) {
      if (!candidates.includes(n)) candidates.push(n);
    }
    const tryList = candidates.length > 0 ? candidates : [preferred];

    for (const iface of tryList) {
      if (!SAFE_IFACE.test(iface)) continue;
      for (const exe of wgIfaceExeOrder(iface)) {
        const r = await execRemoteAfterContainerRunning(
          auth,
          container,
          `docker exec ${shellQuote(container)} ${shellQuote(exe)} show ${shellQuote(iface)}`,
          undefined,
          WG_WAIT_EXEC_OPTS,
        );
        if (r.code === 0 && WG_SHOW_PUBLIC_KEY.test(r.stdout)) {
          return { ok: true, detail: iface };
        }
      }
    }
    await new Promise((res) => setTimeout(res, 2000));
  }

  const logR = await execRemote(auth, `docker logs --tail 120 ${shellQuote(container)} 2>&1`);
  const logs = trimCmdOut(logR.stdout || logR.stderr, 2500);
  const st = await execRemote(
    auth,
    `docker inspect ${shellQuote(container)} --format '{{.State.Status}} {{.State.ExitCode}} {{.State.Error}}' 2>/dev/null`,
  );
  const meta = trimCmdOut(st.stdout || "", 500);
  return {
    ok: false,
    message: `Таймаут: WireGuard в ${container} (ждали интерфейс вроде ${preferred}). inspect: ${meta}\n--- логи ---\n${logs}`,
  };
}
