import { execRemote, shellQuote } from "../ssh/client.js";
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

export async function stepWaitWgShow(auth: SshAuth, container: string, iface: string): Promise<StepResult> {
  await new Promise((res) => setTimeout(res, 3000));
  const maxAttempts = 45;
  for (let i = 0; i < maxAttempts; i++) {
    const r = await execRemote(auth, `docker exec ${shellQuote(container)} wg show ${shellQuote(iface)}`);
    if (r.code === 0 && r.stdout.includes("public key:")) {
      return { ok: true, detail: `wg show ${iface} готов` };
    }
    const r2 = await execRemote(auth, `docker exec ${shellQuote(container)} awg show ${shellQuote(iface)}`);
    if (r2.code === 0 && r2.stdout.includes("public key:")) {
      return { ok: true, detail: `awg show ${iface} готов` };
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { ok: false, message: `Таймаут: контейнер не поднял интерфейс ${iface} (wg/awg show).` };
}
