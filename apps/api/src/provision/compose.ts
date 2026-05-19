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

/**
 * `network_mode: host` — интерфейс awg0 и выход в интернет в одном netns с VPS.
 * `pid: host` + panel-nat.sh через nsenter — iptables в legacy на хосте.
 */
export function buildProvisionComposeYamlForHost(opts: {
  awgDir: string;
  containerName: string;
  image?: string;
}): string {
  const image = opts.image?.trim() || AMNEZIA_WG_IMAGE;
  const awgDir = opts.awgDir;
  const containerName = opts.containerName;
  const awgConfInContainer = "/etc/wireguard/awg0.conf";
  return `services:
  ${containerName}:
    image: ${image}
    container_name: ${containerName}
    network_mode: host
    pid: host
    privileged: true
    environment:
      WG_QUICK_USERSPACE_IMPLEMENTATION: /usr/bin/amneziawg-go
    devices:
      - /dev/net/tun
    volumes:
      - ${awgDir}:/etc/wireguard
      - ${awgDir}:/etc/amnezia/amneziawg
    command:
      - /bin/sh
      - -c
      - "trap 'wg-quick down ${awgConfInContainer} 2>/dev/null; awg-quick down ${awgConfInContainer} 2>/dev/null; exit 0' TERM INT; if command -v awg-quick >/dev/null 2>&1; then awg-quick up ${awgConfInContainer}; else wg-quick up ${awgConfInContainer}; fi; tail -f /dev/null"
    restart: unless-stopped
`;
}

export function buildProvisionComposeYaml(): string {
  return buildProvisionComposeYamlForHost({
    awgDir: PROVISION_AWG_DIR,
    containerName: PROVISION_CONTAINER_NAME,
  });
}

/** Compose для записи на целевой VPS (всегда Hub-образ панели, без локальных тегов образца). */
export function buildTargetHostComposeYaml(layout: {
  awgDir: string;
  containerName: string;
}): string {
  return buildProvisionComposeYamlForHost({
    awgDir: layout.awgDir,
    containerName: layout.containerName,
    image: AMNEZIA_WG_IMAGE,
  });
}
