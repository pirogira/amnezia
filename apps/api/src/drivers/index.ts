import { mockDriver } from "./mockDriver.js";
import { sshWgDriver } from "./sshWgDriver.js";
import type { ServerRow, VpnDriver } from "./types.js";

export function getDriver(server: ServerRow): VpnDriver {
  if (server.driver_mode === "mock") return mockDriver;
  return sshWgDriver;
}
