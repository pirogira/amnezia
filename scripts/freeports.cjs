/* eslint-disable no-console */
const killPort = require("kill-port");

async function main() {
  for (const port of [5173, 3001]) {
    try {
      await killPort(port);
      console.log(`[freeports] freed TCP ${port}`);
    } catch {
      /* nothing listening */
    }
  }
}

main().catch(() => process.exit(0));
