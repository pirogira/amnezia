#!/bin/sh
# Держите в соответствии с apps/api/src/provision/panelNatScript.ts (buildPanelWgNatScript).

# amnesia-veb: NAT и FORWARD для клиентов VPN.
# Сначала iptables-legacy: Docker на Ubuntu часто пишет в legacy; иначе правила уходят в nft и не работают.
set -eu
ACTION=${1:?}
IFACE=${2:?}
SUBNET=${3:?}

iptables_bin() {
  if [ -x /usr/sbin/iptables-legacy ]; then printf %s /usr/sbin/iptables-legacy; return; fi
  if [ -x /sbin/iptables-legacy ]; then printf %s /sbin/iptables-legacy; return; fi
  if command -v iptables-legacy >/dev/null 2>&1; then printf %s iptables-legacy; return; fi
  if command -v iptables >/dev/null 2>&1; then printf %s iptables; return; fi
  printf %s ""
}

IPT=$(iptables_bin)
if [ -z "$IPT" ]; then
  echo "panel-nat: iptables not found" >&2
  exit 1
fi

case "$ACTION" in
up)
  sysctl -w "net.ipv4.conf.$IFACE.rp_filter=0" 2>/dev/null || true
  "$IPT" -I FORWARD 1 -i "$IFACE" -j ACCEPT
  "$IPT" -I FORWARD 1 -o "$IFACE" -j ACCEPT
  "$IPT" -I DOCKER-USER 1 -i "$IFACE" -j RETURN 2>/dev/null || true
  "$IPT" -I DOCKER-USER 1 -o "$IFACE" -j RETURN 2>/dev/null || true
  "$IPT" -t nat -I POSTROUTING 1 -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE
  ;;
down)
  "$IPT" -t nat -D POSTROUTING -s "$SUBNET" ! -d "$SUBNET" -j MASQUERADE 2>/dev/null || true
  "$IPT" -D DOCKER-USER -o "$IFACE" -j RETURN 2>/dev/null || true
  "$IPT" -D DOCKER-USER -i "$IFACE" -j RETURN 2>/dev/null || true
  "$IPT" -D FORWARD -o "$IFACE" -j ACCEPT 2>/dev/null || true
  "$IPT" -D FORWARD -i "$IFACE" -j ACCEPT 2>/dev/null || true
  sysctl -w "net.ipv4.conf.$IFACE.rp_filter=2" 2>/dev/null || true
  ;;
*)
  echo "panel-nat: usage: up|down <iface> <cidr>" >&2
  exit 1
  ;;
esac
