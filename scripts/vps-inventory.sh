#!/usr/bin/env bash
# Run ON the Amnezia VPS (copy via scp or paste). Collects docker state for panel integration.
set -euo pipefail

echo "=== date ==="
date -Is

echo "=== docker ps (all) ==="
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'

echo "=== likely wireguard/amnezia containers ==="
docker ps -a --format '{{.Names}}\t{{.Image}}' | grep -iE 'wire|wg|amnezia|awg' || true

echo "=== compose projects (if docker compose v2) ==="
docker compose ls 2>/dev/null || true

echo "=== sample wg show (requires container name; set WG_CONTAINER) ==="
if [[ -n "${WG_CONTAINER:-}" ]]; then
  docker exec "$WG_CONTAINER" wg show 2>/dev/null || echo "wg show failed"
else
  echo 'Set WG_CONTAINER=name and re-run tail section, e.g.: WG_CONTAINER=amnezia-awg ./vps-inventory.sh'
fi
