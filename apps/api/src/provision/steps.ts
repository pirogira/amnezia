import {
  dockerWaitUntilRunning,
  execRemote,
  execRemoteAfterContainerRunning,
  SAFE_CONTAINER,
  SAFE_IFACE,
  shellQuote,
} from "../ssh/client.js";
import type { SshAuth } from "../ssh/client.js";
import { AMNEZIA_WG_IMAGE } from "./compose.js";
import { normalizeProvisionComposeYaml } from "./dockerImage.js";
import { type AwgHostLayout, DEFAULT_AWG_LAYOUT } from "./layout.js";
import { PANEL_WG_NAT_SCRIPT_BASENAME } from "./panelNatScript.js";

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

/** Есть ли готовый к работе AWG (конфиг + контейнер) на целевом VPS. */
export async function panelAwgProvisionReady(
  auth: SshAuth,
  layout: AwgHostLayout = DEFAULT_AWG_LAYOUT,
): Promise<boolean> {
  const conf = await execRemote(auth, `test -f ${shellQuote(layout.awgConfPath)} && echo ok`);
  if (!conf.stdout.includes("ok")) return false;
  const st = await execRemote(
    auth,
    `docker inspect ${shellQuote(layout.containerName)} --format '{{.State.Running}}' 2>/dev/null`,
  );
  return st.stdout.trim() === "true";
}

/**
 * Подготовка чистого/нового VPS: снять конфликтующие контейнеры, pull образа, открыть UDP в UFW.
 */
export async function stepPrepareNewServerHost(
  auth: SshAuth,
  listenPort: number,
  layout: AwgHostLayout = DEFAULT_AWG_LAYOUT,
  composeYaml?: string,
): Promise<StepResult> {
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    return { ok: false, message: "Некорректный listenPort" };
  }
  const port = String(listenPort);
  /** На новом VPS всегда пин с Hub; локальный тег образца (amnezia-awg2) не pull'ится. */
  const pullImage = AMNEZIA_WG_IMAGE;
  const script = `set -euo pipefail
rm -f ${shellQuote(layout.composePath)}
if [ -f ${shellQuote(layout.composePath)} ]; then
  docker compose -f ${shellQuote(layout.composePath)} down --remove-orphans 2>/dev/null || true
fi
for c in ${layout.containerName} amnezia-wireguard amnezia-awg2 amnezia-awg; do
  docker rm -f "$c" 2>/dev/null || true
done
docker pull ${shellQuote(pullImage)}
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qiE 'Status: active|статус: активен'; then
  ufw allow ${port}/udp comment 'amnesia-veb awg' >/dev/null 2>&1 || ufw allow ${port}/udp >/dev/null 2>&1 || true
fi
`;
  const r = await execRemote(auth, `bash -lc ${shellQuote(script)}`);
  if (r.code !== 0) {
    return { ok: false, message: `Подготовка хоста: ${trimCmdOut(r.stderr || r.stdout)}` };
  }
  return { ok: true, detail: `Образ загружен (${pullImage.split("@")[0]})` };
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
  natScript: string,
  layout: AwgHostLayout = DEFAULT_AWG_LAYOUT,
): Promise<StepResult> {
  const normalizedCompose = normalizeProvisionComposeYaml(composeYaml, {
    containerName: layout.containerName,
  });
  const b64Compose = Buffer.from(normalizedCompose, "utf8").toString("base64");
  const b64Conf = Buffer.from(awg0Conf, "utf8").toString("base64");
  const b64Nat = Buffer.from(natScript, "utf8").toString("base64");
  const natHostPath = `${layout.awgDir}/${PANEL_WG_NAT_SCRIPT_BASENAME}`;
  const script = `set -euo pipefail
install -d -m 755 ${shellQuote(layout.awgDir)}
echo ${shellQuote(b64Compose)} | base64 -d > ${shellQuote(layout.composePath)}
chmod 644 ${shellQuote(layout.composePath)}
echo ${shellQuote(b64Conf)} | base64 -d > ${shellQuote(layout.awgConfPath)}
chmod 600 ${shellQuote(layout.awgConfPath)}
echo ${shellQuote(b64Nat)} | base64 -d > ${shellQuote(natHostPath)}
chmod 755 ${shellQuote(natHostPath)}
`;
  const r = await execRemote(auth, `bash -lc ${shellQuote(script)}`);
  if (r.code !== 0) {
    return { ok: false, message: `Запись файлов: ${trimCmdOut(r.stderr || r.stdout)}` };
  }
  return { ok: true };
}

export async function stepDockerComposeUp(
  auth: SshAuth,
  layout: AwgHostLayout = DEFAULT_AWG_LAYOUT,
  opts?: { forceRecreate?: boolean },
): Promise<StepResult> {
  const flags = opts?.forceRecreate ? " --force-recreate" : "";
  const r = await execRemote(
    auth,
    `docker compose -f ${shellQuote(layout.composePath)} up -d${flags}`,
  );
  if (r.code !== 0) {
    return { ok: false, message: `docker compose up: ${trimCmdOut(r.stderr || r.stdout)}` };
  }
  return { ok: true };
}

/** Только compose + panel-nat (без awg0.conf) — при повторном провижне с уже существующим контейнером. */
export async function stepWriteProvisionSidecars(
  auth: SshAuth,
  composeYaml: string,
  natScript: string,
  layout: AwgHostLayout = DEFAULT_AWG_LAYOUT,
): Promise<StepResult> {
  const normalizedCompose = normalizeProvisionComposeYaml(composeYaml, {
    containerName: layout.containerName,
  });
  const b64Compose = Buffer.from(normalizedCompose, "utf8").toString("base64");
  const b64Nat = Buffer.from(natScript, "utf8").toString("base64");
  const natHostPath = `${layout.awgDir}/${PANEL_WG_NAT_SCRIPT_BASENAME}`;
  const script = `set -euo pipefail
install -d -m 755 ${shellQuote(layout.awgDir)}
echo ${shellQuote(b64Compose)} | base64 -d > ${shellQuote(layout.composePath)}
chmod 644 ${shellQuote(layout.composePath)}
echo ${shellQuote(b64Nat)} | base64 -d > ${shellQuote(natHostPath)}
chmod 755 ${shellQuote(natHostPath)}
`;
  const r = await execRemote(auth, `bash -lc ${shellQuote(script)}`);
  if (r.code !== 0) {
    return { ok: false, message: `Запись compose/NAT: ${trimCmdOut(r.stderr || r.stdout)}` };
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
