import type { ServerRow } from "../drivers/types.js";
import { buildSshAuthFromServer } from "../ssh/buildAuth.js";
import { discoverWgDockerOnHost } from "../ssh/discoverWgDocker.js";
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

const KNOWN_AWG0_CONF = [
  "/opt/amnezia/awg/awg0.conf",
  "/opt/amnesia/awg/awg0.conf",
] as const;

const FIND_ROOTS = "/opt /root /home /srv /var/lib";

function trimErr(s: string, max = 200): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function parentDir(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i > 0 ? filePath.slice(0, i) : filePath;
}

function isWgRelatedMountDest(dest: string): boolean {
  const d = dest.toLowerCase();
  return (
    d.includes("wireguard") ||
    d.includes("amneziawg") ||
    d.includes("amnezia/wg") ||
    d === "/etc/wireguard" ||
    d.startsWith("/etc/wireguard/")
  );
}

function awgDirFromMountSource(src: string, dest: string): string | null {
  const s = src.replace(/\/+$/, "");
  if (s.endsWith("/awg0.conf") || s.endsWith("awg0.conf")) return parentDir(s);
  if (s.endsWith("/awg") || /\/awg$/i.test(s)) return s;
  if (isWgRelatedMountDest(dest)) return s;
  return null;
}

function safePathOrNull(p: string): string | null {
  try {
    return assertSafeHostPath(p.trim(), "path");
  } catch {
    return null;
  }
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
    if (!src || !isWgRelatedMountDest(dest)) continue;
    const dir = awgDirFromMountSource(src, dest);
    if (!dir) continue;
    const safe = safePathOrNull(dir);
    if (safe) return safe;
  }
  return null;
}

async function listDockerContainerNames(auth: SshAuth): Promise<string[]> {
  const r = await execRemote(auth, "docker ps -a --format '{{.Names}}'");
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((n) => n.trim())
    .filter((n) => SAFE_CONTAINER.test(n));
}

/** Первый подходящий AWG-контейнер и каталог с хоста. */
async function discoverAwgFromAnyContainer(
  auth: SshAuth,
  prefer?: string,
): Promise<{ containerName: string; awgDir: string; image: string } | null> {
  const names = await listDockerContainerNames(auth);
  const rest = names
    .filter((n) => n !== prefer)
    .sort((a, b) => scoreContainerName(b) - scoreContainerName(a));
  const ordered = prefer && names.includes(prefer) ? [prefer, ...rest] : rest;

  for (const name of ordered) {
    const awgDir = await discoverAwgDirFromContainer(auth, name);
    if (!awgDir) continue;
    const imgR = await execRemote(
      auth,
      `docker inspect ${shellQuote(name)} --format '{{.Config.Image}}' 2>/dev/null`,
    );
    const image = imgR.code === 0 ? imgR.stdout.trim() : "";
    if (!image) continue;
    return { containerName: name, awgDir, image };
  }
  return null;
}

function scoreContainerName(name: string): number {
  const n = name.toLowerCase();
  let s = 0;
  if (/amnezia|awg/.test(n)) s += 20;
  if (/wireguard|wg/.test(n)) s += 8;
  return s;
}

async function discoverComposePathsFromLabels(
  auth: SshAuth,
  containerName: string,
): Promise<string[]> {
  if (!SAFE_CONTAINER.test(containerName)) return [];
  const out: string[] = [];
  const cfgR = await execRemote(
    auth,
    `docker inspect ${shellQuote(containerName)} --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' 2>/dev/null`,
  );
  if (cfgR.code === 0 && cfgR.stdout.trim()) {
    for (const part of cfgR.stdout.split(",")) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }
  const wdR = await execRemote(
    auth,
    `docker inspect ${shellQuote(containerName)} --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null`,
  );
  if (wdR.code === 0 && wdR.stdout.trim()) {
    const wd = wdR.stdout.trim();
    out.push(`${wd}/docker-compose.yml`, `${wd}/compose.yml`);
  }
  return out;
}

async function discoverPathsViaFind(auth: SshAuth): Promise<{
  composePaths: string[];
  awgDirs: string[];
}> {
  const script = `find ${FIND_ROOTS} -maxdepth 7 \\( -name 'docker-compose.y*ml' -o -name 'compose.y*ml' -o -name 'awg0.conf' \\) 2>/dev/null | head -30`;
  const r = await execRemote(auth, `bash -lc ${shellQuote(script)}`);
  if (r.code !== 0) return { composePaths: [], awgDirs: [] };
  const composePaths: string[] = [];
  const awgDirs: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const p = line.trim();
    if (!p) continue;
    const safe = safePathOrNull(p);
    if (!safe) continue;
    if (safe.endsWith("awg0.conf")) {
      const dir = safePathOrNull(parentDir(safe));
      if (dir) awgDirs.push(dir);
    } else if (/compose\.ya?ml$/i.test(safe)) {
      composePaths.push(safe);
    }
  }
  return { composePaths, awgDirs };
}

