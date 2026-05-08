import { writeAudit } from "../audit.js";
import { insertVpnServerRecord, type VpnServerInsertInput } from "../services/vpnServerInsert.js";
import {
  dockerContainerExists,
  dockerDetectIfaceSlash24Prefix,
  dockerResolveWgIface,
} from "../ssh/client.js";
import type { SshAuth } from "../ssh/client.js";
import {
  buildProvisionComposeYaml,
  PROVISION_COMPOSE_PATH,
  PROVISION_CONTAINER_NAME,
} from "./compose.js";
import { generateAwgObfuscationParams, generateWgServerKeypair } from "./keys.js";
import { buildAwg0ServerConf } from "./serverConf.js";
import {
  type StepResult,
  stepDetectUbuntu,
  stepDockerComposeUp,
  stepEnableIpv4Forward,
  stepEnsureDocker,
  stepWaitWgShow,
  stepWriteProvisionFiles,
} from "./steps.js";

export type ProvisionFormInput = {
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPrivateKey: string;
  sshPassword: string;
  endpointHost: string;
  listenPort: number;
  vpnSubnetCidr: string;
  vlessReality?: VpnServerInsertInput["vlessReality"];
};

export type ProvisionLogStep = { step: string; ok: boolean; message?: string };

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

function baseInsert(input: ProvisionFormInput, vpnSubnetCidr: string): VpnServerInsertInput {
  return {
    name: input.name,
    sshHost: input.sshHost,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
    sshPrivateKey: input.sshPrivateKey,
    sshPassword: input.sshPassword,
    dockerWgContainer: PROVISION_CONTAINER_NAME,
    wgInterface: "awg0",
    vpnSubnetCidr,
    endpointHost: input.endpointHost,
    listenPort: input.listenPort,
    dockerComposePath: PROVISION_COMPOSE_PATH,
    composeServiceName: PROVISION_CONTAINER_NAME,
    portChangeHookCmd: null,
    driverMode: "ssh",
    vlessReality: input.vlessReality,
  };
}

export async function runProvisionAmneziaAwg(
  adminId: string,
  input: ProvisionFormInput,
): Promise<
  { ok: true; serverId: string; steps: ProvisionLogStep[] } | { ok: false; steps: ProvisionLogStep[]; message: string }
> {
  const steps: ProvisionLogStep[] = [];
  const auth = buildSshAuthForProvision(input);

  const push = (step: string, r: StepResult) => {
    steps.push({
      step,
      ok: r.ok,
      ...("message" in r && !r.ok ? { message: r.message } : {}),
      ...("detail" in r && r.ok && r.detail ? { message: r.detail } : {}),
    });
    auditStep(adminId, step, r);
  };

  writeAudit(adminId, "server_provision_start", {
    name: input.name,
    sshHost: input.sshHost,
    sshPort: input.sshPort,
    sshUser: input.sshUser,
  });

  let dr = await stepDetectUbuntu(auth);
  push("detect_os", dr);
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  const exists = await dockerContainerExists(auth, PROVISION_CONTAINER_NAME);
  if (exists) {
    push("container_exists", { ok: true, detail: "Контейнер amnezia-awg уже есть — установка пропущена" });
    let iface = "awg0";
    try {
      iface = await dockerResolveWgIface(auth, PROVISION_CONTAINER_NAME, "awg0");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const fail: StepResult = { ok: false, message: msg };
      push("resolve_iface", fail);
      return { ok: false, steps, message: msg };
    }
    push("resolve_iface", { ok: true, detail: iface });

    const prefix = await dockerDetectIfaceSlash24Prefix(auth, PROVISION_CONTAINER_NAME, iface);
    const cidr = prefix ? `${prefix}.0/24` : input.vpnSubnetCidr;

    const wait = await stepWaitWgShow(auth, PROVISION_CONTAINER_NAME, iface);
    push("wait_wg", wait);
    if (!wait.ok) return { ok: false, steps, message: wait.message };

    const serverId = insertVpnServerRecord(adminId, baseInsert(input, cidr));
    writeAudit(adminId, "server_provision_done", { serverId, reusedContainer: true });
    return { ok: true, serverId, steps };
  }

  dr = await stepEnsureDocker(auth);
  push("ensure_docker", dr);
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  dr = await stepEnableIpv4Forward(auth);
  push("ip_forward", dr);
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  const { privateKey } = generateWgServerKeypair();
  const awgParams = generateAwgObfuscationParams();
  const awg0Conf = buildAwg0ServerConf({
    serverPrivateKey: privateKey,
    vpnSubnetCidr: input.vpnSubnetCidr,
    listenPort: 51820,
    awgParams,
  });
  const composeYaml = buildProvisionComposeYaml(input.listenPort);

  dr = await stepWriteProvisionFiles(auth, composeYaml, awg0Conf);
  push("write_files", dr);
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  dr = await stepDockerComposeUp(auth);
  push("compose_up", dr);
  if (!dr.ok) return { ok: false, steps, message: dr.message };

  const wait = await stepWaitWgShow(auth, PROVISION_CONTAINER_NAME, "awg0");
  push("wait_wg", wait);
  if (!wait.ok) return { ok: false, steps, message: wait.message };

  const serverId = insertVpnServerRecord(adminId, baseInsert(input, input.vpnSubnetCidr));
  writeAudit(adminId, "server_provision_done", { serverId, reusedContainer: false });
  return { ok: true, serverId, steps };
}
