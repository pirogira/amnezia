import {
  PROVISION_AWG_CONF,
  PROVISION_AWG_DIR,
  PROVISION_COMPOSE_PATH,
  PROVISION_CONTAINER_NAME,
} from "./compose.js";

/** Пути и имена AWG на целевом VPS (стандарт панели или как на сервере-образце). */
export type AwgHostLayout = {
  composePath: string;
  awgDir: string;
  awgConfPath: string;
  containerName: string;
  composeServiceName: string;
};

export const DEFAULT_AWG_LAYOUT: AwgHostLayout = {
  composePath: PROVISION_COMPOSE_PATH,
  awgDir: PROVISION_AWG_DIR,
  awgConfPath: PROVISION_AWG_CONF,
  containerName: PROVISION_CONTAINER_NAME,
  composeServiceName: PROVISION_CONTAINER_NAME,
};

const SAFE_ABS_PATH = /^\/opt\/amnezia\/[a-zA-Z0-9._/-]+$/;
const SAFE_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function assertSafeHostPath(p: string, label: string): string {
  if (!SAFE_ABS_PATH.test(p)) throw new Error(`Недопустимый путь ${label}: ${p}`);
  return p;
}

export function assertSafeContainerName(n: string): string {
  if (!SAFE_CONTAINER_NAME.test(n)) throw new Error(`Недопустимое имя контейнера: ${n}`);
  return n;
}

/** Разбор docker-compose.yml с рабочего сервера. */
export function parseAwgLayoutFromCompose(composeYaml: string, hints?: Partial<AwgHostLayout>): AwgHostLayout {
  const containerFromYaml =
    /container_name:\s*(\S+)/m.exec(composeYaml)?.[1] ??
    /^\s{2}(\S+):\s*$/m.exec(composeYaml)?.[1];
  const vol =
    /-\s*(\/opt\/amnezia\/[^\s:]+):\/etc\/wireguard/m.exec(composeYaml)?.[1] ??
    /-\s*(\/opt\/amnezia\/[^\s:]+):\/etc\/amnezia\/amneziawg/m.exec(composeYaml)?.[1];
  const awgDir = assertSafeHostPath(vol ?? hints?.awgDir ?? PROVISION_AWG_DIR, "awgDir");
  const containerName = assertSafeContainerName(
    hints?.containerName ?? containerFromYaml ?? PROVISION_CONTAINER_NAME,
  );
  const composePath = hints?.composePath ?? PROVISION_COMPOSE_PATH;
  return {
    composePath,
    awgDir,
    awgConfPath: `${awgDir}/awg0.conf`,
    containerName,
    composeServiceName: hints?.composeServiceName ?? containerName,
  };
}

export function extractImageFromCompose(composeYaml: string): string | null {
  const m = /^\s*image:\s*(\S+)\s*$/m.exec(composeYaml);
  return m?.[1] ?? null;
}
