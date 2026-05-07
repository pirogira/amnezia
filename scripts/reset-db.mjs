import { existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  join(root, "data", "panel.sqlite"),
  join(root, "apps", "api", "data", "panel.sqlite"),
];

let removed = 0;
for (const p of candidates) {
  if (existsSync(p)) {
    rmSync(p);
    console.log("[db:reset] удалён", p);
    removed++;
  }
}
if (!removed) console.log("[db:reset] файлы БД не найдены (уже чисто).");
console.log("[db:reset] Перезапустите API; при следующем старте создастся админ из PANEL_BOOTSTRAP_* в .env");
