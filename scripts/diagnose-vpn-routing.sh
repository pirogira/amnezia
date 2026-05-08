#!/usr/bin/env bash
# Запускать НА VPS по SSH: bash diagnose-vpn-routing.sh
#
# Перед запуском: ВКЛЮЧИТЕ VPN на телефоне/ПК, 5–10 сек пооткрывайте сайты (или ping 1.1.1.1),
# затем выполните скрипт — так по счётчикам iptables видно, доходит ли трафик до хоста.
#
# Переменные: WG_CONTAINER (по умолчанию amnezia-awg), WG_IFACE (по умолчанию awg0).

set -uo pipefail

CONTAINER="${WG_CONTAINER:-amnezia-awg}"
IFACE="${WG_IFACE:-awg0}"

echo "=== 0) Инструкция ==="
echo "VPN на клиенте должен быть ВКЛЮЧЁН во время сбора (кроме отдельного теста по желанию)."
echo ""

echo "=== 1) Базовая связность хоста VPS ==="
date -Is
ping -c 2 -W 3 1.1.1.1 2>&1 || echo "(ping с VPS наружу не удался)"

echo ""
echo "=== 2) IPv4 forwarding ==="
sysctl net.ipv4.ip_forward 2>&1 || true

echo ""
echo "=== 3) rp_filter (на awg0 часто нужен 0 для форварда) ==="
sysctl "net.ipv4.conf.${IFACE}.rp_filter" 2>/dev/null || echo "(нет sysctl для ${IFACE} — интерфейс не поднят?)"
sysctl net.ipv4.conf.all.rp_filter net.ipv4.conf.default.rp_filter 2>/dev/null || true

echo ""
echo "=== 4) Docker: контейнер, сеть, PID, capabilities ==="
docker ps -a --filter "name=${CONTAINER}" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}' 2>&1 || true
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "network_mode: $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER" 2>/dev/null)"
  PM=$(docker inspect -f '{{.HostConfig.PidMode}}' "$CONTAINER" 2>/dev/null | tr -d '\r')
  if [[ -z "$PM" ]]; then
    echo "pid_mode: (пусто) = НЕ host → nsenter -t 1 -m не даст зайти в mount хоста; нужна строка pid: host в compose"
  else
    echo "pid_mode: $PM"
  fi
  echo "cap_add: $(docker inspect -f '{{.HostConfig.CapAdd}}' "$CONTAINER" 2>/dev/null)"
  if ! docker inspect -f '{{.HostConfig.CapAdd}}' "$CONTAINER" 2>/dev/null | grep -q SYS_ADMIN; then
    echo "ВНИМАНИЕ: нет CAP_SYS_ADMIN → nsenter в mount-ns init будет Operation not permitted; добавьте в compose."
  fi
  echo "privileged: $(docker inspect -f '{{.HostConfig.Privileged}}' "$CONTAINER" 2>/dev/null)"
fi

echo ""
echo "=== 5) Из контейнера: nsenter + хостовый iptables-legacy (должно быть без ошибок) ==="
docker exec "$CONTAINER" sh -c '
  echo -n "nsenter: "; command -v nsenter || echo "нет"
  echo -n "test -x /usr/sbin/iptables-legacy в mount-ns PID1: "
  if nsenter -t 1 -m test -x /usr/sbin/iptables-legacy 2>/dev/null; then echo ok; else echo FAIL; fi
  nsenter -t 1 -m -- /usr/sbin/iptables-legacy -V 2>&1 || echo "iptables-legacy -V failed"
' 2>&1 || echo "docker exec failed (контейнер не запущен?)"

echo ""
echo "=== 6) Из контейнера: legacy FORWARD (через nsenter), первые строки ==="
docker exec "$CONTAINER" sh -c 'nsenter -t 1 -m -- /usr/sbin/iptables-legacy -L FORWARD -n -v --line-numbers 2>&1 | head -35' 2>&1 || echo "exec failed"

