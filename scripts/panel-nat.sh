#!/bin/sh
# Держите в соответствии с apps/api/src/provision/panelNatScript.ts (buildPanelWgNatScript).

# amnesia-veb: NAT и FORWARD для клиентов VPN.
# Требуется compose: network_mode host, pid host, privileged (доступ /proc/1/ns/mnt для nsenter).
set -eu
ACTION=${1:?}
IFACE=${2:?}
SUBNET=${3:?}

# Запуск хостового iptables-legacy (таблицы Docker); bind-mount бинаря в образ ломается (libc).
run_ipt() {
  if command -v nsenter >/dev/null 2>&1 && nsenter -t 1 -m test -x /usr/sbin/iptables-legacy 2>/dev/null; then
    nsenter -t 1 -m -- /usr/sbin/iptables-legacy "$@"
    return
  fi
  if command -v nsenter >/dev/null 2>&1 && nsenter -t 1 -m test -x /sbin/iptables-legacy 2>/dev/null; then
    nsenter -t 1 -m -- /sbin/iptables-legacy "$@"
    return
  fi
  if command -v iptables-legacy >/dev/null 2>&1; then
    iptables-legacy "$@"
    return
  fi
  iptables "$@"
}

case "$ACTION" in
up)
  sysctl -w "net.ipv4.conf.$IFACE.rp_filter=0" 2>/dev/null || true
  run_ipt -I FORWARD 1 -i "$IFACE" -j ACCEPT
  run_ipt -I FORWARD 1 -o "$IFACE" -j ACCEPT
  run_ipt -I DOCKER-USER 1 -i "$IFACE" -j RETURN 2>/dev/null || true
  run_ipt -I DOCKER-USER 1 -o "$IFACE" -j RETURN 2>/dev/null || true
  run_ipt -t nat -I POSTROUTING 1 -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE
  ;;
down)
  run_ipt -t nat -D POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2>/dev/null || true
  run_ipt -D DOCKER-USER -o "$IFACE" -j RETURN 2>/dev/null || true
  run_ipt -D DOCKER-USER -i "$IFACE" -j RETURN 2>/dev/null || true
  run_ipt -D FORWARD -o "$IFACE" -j ACCEPT 2>/dev/null || true
  run_ipt -D FORWARD -i "$IFACE" -j ACCEPT 2>/dev/null || true
  sysctl -w "net.ipv4.conf.$IFACE.rp_filter=2" 2>/dev/null || true
  ;;
*)
  echo "panel-nat: usage: up|down <iface> <cidr>" >&2
  exit 1
  ;;
esac
