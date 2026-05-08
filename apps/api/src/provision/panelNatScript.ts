/** Имя в каталоге awg на хосте и в `/etc/wireguard` внутри контейнера. */
export const PANEL_WG_NAT_SCRIPT_BASENAME = "panel-nat.sh";

/**
 * PostUp/PostDown для awg0.conf: вызывается из контейнера с network_mode host + pid host.
 * FORWARD / DOCKER-USER — **iptables-legacy** (как у Docker на Ubuntu).
 * MASQUERADE — **`iptables` (nf_tables)** : иначе SNAT в «legacy» не считается, трафик 10.8.x
 * уходит без NAT (см. nft POSTROUTING только для 172.17/18).
 * Дубликат для curl: `scripts/panel-nat.sh`.
 */
export function buildPanelWgNatScript(): string {
  return [
    "#!/bin/sh",
    "# amnesia-veb: NAT и FORWARD для клиентов VPN.",
    "# Требуется compose: network_mode host, pid host, privileged (доступ /proc/1/ns/mnt для nsenter).",
    "set -eu",
    "ACTION=${1:?}",
    "IFACE=${2:?}",
    "SUBNET=${3:?}",
    "",
    "# Хостовый iptables-legacy (filter FORWARD, DOCKER-USER).",
    "run_ipt() {",
    "  if command -v nsenter >/dev/null 2>&1 && nsenter -t 1 -m test -x /usr/sbin/iptables-legacy 2>/dev/null; then",
    "    nsenter -t 1 -m -- /usr/sbin/iptables-legacy \"$@\"",
    "    return",
    "  fi",
    "  if command -v nsenter >/dev/null 2>&1 && nsenter -t 1 -m test -x /sbin/iptables-legacy 2>/dev/null; then",
    "    nsenter -t 1 -m -- /sbin/iptables-legacy \"$@\"",
    "    return",
    "  fi",
    "  if command -v iptables-legacy >/dev/null 2>&1; then",
    "    iptables-legacy \"$@\"",
    "    return",
    "  fi",
    "  iptables \"$@\"",
    "}",
    "",
    "# Хостовый iptables (nf_tables) — таблица nat / POSTROUTING, куда реально попадает SNAT с Docker.",
    "run_ipt_nft() {",
    "  if command -v nsenter >/dev/null 2>&1 && nsenter -t 1 -m test -x /usr/sbin/iptables 2>/dev/null; then",
    "    nsenter -t 1 -m -- /usr/sbin/iptables \"$@\"",
    "    return",
    "  fi",
    "  iptables \"$@\"",
    "}",
    "",
    'case "$ACTION" in',
    "up)",
    '  sysctl -w "net.ipv4.conf.$IFACE.rp_filter=0" 2>/dev/null || true',
    '  run_ipt -C FORWARD -i "$IFACE" -j ACCEPT 2>/dev/null || run_ipt -I FORWARD 1 -i "$IFACE" -j ACCEPT',
    '  run_ipt -C FORWARD -o "$IFACE" -j ACCEPT 2>/dev/null || run_ipt -I FORWARD 1 -o "$IFACE" -j ACCEPT',
    '  run_ipt -C DOCKER-USER -i "$IFACE" -j RETURN 2>/dev/null || run_ipt -I DOCKER-USER 1 -i "$IFACE" -j RETURN 2>/dev/null || true',
    '  run_ipt -C DOCKER-USER -o "$IFACE" -j RETURN 2>/dev/null || run_ipt -I DOCKER-USER 1 -o "$IFACE" -j RETURN 2>/dev/null || true',
    '  run_ipt_nft -t nat -C POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2>/dev/null || run_ipt_nft -t nat -I POSTROUTING 1 -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE',
    "  ;;",
    "down)",
    '  while run_ipt_nft -t nat -D POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2>/dev/null; do :; done',
    '  while run_ipt -t nat -D POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2>/dev/null; do :; done',
    '  while run_ipt -D DOCKER-USER -o "$IFACE" -j RETURN 2>/dev/null; do :; done',
    '  while run_ipt -D DOCKER-USER -i "$IFACE" -j RETURN 2>/dev/null; do :; done',
    '  while run_ipt -D FORWARD -o "$IFACE" -j ACCEPT 2>/dev/null; do :; done',
    '  while run_ipt -D FORWARD -i "$IFACE" -j ACCEPT 2>/dev/null; do :; done',
    '  sysctl -w "net.ipv4.conf.$IFACE.rp_filter=2" 2>/dev/null || true',
    "  ;;",
    "*)",
    '  echo "panel-nat: usage: up|down <iface> <cidr>" >&2',
    "  exit 1",
    "  ;;",
    "esac",
  ].join("\n");
}
