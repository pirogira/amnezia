/** Имя в каталоге awg на хосте и в `/etc/wireguard` внутри контейнера. */
export const PANEL_WG_NAT_SCRIPT_BASENAME = "panel-nat.sh";

/**
 * PostUp/PostDown для awg0.conf: вызывается из контейнера с network_mode host + pid host.
 * iptables через `nsenter -t 1 -m` — бинарь и libc с **хоста**, таблицы совпадают с Docker legacy.
 * Дубликат для curl: `scripts/panel-nat.sh`.
 */
export function buildPanelWgNatScript(): string {
  return [
    "#!/bin/sh",
    "# amnesia-veb: NAT и FORWARD для клиентов VPN.",
    "# Требуется compose: network_mode host, pid host, cap SYS_ADMIN (nsenter в mount-ns init).",
    "set -eu",
    "ACTION=${1:?}",
    "IFACE=${2:?}",
    "SUBNET=${3:?}",
    "",
    "# Запуск хостового iptables-legacy (таблицы Docker); bind-mount бинаря в образ ломается (libc).",
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
    'case "$ACTION" in',
    "up)",
    '  sysctl -w "net.ipv4.conf.$IFACE.rp_filter=0" 2>/dev/null || true',
    '  run_ipt -I FORWARD 1 -i "$IFACE" -j ACCEPT',
    '  run_ipt -I FORWARD 1 -o "$IFACE" -j ACCEPT',
    '  run_ipt -I DOCKER-USER 1 -i "$IFACE" -j RETURN 2>/dev/null || true',
    '  run_ipt -I DOCKER-USER 1 -o "$IFACE" -j RETURN 2>/dev/null || true',
    '  run_ipt -t nat -I POSTROUTING 1 -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE',
    "  ;;",
    "down)",
    '  run_ipt -t nat -D POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2>/dev/null || true',
    '  run_ipt -D DOCKER-USER -o "$IFACE" -j RETURN 2>/dev/null || true',
    '  run_ipt -D DOCKER-USER -i "$IFACE" -j RETURN 2>/dev/null || true',
    '  run_ipt -D FORWARD -o "$IFACE" -j ACCEPT 2>/dev/null || true',
    '  run_ipt -D FORWARD -i "$IFACE" -j ACCEPT 2>/dev/null || true',
    '  sysctl -w "net.ipv4.conf.$IFACE.rp_filter=2" 2>/dev/null || true',
    "  ;;",
    "*)",
    '  echo "panel-nat: usage: up|down <iface> <cidr>" >&2',
    "  exit 1",
    "  ;;",
    "esac",
  ].join("\n");
}
