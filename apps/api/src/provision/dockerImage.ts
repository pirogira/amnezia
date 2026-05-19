import { AMNEZIA_WG_IMAGE } from "./compose.js";
import { extractImageFromCompose } from "./layout.js";
import { execRemote, shellQuote, type SshAuth } from "../ssh/client.js";

/** Локальные/служебные теги Docker, не существующие на Hub. */
const NON_PULLABLE_IMAGE = /^(?:amnezia-awg\d*|amnezia-wireguard|amnezia-wg)(?::.*)?$/i;

/**
 * Образ для `docker pull` на новом VPS: локальные теги вроде `amnezia-awg2` (имя контейнера) не тянутся с Hub.
 */
export function resolvePullableDockerImage(
  raw: string | null | undefined,
  opts?: { containerName?: string },
): string {
  const t = (raw ?? "").trim();
  if (!t) return AMNEZIA_WG_IMAGE;
  if (opts?.containerName && t === opts.containerName) return AMNEZIA_WG_IMAGE;
  if (NON_PULLABLE_IMAGE.test(t)) return AMNEZIA_WG_IMAGE;
  if (t.startsWith("sha256:")) return t;
  if (t.includes("@sha256:")) return t;
  if (!t.includes("/")) return AMNEZIA_WG_IMAGE;
  return t;
}

/** Подменяет `image:` в compose на образ, который можно pull с Hub. */
export function normalizeProvisionComposeYaml(
  composeYaml: string,
  opts?: { containerName?: string; preferImage?: string },
): string {
  const current = extractImageFromCompose(composeYaml);
  const pullImage = resolvePullableDockerImage(opts?.preferImage ?? current, opts);
  if (current === pullImage) return composeYaml;
  return composeYaml.replace(/^(\s+image:\s*)\S+\s*$/m, `$1${pullImage}`);
}

/** Образ контейнера: RepoDigest → Config.Image → image inspect по ID. */
export async function inspectPullableContainerImage(
  auth: SshAuth,
  containerName: string,
): Promise<string> {
  const script = `set -eu
c=${shellQuote(containerName)}
iid=$(docker inspect "$c" --format '{{.Image}}' 2>/dev/null || true)
if [ -n "$iid" ]; then
  rd=$(docker image inspect "$iid" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null || true)
  if [ -n "$rd" ]; then echo "$rd"; exit 0; fi
  rt=$(docker image inspect "$iid" --format '{{if .RepoTags}}{{index .RepoTags 0}}{{end}}' 2>/dev/null || true)
  if [ -n "$rt" ]; then echo "$rt"; exit 0; fi
fi
docker inspect "$c" --format '{{.Config.Image}}' 2>/dev/null || true`;
  const r = await execRemote(auth, `bash -lc ${shellQuote(script)}`);
  const raw = r.stdout.trim().split("\n")[0]?.trim() ?? "";
  return resolvePullableDockerImage(raw, { containerName });
}
