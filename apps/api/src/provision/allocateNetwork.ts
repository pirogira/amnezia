import { randomInt } from "node:crypto";
import { getDb } from "../db.js";

const SUBNET_PREFIX = "10.8.";
const PORT_TRY_MIN = 30_000;
const PORT_TRY_MAX = 65_000;
const PORT_SCAN_START = 51_820;

export type AllocatedProvisionNetwork = {
  listenPort: number;
  vpnSubnetCidr: string;
};

/**
 * Свободные listen_port и подсеть 10.8.N.0/24 среди серверов в панели (без пересечений).
 */
export function allocateProvisionNetwork(): AllocatedProvisionNetwork {
  const rows = getDb()
    .prepare(`SELECT listen_port, vpn_subnet_cidr FROM vpn_servers`)
    .all() as { listen_port: number; vpn_subnet_cidr: string }[];

  const usedPorts = new Set(rows.map((r) => r.listen_port));
  const usedThird = new Set<number>();
  for (const r of rows) {
    const m = /^10\.8\.(\d+)\.0\/24$/.exec(r.vpn_subnet_cidr);
    if (m) usedThird.add(Number(m[1]));
  }

  let third = 0;
  while (third <= 254 && usedThird.has(third)) third += 1;
  if (third > 254) {
    throw new Error("Закончились подсети 10.8.0.0/24–10.8.254.0/24 в панели");
  }
  const vpnSubnetCidr = `${SUBNET_PREFIX}${third}.0/24`;

  for (let attempt = 0; attempt < 80; attempt++) {
    const p = randomInt(PORT_TRY_MIN, PORT_TRY_MAX + 1);
    if (!usedPorts.has(p)) {
      return { listenPort: p, vpnSubnetCidr };
    }
  }
  for (let p = PORT_SCAN_START; p <= 65_535; p++) {
    if (!usedPorts.has(p)) {
      return { listenPort: p, vpnSubnetCidr };
    }
  }
  throw new Error("Не удалось подобрать свободный UDP-порт для AWG");
}
