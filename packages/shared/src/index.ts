/** Expected VPS layout for SSH driver (adjust in panel DB / env). */
export const DEFAULT_WG_INTERFACE = "wg0";

export type VpnProtocol = "amneziawg" | "wireguard" | "openvpn" | "cloak" | "vless";

export interface SecurityProfile {
  /** AmneziaWG-style junk/init tuning; passed to server hooks or stored for export-only until hooks apply. */
  junkPacketCount?: number;
  junkPacketMinSize?: number;
  junkPacketMaxSize?: number;
  initPacketJunkSize?: number;
  responsePacketJunkSize?: number;
  /** Optional preshared key for WireGuard peer (if server supports). */
  presharedKey?: string;
  dns?: string;
  /** Явно включить маршрут ::/0 (нужен рабочий IPv6/NAT на сервере). По умолчанию только 0.0.0.0/0. */
  includeIpv6DefaultRoute?: boolean;
  /** MTU [Interface]; для AmneziaWG без значения подставляется 1280 (накладные расходы протокола). */
  mtu?: number;
}

export interface CreateClientRequest {
  name: string;
  protocol: VpnProtocol;
  /** Listen port shown in client config (endpoint). */
  listenPort: number;
  security: SecurityProfile;
  /** Optional expiry ISO date */
  expiresAt?: string | null;
}

export interface ClientRecord {
  id: string;
  serverId: string;
  name: string;
  protocol: VpnProtocol;
  publicKey: string;
  assignedIp: string;
  listenPort: number;
  securityJson: string;
  endpointHost: string;
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ServerRecord {
  id: string;
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  /** Docker container name running WireGuard tools (wg, wg-quick). */
  dockerWgContainer: string;
  /** WireGuard interface inside container. */
  wgInterface: string;
  /** VPN subnet for assigning /32 to peers, e.g. 10.8.0.0/24 */
  vpnSubnetCidr: string;
  /** Public hostname or IP clients connect to. */
  endpointHost: string;
  /** Path on VPS for docker compose (optional, port-change flow). */
  dockerComposePath: string | null;
  /** Service name inside compose file (optional). */
  composeServiceName: string | null;
  createdAt: string;
}
