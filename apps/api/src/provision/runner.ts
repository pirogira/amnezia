import type { FastifyBaseLogger } from "fastify";
import { writeAudit } from "../audit.js";
import { getDb } from "../db.js";
import type { ServerRow } from "../drivers/types.js";
import { insertVpnServerRecord, type VpnServerInsertInput } from "../services/vpnServerInsert.js";
import {
  dockerDetectIfaceSlash24Prefix,
  dockerResolveWgIface,
} from "../ssh/client.js";
import type { SshAuth } from "../ssh/client.js";
import { buildProvisionComposeYaml } from "./compose.js";
import { type AwgHostLayout, DEFAULT_AWG_LAYOUT } from "./layout.js";
import { generateAwgObfuscationParams, generateWgServerKeypair } from "./keys.js";
import { buildPanelWgNatScript } from "./panelNatScript.js";
import { buildAwg0ServerConf } from "./serverConf.js";
import { allocateProvisionNetwork } from "./allocateNetwork.js";
import { fetchAwgDeployBundleFromServer } from "./templateFromServer.js";
import {
  type StepResult,
  stepDetectUbuntu,
  stepDockerComposeUp,
  stepEnableIpv4Forward,
  stepEnsureDocker,
  stepWaitWgShow,
  stepWriteProvisionFiles,
  stepWriteProvisionSidecars,
  stepPrepareNewServerHost,
  panelAwgProvisionReady,
} from "./steps.js";

export type ProvisionFormInput = {
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKey: string;
  sshPassword: string;
  endpointHost: string;
  /** Заполняются в runner через allocateProvisionNetwork(). */
  listenPort?: number;
  vpnSubnetCidr?: string;
  /** Рабочий сервер в панели: с него копируются docker-compose и panel-nat (ключи — новые). */
  templateServerId?: string;
  vlessReality?: VpnServerInsertInput["vlessReality"];
};

const STEP_LABELS: Record<string, string> = {
  detect_os: "Проверка ОС (Ubuntu 22.04 / 24.04)",
  allocate_network: "Подбор свободной подсети и UDP-порта",
  fetch_template: "Копирование Docker-шаблона с сервера-образца",
  probe_container: "Проверка контейнера amnezia-awg",
  ensure_docker: "Установка Docker (при необходимости)",
  prepare_host: "Подготовка VPS (образ, firewall, конфликты)",
  ip_forward: "Включение IPv4 forwarding",
  write_files: "Запись awg0.conf и docker-compose",
  write_sidecars: "Обновление docker-compose и panel-nat",
  compose_up: "docker compose up",
  wait_wg: "Ожидание интерфейса WireGuard",
  resolve_iface: "Определение интерфейса",
  save_server: "Сохранение сервера в панели",
};

export type ProvisionLogStep = {
  step: string;
  label?: string;
  ok: boolean;
  message?: string;
  durationMs?: number;
};

export type ProvisionRunnerOptions = {
  onProgress?: (line: Record<string, unknown>) => void;
  log?: FastifyBaseLogger;
};

function buildSshAuthForProvision(input: ProvisionFormInput): SshAuth {
  const pwd = input.sshPassword.trim();
  if (pwd) {
    return {
      host: input.sshHost,
      port: input.sshPort,
      username: input.sshUser,
      password: pwd,
    };
  }
  return {
    host: input.sshHost,
    port: input.sshPort,
    username: input.sshUser,
    privateKey: input.sshPrivateKey.trim(),
  };
}

function auditStep(adminId: string, step: string, r: StepResult): void {
  writeAudit(adminId, "server_provision_step", {
    step,
    ok: r.ok,
    ...(r.ok ? { detail: "detail" in r ? r.detail : undefined } : { message: r.message }),
  });
}

function baseInsert(
  input: ProvisionFormInput,
  vpnSubnetCidr: string,
  wgInterface: string,
  layout: AwgHostLayout,
): VpnServerInsertInput {
  return {
    name: input.name,
    sshHost: input.sshHost,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    sshPrivateKey: input.sshPrivateKey,
    sshPassword: input.sshPassword,
    dockerWgContainer: layout.containerName,
    wgInterface,
    vpnSubnetCidr,
    endpointHost: input.endpointHost,
    listenPort: provisionNetwork(input).listenPort,
    dockerComposePath: layout.composePath,
    composeServiceName: layout.composeServiceName,
    portChangeHookCmd: null,
    driverMode: "ssh",
    vlessReality: input.vlessReality,
  };
}

