#!/usr/bin/env bash
# Example VPS hook for listen-port changes. Path must match panel server.port_change_hook_cmd (e.g. /opt/amnesia/set-port.sh).
# chmod +x && validate before production use.
set -euo pipefail
NEW_PORT="${1:?port arg required}"
if ! [[ "$NEW_PORT" =~ ^[0-9]+$ ]] || (( NEW_PORT < 1024 || NEW_PORT > 65535 )); then
  echo "invalid port" >&2
  exit 1
fi
echo "example: would remap docker publish and firewall to UDP $NEW_PORT"
echo "replace this script with your real ufw + docker compose changes."
