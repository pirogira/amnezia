import type { ServerRow } from "../drivers/types.js";
import { buildSshAuthFromServer } from "../ssh/buildAuth.js";
import { execRemote, SAFE_CONTAINER, shellQuote, type SshAuth } from "../ssh/client.js";
import {
  buildProvisionComposeYamlForHost,
  PROVISION_AWG_DIR,
  PROVISION_COMPOSE_PATH,
} from "./compose.js";
import { assertSafeContainerName, assertSafeHostPath } from "./layout.js";

const DEFAULT_COMPOSE_CANDIDATES = [
  PROVISION_COMPOSE_PATH,
  "/opt/amnesia/docker-compose.yml",
] as const;

const WG_MOUNT_DEST = new Set(["/etc/wireguard", "/etc/amnezia/amneziawg"]);

function trimErr(s: string, max = 200): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function parentDir(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i > 0 ? filePath.slice(0, i) : filePath;
}

/** Каталог awg на хосте по bind-mount контейнера AWG. */
export async function discoverAwgDirFromContainer(
  auth: SshAuth,
  containerName: string,
): Promise<string | null> {
  if (!SAFE_CONTAINER.test(containerName)) return null;
  const cmd = `docker inspect ${shellQuote(containerName)} --format '{{range .Mounts}}{{println .Destination "|" .Source}}{{end}}' 2>/dev/null`;
  const r = await execRemote(auth, cmd);
  if (r.code !== 0 || !r.stdout.trim()) return null;
  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const sep = t.indexOf("|");
    if (sep < 0) continue;
    const dest = t.slice(0, sep).trim();
    const src = t.slice(sep + 1).trim();
    if (!WG_MOUNT_DEST.has(dest) || !src) continue;
    try {
      return assertSafeHostPath(src, "awgDir");
    } catch {
      continue;
    }
  }
  return null;
}

async function tryReadCompose(
  auth: SshAuth,
  composePath: string,
): Promise<string | null> {
  const r = await execRemote(auth, `cat ${shellQuote(composePath)}`);
  if (r.code === 0 && r.stdout.trim()) return r.stdout;
  return null;
}

/**
 * Ищет docker-compose.yml на сервере-образце: явный путь в БД, рядом с awg из docker inspect,
 * стандартные /opt/amnezia и /opt/amnesia.
 */
export async function discoverComposeOnReferenceServer(reference: ServerRow): Promise<{
  composePath: string;
  composeYaml: string;
  awgDir: string;
}> {
  const auth = buildSshAuthFromServer(reference);
  const container = reference.docker_wg_container?.trim() || "";
  const awgFromMount = container ? await discoverAwgDirFromContainer(auth, container) : null;

  const candidates: string[] = [];
  const explicit = reference.docker_compose_path?.trim();
  if (explicit) candidates.push(explicit);
  if (awgFromMount) {
    candidates.push(`${parentDir(awgFromMount)}/docker-compose.yml`);
  }
  for (const p of DEFAULT_COMPOSE_CANDIDATES) {
    if (!candidates.includes(p)) candidates.push(p);
  }

  const errors: string[] = [];
  for (const composePath of candidates) {
    const yaml = await tryReadCompose(auth, composePath);
    if (yaml) {
      const awgDir = awgFromMount ?? PROVISION_AWG_DIR;
      return { composePath, composeYaml: yaml, awgDir };
    }
    const probe = await execRemote(auth, `test -f ${shellQuote(composePath)}; echo $?`);
    errors.push(
      `${composePath}: ${probe.code === 0 ? "пустой или недоступен" : trimErr(probe.stderr || "нет файла")}`,
    );
  }

  if (awgFromMount && container && SAFE_CONTAINER.test(container)) {
    const imgR = await execRemote(
      auth,
      `docker inspect ${shellQuote(container)} --format '{{.Config.Image}}' 2>/dev/null`,
    );
    const image = imgR.code === 0 ? imgR.stdout.trim() : "";
    if (image) {
      const composePath = `${parentDir(awgFromMount)}/docker-compose.yml`;
      return {
        composePath,
        composeYaml: buildProvisionComposeYamlForHost({
          awgDir: awgFromMount,
          containerName: assertSafeContainerName(container),
          image,
        }),
        awgDir: awgFromMount,
      };
    }
  }

  const hint = awgFromMount
    ? `Каталог AWG на образце: ${awgFromMount}. Задайте docker_compose_path в панели или положите compose в ${parentDir(awgFromMount)}/.`
    : "Проверьте, что контейнер AWG запущен и есть /opt/amnezia или /opt/amnesia.";
  throw new Error(
    `Не найден docker-compose.yml на образце. Пробовали: ${candidates.join(", ")}. ${hint}`,
  );
}