async function discoverAwgDirFromKnownConf(auth: SshAuth): Promise<string | null> {
  for (const conf of KNOWN_AWG0_CONF) {
    const r = await execRemote(auth, `test -f ${shellQuote(conf)} && echo ok`);
    if (r.stdout.includes("ok")) {
      const dir = safePathOrNull(parentDir(conf));
      if (dir) return dir;
    }
  }
  const { awgDirs } = await discoverPathsViaFind(auth);
  return awgDirs[0] ?? null;
}

async function tryReadCompose(auth: SshAuth, composePath: string): Promise<string | null> {
  const r = await execRemote(auth, `cat ${shellQuote(composePath)}`);
  if (r.code === 0 && r.stdout.trim()) return r.stdout;
  return null;
}

function preferComposePath(paths: string[]): string[] {
  const score = (p: string) => {
    const l = p.toLowerCase();
    let s = 0;
    if (l.includes("amnezia")) s += 10;
    if (l.includes("amnesia")) s += 8;
    if (l.includes("/awg/")) s += 5;
    if (l.includes("/opt/")) s += 2;
    return s;
  };
  return [...paths].sort((a, b) => score(b) - score(a));
}

function synthesizeFromHost(
  containerName: string,
  awgDir: string,
  image: string,
): { composePath: string; composeYaml: string; awgDir: string } {
  const composePath = `${parentDir(awgDir)}/docker-compose.yml`;
  return {
    composePath,
    composeYaml: buildProvisionComposeYamlForHost({
      awgDir,
      containerName: assertSafeContainerName(containerName),
      image,
    }),
    awgDir,
  };
}

/**
 * Ищет docker-compose.yml на сервере-образце: БД, docker labels, mount, find, wg discover.
 */
export async function discoverComposeOnReferenceServer(reference: ServerRow): Promise<{
  composePath: string;
  composeYaml: string;
  awgDir: string;
}> {
  const auth = buildSshAuthFromServer(reference);
  let container = reference.docker_wg_container?.trim() || "";
  let awgFromMount = container ? await discoverAwgDirFromContainer(auth, container) : null;
  let imageFromDocker = "";

  if (!awgFromMount) {
    const any = await discoverAwgFromAnyContainer(auth, container || undefined);
    if (any) {
      container = any.containerName;
      awgFromMount = any.awgDir;
      imageFromDocker = any.image;
    }
  }

  if (!awgFromMount) {
    awgFromMount = await discoverAwgDirFromKnownConf(auth);
  }

  if (!container || !imageFromDocker) {
    const disc = await discoverWgDockerOnHost(auth);
    if (disc.ok) {
      if (!container) container = disc.dockerWgContainer;
      if (!imageFromDocker) imageFromDocker = disc.image;
      if (!awgFromMount) {
        awgFromMount = await discoverAwgDirFromContainer(auth, disc.dockerWgContainer);
      }
    }
  }

  if (container && !imageFromDocker && SAFE_CONTAINER.test(container)) {
    const imgR = await execRemote(
      auth,
      `docker inspect ${shellQuote(container)} --format '{{.Config.Image}}' 2>/dev/null`,
    );
    if (imgR.code === 0) imageFromDocker = imgR.stdout.trim();
  }

  const candidates: string[] = [];
  const explicit = reference.docker_compose_path?.trim();
  if (explicit) candidates.push(explicit);
  if (container) {
    for (const p of await discoverComposePathsFromLabels(auth, container)) {
      if (!candidates.includes(p)) candidates.push(p);
    }
  }
  if (awgFromMount) {
    const near = `${parentDir(awgFromMount)}/docker-compose.yml`;
    if (!candidates.includes(near)) candidates.push(near);
  }
  const found = await discoverPathsViaFind(auth);
  for (const p of preferComposePath(found.composePaths)) {
    if (!candidates.includes(p)) candidates.push(p);
  }
  for (const p of DEFAULT_COMPOSE_CANDIDATES) {
    if (!candidates.includes(p)) candidates.push(p);
  }

  for (const composePath of candidates) {
    const safeCompose = safePathOrNull(composePath);
    if (!safeCompose) continue;
    const yaml = await tryReadCompose(auth, safeCompose);
    if (yaml) {
      const awgDir = awgFromMount ?? found.awgDirs[0] ?? PROVISION_AWG_DIR;
      return { composePath: safeCompose, composeYaml: yaml, awgDir };
    }
  }

  const awgDir =
    awgFromMount ?? found.awgDirs[0] ?? (await discoverAwgDirFromKnownConf(auth));
  if (awgDir && container && imageFromDocker && SAFE_CONTAINER.test(container)) {
    return synthesizeFromHost(container, awgDir, imageFromDocker);
  }

  if (awgDir && imageFromDocker) {
    const name = container && SAFE_CONTAINER.test(container) ? container : "amnezia-awg";
    return synthesizeFromHost(name, awgDir, imageFromDocker);
  }

  const hint = container
    ? `Контейнер в панели: ${container}. awg-каталог: ${awgDir ?? "не найден"}.`
    : "В панели не найден рабочий AWG-контейнер (docker ps).";
  throw new Error(
    `Не найден docker-compose.yml на образце. Пробовали: ${candidates.slice(0, 12).join(", ")}${candidates.length > 12 ? "…" : ""}. ${hint}`,
  );
}