function stepMessage(r: StepResult): string | undefined {
  if (!r.ok && "message" in r) return r.message;
  if (r.ok && "detail" in r && r.detail) return r.detail;
  return undefined;
}

function provisionNetwork(input: ProvisionFormInput): { listenPort: number; vpnSubnetCidr: string } {
  if (input.listenPort == null || !input.vpnSubnetCidr) {
    throw new Error("Внутренняя ошибка: сеть не выделена");
  }
  return { listenPort: input.listenPort, vpnSubnetCidr: input.vpnSubnetCidr };
}

export async function runProvisionAmneziaAwg(
  adminId: string,
  input: ProvisionFormInput,
  opts?: ProvisionRunnerOptions,
): Promise<
  { ok: true; serverId: string; steps: ProvisionLogStep[] } | { ok: false; steps: ProvisionLogStep[]; message: string }
> {
  const steps: ProvisionLogStep[] = [];
  const auth = buildSshAuthForProvision(input);
  const emit = opts?.onProgress;
  const log = opts?.log;

  let totalSteps = 7;
  let stepIndex = 0;

  /** Пока идёт wait_wg, шлём пульсы — иначе UI «зависает» на одном проценте на десятки минут. */
  const withWaitWgPulse = (runInner: () => Promise<StepResult>): Promise<StepResult> => {
    const t0 = Date.now();
    const pulse = setInterval(() => {
      emit?.({
        event: "wait_wg_pulse",
        elapsedSec: Math.round((Date.now() - t0) / 1000),
        step: "wait_wg",
        label: STEP_LABELS.wait_wg,
        index: stepIndex,
        total: totalSteps,
        pct: Math.round((100 * (stepIndex - 1)) / totalSteps),
      });
    }, 5_000);
    return runInner().finally(() => clearInterval(pulse));
  };

  const push = (step: string, r: StepResult, durationMs?: number) => {
    const label = STEP_LABELS[step] ?? step;
    steps.push({
      step,
      label,
      ok: r.ok,
      ...("message" in r && !r.ok ? { message: r.message } : {}),
      ...("detail" in r && r.ok && r.detail ? { message: r.detail } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    auditStep(adminId, step, r);
    log?.info({ provision: step, ok: r.ok, durationMs, sshHost: input.sshHost }, "provision_step");
  };

  async function runStep(stepKey: string, fn: () => Promise<StepResult>): Promise<StepResult> {
    const label = STEP_LABELS[stepKey] ?? stepKey;
    stepIndex += 1;
    emit?.({
      event: "step_start",
      step: stepKey,
      label,
      index: stepIndex,
      total: totalSteps,
      pct: Math.round((100 * (stepIndex - 1)) / totalSteps),
    });
    const t0 = Date.now();
    const r = await fn();
    const durationMs = Date.now() - t0;
    push(stepKey, r, durationMs);
    emit?.({
      event: "step_end",
      step: stepKey,
      label,
      index: stepIndex,
      total: totalSteps,
      ok: r.ok,
      durationMs,
      message: stepMessage(r),
      pct: Math.round((100 * stepIndex) / totalSteps),
    });
    return r;
  }

  writeAudit(adminId, "server_provision_start", {
    name: input.name,
    sshHost: input.sshHost,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
  });
  log?.info({ sshHost: input.sshHost, name: input.name }, "provision_start");

  const tDetect = Date.now();
  emit?.({
    event: "step_start",
    step: "detect_os",
    label: STEP_LABELS.detect_os,
    index: 1,
    total: 7,
    pct: 0,
  });
  let dr = await stepDetectUbuntu(auth);
  const detectMs = Date.now() - tDetect;
  push("detect_os", dr, detectMs);
  log?.info({ provision: "detect_os", ok: dr.ok, durationMs: detectMs }, "provision_step");
  if (!dr.ok) {
    emit?.({
      event: "step_end",
      step: "detect_os",
      label: STEP_LABELS.detect_os,
      index: 1,
      total: 7,
      ok: false,
      durationMs: detectMs,
      message: dr.message,
      pct: 0,
    });
    return { ok: false, steps, message: dr.message };
  }

  let layout: AwgHostLayout = DEFAULT_AWG_LAYOUT;
  let composeYaml = buildProvisionComposeYaml();
  let natScript = buildPanelWgNatScript();
  const withTemplate = Boolean(input.templateServerId?.trim());

  emit?.({
    event: "step_end",
    step: "detect_os",
    label: STEP_LABELS.detect_os,
    index: 1,
    total: 8,
    ok: true,
    durationMs: detectMs,
    message: stepMessage(dr),
    pct: 12,
  });

  stepIndex = 1;

  dr = await runStep("allocate_network", async () => {
    try {
      const net = allocateProvisionNetwork();
      input.listenPort = net.listenPort;
      input.vpnSubnetCidr = net.vpnSubnetCidr;
      return { ok: true, detail: `порт ${net.listenPort}, подсеть ${net.vpnSubnetCidr}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: msg };
    }
  });
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  if (withTemplate) {
    dr = await runStep("fetch_template", async () => {
      try {
        const ref = getDb()
          .prepare(`SELECT * FROM vpn_servers WHERE id = ?`)
          .get(input.templateServerId!.trim()) as ServerRow | undefined;
        if (!ref) return { ok: false, message: "Сервер-образец не найден в панели" };
        const bundle = await fetchAwgDeployBundleFromServer(ref);
        layout = bundle.layout;
        composeYaml = bundle.composeYaml;
        natScript = bundle.natScript;
        return { ok: true, detail: `Образец: ${ref.name}` };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, message: msg };
      }
    });
    if (!dr.ok) return { ok: false, steps, message: dr.message };
  }

  const reuseExisting = await panelAwgProvisionReady(auth, layout);
  totalSteps = reuseExisting ? (withTemplate ? 11 : 10) : withTemplate ? 10 : 9;
  emit?.({
    event: "plan",
    totalSteps,
    reusedContainer: reuseExisting,
    message: reuseExisting
      ? "Контейнер и awg0.conf уже есть — обновим compose/NAT и пересоздадим сервис."
      : withTemplate
        ? `Установка на новый VPS (порт ${input.listenPort}, ${input.vpnSubnetCidr}): Docker как на образце.`
        : `Полная установка AmneziaWG (порт ${input.listenPort}, ${input.vpnSubnetCidr}).`,
  });
  log?.info({ totalSteps, reusedContainer: reuseExisting }, "provision_plan");

  if (reuseExisting) {
    dr = await runStep("probe_container", async () => ({
      ok: true,
      detail: "Используется существующий amnezia-awg",
    }));

    /** Иначе после wipe sysctl / нового VPS «reuse»-путь не трогает forwarding — VPN без интернета. */
    dr = await runStep("ip_forward", () => stepEnableIpv4Forward(auth));
    if (!dr.ok) return { ok: false, steps, message: dr.message };

    dr = await runStep("prepare_host", () =>
      stepPrepareNewServerHost(auth, provisionNetwork(input).listenPort, layout, composeYaml),
    );
    if (!dr.ok) return { ok: false, steps, message: dr.message };

    dr = await runStep("write_sidecars", () =>
      stepWriteProvisionSidecars(auth, composeYaml, natScript, layout),
    );
    if (!dr.ok) return { ok: false, steps, message: dr.message };

    dr = await runStep("compose_up", () => stepDockerComposeUp(auth, layout, { forceRecreate: true }));
    if (!dr.ok) return { ok: false, steps, message: dr.message };

    dr = await runStep("resolve_iface", async () => {
      try {
        const iface = await dockerResolveWgIface(auth, layout.containerName, "awg0");
        return { ok: true, detail: iface };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, message: msg };
      }
    });
    if (!dr.ok) return { ok: false, steps, message: dr.message };

    const ifaceRow = steps.find((s) => s.step === "resolve_iface");
    const iface = ifaceRow?.message ?? "awg0";

    dr = await runStep("wait_wg", () =>
      withWaitWgPulse(() => stepWaitWgShow(auth, layout.containerName, iface)),
    );
    if (!dr.ok) return { ok: false, steps, message: dr.message };

    const prefix = await dockerDetectIfaceSlash24Prefix(auth, layout.containerName, iface);
    const cidr = prefix ? `${prefix}.0/24` : provisionNetwork(input).vpnSubnetCidr;

    let serverId: string;
    const saveStart = Date.now();
    stepIndex += 1;
    emit?.({
      event: "step_start",
      step: "save_server",
      label: STEP_LABELS.save_server,
      index: stepIndex,
      total: totalSteps,
      pct: Math.round((100 * (stepIndex - 1)) / totalSteps),
    });
    try {
      serverId = insertVpnServerRecord(adminId, baseInsert(input, cidr, iface, layout));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const fail: StepResult = { ok: false, message: msg };
      push("save_server", fail, Date.now() - saveStart);
      emit?.({
        event: "step_end",
        step: "save_server",
        label: STEP_LABELS.save_server,
        index: stepIndex,
        total: totalSteps,
        ok: false,
        durationMs: Date.now() - saveStart,
        message: msg,
        pct: Math.round((100 * stepIndex) / totalSteps),
      });
      return { ok: false, steps, message: msg };
    }
    push("save_server", { ok: true, detail: serverId }, Date.now() - saveStart);
    emit?.({
      event: "step_end",
      step: "save_server",
      label: STEP_LABELS.save_server,
      index: stepIndex,
      total: totalSteps,
      ok: true,
      durationMs: Date.now() - saveStart,
      message: serverId,
      pct: 100,
    });

    writeAudit(adminId, "server_provision_done", { serverId, reusedContainer: true });
    log?.info({ serverId, reusedContainer: true }, "provision_done");
    return { ok: true, serverId, steps };
  }

  dr = await runStep("ensure_docker", () => stepEnsureDocker(auth));
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  dr = await runStep("ip_forward", () => stepEnableIpv4Forward(auth));
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  dr = await runStep("prepare_host", () =>
    stepPrepareNewServerHost(auth, provisionNetwork(input).listenPort, layout, composeYaml),
  );
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  const { privateKey } = generateWgServerKeypair();
  const awgParams = generateAwgObfuscationParams();
  let awg0Conf: string;
  try {
    awg0Conf = buildAwg0ServerConf({
      serverPrivateKey: privateKey,
      vpnSubnetCidr: provisionNetwork(input).vpnSubnetCidr,
      listenPort: provisionNetwork(input).listenPort,
      awgParams,
      omitPostUp: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, steps, message: msg };
  }
  dr = await runStep("write_files", () =>
    stepWriteProvisionFiles(auth, composeYaml, awg0Conf, natScript, layout),
  );
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  dr = await runStep("compose_up", () => stepDockerComposeUp(auth, layout));
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  dr = await runStep("wait_wg", () =>
    withWaitWgPulse(() => stepWaitWgShow(auth, layout.containerName, "awg0")),
  );
  if (!dr.ok) return { ok: false, steps, message: dr.message };
  const wgIfaceNew = dr.ok && dr.detail ? dr.detail : "awg0";

  let serverId: string;
  const saveStart = Date.now();
  stepIndex += 1;
  emit?.({
    event: "step_start",
    step: "save_server",
    label: STEP_LABELS.save_server,
    index: stepIndex,
    total: totalSteps,
    pct: Math.round((100 * (stepIndex - 1)) / totalSteps),
  });
  try {
    serverId = insertVpnServerRecord(
      adminId,
      baseInsert(input, provisionNetwork(input).vpnSubnetCidr, wgIfaceNew, layout),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const fail: StepResult = { ok: false, message: msg };
    push("save_server", fail, Date.now() - saveStart);
    emit?.({
      event: "step_end",
      step: "save_server",
      label: STEP_LABELS.save_server,
      index: stepIndex,
      total: totalSteps,
      ok: false,
      durationMs: Date.now() - saveStart,
      message: msg,
      pct: Math.round((100 * stepIndex) / totalSteps),
    });
    return { ok: false, steps, message: msg };
  }
  push("save_server", { ok: true, detail: serverId }, Date.now() - saveStart);
  emit?.({
    event: "step_end",
    step: "save_server",
    label: STEP_LABELS.save_server,
    index: stepIndex,
    total: totalSteps,
    ok: true,
    durationMs: Date.now() - saveStart,
    message: serverId,
    pct: 100,
  });

  writeAudit(adminId, "server_provision_done", { serverId, reusedContainer: false });
  log?.info({ serverId, reusedContainer: false }, "provision_done");
  return { ok: true, serverId, steps };
}
