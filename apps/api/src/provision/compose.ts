/**
 * Официальный образ AmneziaWG (userspace + awg-quick): `amneziavpn/amneziawg-go` на Docker Hub.
 * Содержит amneziawg-tools с поддержкой S3/S4 (AmneziaWG 2.0); старый `amneziavpn/amnezia-wg` без тегов 2.0 не использовать.
 * Пин по digest индекса (multi-arch); обновляйте при смене образа: `docker buildx imagetools inspect amneziavpn/amneziawg-go:latest`.
 */
export const AMNEZIA_WG_IMAGE =
  "amneziavpn/amneziawg-go@sha256:cb91bdd8f3c8c586ae2bdf93374b58899c778756fe8b37a3c0506f9e611092f3";

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
   * Не задавать sysctls здесь: при network_mode: host runc отклоняет net.ipv4.ip_forward.
   * Включение forwarding на VPS делает stepEnableIpv4Forward до compose up.
   * `pid: host` — PID 1 это init хоста; panel-nat.sh вызывает iptables через `nsenter -t 1 -m`
   * (mount-ns хоста), иначе бинарь из образа пишет в nft, а Docker — в legacy.
   * `privileged: true` — иначе на Ubuntu Docker часто `Permission denied` на `/proc/1/ns/mnt`
   * (AppArmor/политика), даже при CAP_SYS_ADMIN.
   */
  /** Два mount: явный путь `/etc/wireguard/…` и путь amneziawg-tools для `awg-quick up awg0` → `/etc/amnezia/amneziawg/awg0.conf`. */
  const awgConfInContainer = "/etc/wireguard/awg0.conf";
  return `services:
  ${PROVISION_CONTAINER_NAME}:
    image: ${AMNEZIA_WG_IMAGE}
    container_name: ${PROVISION_CONTAINER_NAME}
    network_mode: host
    pid: host
    privileged: true
    environment:
      WG_QUICK_USERSPACE_IMPLEMENTATION: /usr/bin/amneziawg-go
    devices:
      - /dev/net/tun
    volumes:
      - ${PROVISION_AWG_DIR}:/etc/wireguard
      - ${PROVISION_AWG_DIR}:/etc/amnezia/amneziawg
    command:
      - /bin/sh
      - -c
      - "trap 'wg-quick down ${awgConfInContainer} 2>/dev/null; awg-quick down ${awgConfInContainer} 2>/dev/null; exit 0' TERM INT; if command -v awg-quick >/dev/null 2>&1; then awg-quick up ${awgConfInContainer}; else wg-quick up ${awgConfInContainer}; fi; tail -f /dev/null"
    restart: unless-stopped
`;
}
