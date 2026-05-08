/**
 * Официальный образ на Docker Hub: `amneziavpn/amnezia-wg` (тег `amnezia-awg` как репозиторий на Hub нет).
 * Пин по digest для воспроизводимости; обновляйте при смене образа.
 */
export const AMNEZIA_WG_IMAGE = "amneziavpn/amnezia-wg@sha256:ea050861bd2012a6265817636ce7c0c15764ef955782d953cef42e05c1381250";

export const PROVISION_COMPOSE_PATH = "/opt/amnezia/docker-compose.yml";
export const PROVISION_AWG_DIR = "/opt/amnezia/awg";
export const PROVISION_AWG_CONF = `${PROVISION_AWG_DIR}/awg0.conf`;
export const PROVISION_CONTAINER_NAME = "amnezia-awg";

export function buildProvisionComposeYaml(): string {
  /**
   * `network_mode: host` — интерфейс awg0 и выход в интернет в одном netns с VPS; иначе NAT в
   * bridge-контейнере часто не даёт клиентам реальный выход в сеть.
   * После `*-quick up` нужен долгоживущий PID 1: `wg-quick` сразу завершается — без `tail`
   * контейнер выходит; `trap` на SIGTERM/SIGINT вызывает `*-quick down`, чтобы не оставлять
   * правила iptables на хосте.
   */
  return `services:
  ${PROVISION_CONTAINER_NAME}:
    image: ${AMNEZIA_WG_IMAGE}
    container_name: ${PROVISION_CONTAINER_NAME}
    network_mode: host
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun
    sysctls:
      - net.ipv4.ip_forward=1
    volumes:
      - ${PROVISION_AWG_DIR}:/etc/wireguard
    command:
      - /bin/sh
      - -c
      - "trap 'wg-quick down awg0 2>/dev/null; awg-quick down awg0 2>/dev/null; exit 0' TERM INT; if command -v awg-quick >/dev/null 2>&1; then awg-quick up awg0; else wg-quick up awg0; fi; tail -f /dev/null"
    restart: unless-stopped
`;
}