echo ""
echo "=== 7) Из контейнера: legacy NAT POSTROUTING (через nsenter) ==="
docker exec "$CONTAINER" sh -c 'nsenter -t 1 -m -- /usr/sbin/iptables-legacy -t nat -L POSTROUTING -n -v --line-numbers 2>&1 | head -30' 2>&1 || echo "exec failed"

echo ""
echo "=== 7b) На хосте напрямую: legacy NAT POSTROUTING (ищите MASQUERADE 10.8…) ==="
if command -v iptables-legacy >/dev/null 2>&1; then
  iptables-legacy -t nat -L POSTROUTING -n -v --line-numbers 2>&1 | head -25
else
  echo "iptables-legacy нет"
fi

echo ""
echo "=== 8) Счётчики: сколько строк с ${IFACE} в legacy FORWARD ==="
if command -v iptables-legacy >/dev/null 2>&1; then
  echo -n "на хосте (iptables-legacy): "
  iptables-legacy -L FORWARD -n -v 2>&1 | grep -c "${IFACE}" || true
else
  echo "iptables-legacy нет на хосте"
fi

echo ""
echo "=== 9) awg0.conf: строки PostUp / PostDown (с хоста) ==="
for f in /opt/amnezia/awg/awg0.conf /opt/amnesia/awg/awg0.conf; do
  if [[ -f "$f" ]]; then
    echo "--- $f ---"
    grep -E '^Post(Up|Down)|^ListenPort|^Address' "$f" 2>/dev/null || true
  fi
done

echo ""
echo "=== 10) panel-nat.sh (первые строки, путь) ==="
for d in /opt/amnesia/awg /opt/amnezia/awg; do
  f="${d}/panel-nat.sh"
  if [[ -f "$f" ]]; then
    echo "found $f"
    head -8 "$f"
    ls -la "$f"
  fi
done

echo ""
echo "=== 11) awg/wg show (туннель, handshake, transfer) ==="
if docker exec "$CONTAINER" true 2>/dev/null; then
  EXE=wg
  if docker exec "$CONTAINER" sh -c 'command -v awg' >/dev/null 2>&1; then EXE=awg; fi
  docker exec "$CONTAINER" "$EXE" show "$IFACE" 2>&1 || echo "wg/awg show failed"
else
  echo "контейнер ${CONTAINER} недоступен"
fi

echo ""
echo "=== 12) Интерфейс ${IFACE} ==="
ip -brief link show "${IFACE}" 2>&1 || echo "нет ${IFACE}"

echo ""
echo "=== 13) Маршрут до 8.8.8.8 «как с клиентской подсети» (если поддерживается) ==="
ip route get 8.8.8.8 from 10.8.0.2 iif "${IFACE}" 2>&1 || echo "(lookup не поддержан или нет маршрута)"

echo ""
echo "=== 14) Последние логи контейнера (ошибки PostUp/panel-nat) ==="
docker logs --tail 50 "$CONTAINER" 2>&1 || true

echo ""
echo "=== 15) Сравнение: iptables vs iptables-legacy FORWARD (первые 12 строк каждого) ==="
echo "--- iptables (nft) ---"
iptables -L FORWARD -n -v --line-numbers 2>&1 | head -12 || true
echo "--- iptables-legacy ---"
iptables-legacy -L FORWARD -n -v --line-numbers 2>&1 | head -12 || true

echo ""
echo "=== Как интерпретировать (кратко) ==="
echo "A) П.5 FAIL или iptables-legacy -V failed → нет pid:host / SYS_ADMIN или nsenter не может зайти в mount хоста."
echo "B) П.6–7 через nsenter нет ACCEPT/MASQUERADE для ${IFACE} или 10.8.x → PostUp/panel-nat не отработал (см. П.14 логи awg-quick)."
echo "C) П.11 handshake есть, transfer почти не растёт при серфинге с VPN → см. A/B или облачный фаервол провайдера."
echo "D) П.11 transfer растёт, но интернета нет у клиента → смотрите DNS на клиенте или блокировку у оператора клиента."
echo "E) pid_mode не \"host\" → обновите docker-compose (pid: host) и пересоздайте контейнер."
