/**
 * Официальный образ на Docker Hub: `amneziavpn/amnezia-wg` (тег `amnezia-awg` как репозиторий на Hub нет).
 * Пин по digest для воспроизводимости; обновляйте при смене образа.
 */
export const AMNEZIA_WG_IMAGE = "amneziavpn/amnezia-wg@sha256:ea050861bd2012a6265817636ce7c0c15764ef955782d953cef42e05c1381250";

export const PROVISION_COMPOSE_PATH = "/opt/amnezia/docker-compose.yml";
export const PROVISION_AWG_DIR = "/opt/amnezia/awg";
export const PROVISION_AWG_CONF = `${PROVISION_AWG_DIR}/awg0.conf`;
export const PROVISION_CONTAINER_NAME = "amnezia-awg";

export function buildProvisionComposeYaml(hostListenPort: number): string {
  /** Как в типичных WG-образах: конфиг в /etc/wireguard → `awg-quick up awg0`. */
  return `services:
  ${PROVISION_CONTAINER_NAME}:
    image: ${AMNEZIA_WG_IMAGE}
    container_name: ${PROVISION_CONTAINER_NAME}
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun
    sysctls:
      - net.ipv4.ip_forward=1
    volumes:
      - ${PROVISION_AWG_DIR}:/etc/wireguard
    ports:
      - "${hostListenPort}:51820/udp"
    command:
      - /bin/sh
      - -c
      - "if command -v awg-quick >/dev/null 2>&1; then awg-quick up awg0; else wg-quick up awg0; fi"
    restart: unless-stopped
`;
}
