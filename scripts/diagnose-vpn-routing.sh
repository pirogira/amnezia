#!/usr/bin/env bash
# Запускать НА VPS по SSH (bash diagnose-vpn-routing.sh).
# Желательно: один раз с выключенным VPN на клиенте, второй — с включённым (чтобы сравнить счётчики iptables).
# Переменные: WG_CONTAINER (по умолчанию amnezia-awg), WG_IFACE (по умолчанию awg0).

set -uo pipefail

CONTAINER="${WG_CONTAINER:-amnezia-awg}"
IFACE="${WG_IFACE:-awg0}"

echo "=== 1) Базовая связность хоста (без VPN с клиента это не проверяет туннель) ==="
date -Is
ping -c 2 -W 3 1.1.1.1 2>&1 || echo "(ping с VPS наружу не удался — сначала почините исход с самой VPS)"

echo ""
echo "=== 2) IPv4 forwarding (должно быть 1 для раздачи интернета клиентам) ==="
sysctl net.ipv4.ip_forward 2>&1 || true

echo ""
echo "=== 3) UFW (если active — часто режет FORWARD до наших правил) ==="
if command -v ufw >/dev/null 2>&1; then
  ufw status verbose 2>&1 || true
else
  echo "ufw не установлен"
fi

echo ""
echo "=== 4) Docker: контейнер VPN ==="
docker ps -a --filter "name=${CONTAINER}" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>&1 || true
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "network_mode: $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER" 2>/dev/null)"
fi

echo ""
echo "=== 4b) iptables-legacy внутри контейнера (должен быть с хоста bind-mount, иначе только nft) ==="
docker exec "$CONTAINER" sh -c 'ls -la /usr/sbin/iptables-legacy 2>&1; /usr/sbin/iptables-legacy -V 2>&1' 2>&1 || echo "exec failed"

echo ""
echo "=== 5) Интерфейс ${IFACE} на хосте (network_mode: host — интерфейс на хосте) ==="
ip -brief link show "${IFACE}" 2>&1 || echo "интерфейса ${IFACE} нет (контейнер не поднял туннель?)"

echo ""
echo "=== 6) awg/wg show внутри контейнера (handshake, listening port, transfer) ==="
if docker exec "$CONTAINER" true 2>/dev/null; then
  EXE=wg
  if docker exec "$CONTAINER" sh -c 'command -v awg' >/dev/null 2>&1; then EXE=awg; fi
  docker exec "$CONTAINER" "$EXE" show "$IFACE" 2>&1 || echo "wg/awg show failed"
else
  echo "docker exec ${CONTAINER}: контейнер не найден или не запущен"
fi

echo ""
echo "=== 7) Скрипт NAT от панели (если provision новый) ==="
for d in /opt/amnesia/awg /opt/amnezia/awg; do
  f="${d}/panel-nat.sh"
  if [[ -f "$f" ]]; then
    echo "found $f"
    head -5 "$f"
    ls -la "$f"
  fi
done

echo ""
echo "=== 8a) iptables (часто nft) FORWARD ==="
iptables -L FORWARD -n -v --line-numbers 2>&1 | head -30 || true

echo ""
echo "=== 8b) iptables-legacy FORWARD (Docker обычно здесь; ищите ${IFACE}) ==="
if command -v iptables-legacy >/dev/null 2>&1; then
  iptables-legacy -L FORWARD -n -v --line-numbers 2>&1 | head -40
else
  echo "iptables-legacy нет"
fi

echo ""
echo "=== 9a) iptables NAT POSTROUTING (nft) ==="
iptables -t nat -L POSTROUTING -n -v --line-numbers 2>&1 | head -20 || true

echo ""
echo "=== 9b) iptables-legacy NAT POSTROUTING (ищите MASQUERADE для 10.8…) ==="
if command -v iptables-legacy >/dev/null 2>&1; then
  iptables-legacy -t nat -L POSTROUTING -n -v --line-numbers 2>&1 | head -25
else
  echo "iptables-legacy нет"
fi

echo ""
echo "=== 10) Маршрут по умолчанию на хосте ==="
ip route show default 2>&1 || true

echo ""
echo "=== Как читать результат (кратко) ==="
echo "- П.2: ip_forward=0 → форвардинг выключен, клиентский трафик не пойдёт."
echo "- П.6: latest handshake есть, rx/tx растут при включённом VPN и серфинге → туннель жив; если 0 — нет обмена с клиентом."
echo "- П.8b/9b (legacy): при включённом VPN bytes на правилах FORWARD/NAT для ${IFACE} должны расти."
echo "- Если в 8a есть awg0, а в 8b нет — PostUp писал в «не тот» iptables (см. panel-nat: legacy первым)."
echo "- П.7: нет panel-nat.sh → старый awg0.conf или ручная установка без скрипта панели."
