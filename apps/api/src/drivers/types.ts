import type { CreateClientRequest } from "@amnesia-veb/shared";

export type ServerRow = {
  id: string;
  name: string;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_private_key_enc: string;
  /** Зашифрованный SSH-пароль; null/undefined если только ключ. */
  ssh_password_enc?: string | null;
  docker_wg_container: string;
  wg_interface: string;
  vpn_subnet_cidr: string;
  endpoint_host: string;
  listen_port: number;
  docker_compose_path: string | null;
  compose_service_name: string | null;
  port_change_hook_cmd: string | null;
  driver_mode: string;
  /** JSON с полями pbk, sni, sid, fp, spx, type, encryption, security, flow (опц.). */
  vless_reality_json?: string | null;
  created_at: string;
};

export interface VpnDriver {
  createClient(
    server: ServerRow,
    body: CreateClientRequest,
    decryptSshKey: () => string,
    nextIpOctet: number,
  ): Promise<{
    publicKey: string;
    privateKey: string;
    assignedIp: string;
    clientConf: string;
  }>;

  revokeClient(
    server: ServerRow,
    publicKey: string,
    decryptSshKey: () => string,
  ): Promise<void>;
}
