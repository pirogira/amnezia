import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/** Корень монорепо (папка с `apps/`, `packages/`). */
export const repoRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));

export function resolveFromRepo(relativeOrAbsolute: string): string {
  const t = relativeOrAbsolute.trim();
  if (!t) return join(repoRoot, "data", "panel.sqlite");
  return isAbsolute(t) ? normalize(t) : normalize(join(repoRoot, t));
}
