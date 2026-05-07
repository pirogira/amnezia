/**
 * Ждёт готовности API (после freeports/restart), чтобы Vite не ловил ECONNREFUSED на прокси.
 * Порт из PANEL_API_PORT или 3001.
 */
const port = process.env.PANEL_API_PORT || "3001";
const url = `http://127.0.0.1:${port}/api/health`;
const deadline = Date.now() + 120_000;
const interval = 300;

async function once() {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return res.ok;
}

while (Date.now() < deadline) {
  try {
    if (await once()) {
      console.log(`[wait-api] OK ${url}`);
      process.exit(0);
    }
  } catch {
    /* retry */
  }
  await new Promise((r) => setTimeout(r, interval));
}
console.error(`[wait-api] timeout waiting for ${url}`);
process.exit(1);
