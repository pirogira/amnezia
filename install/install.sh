#!/usr/bin/env bash
# Интерактивная установка веб-панели на Linux (Docker Compose).
# Запуск из клонированного репозитория: sudo bash install/install.sh
# Или через: curl .../get.sh | sudo -E bash / curl .../bootstrap.sh | sudo -E bash

set -euo pipefail

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите от root: sudo bash install/install.sh" >&2
  exit 1
fi

# При `curl ... | sudo bash` stdin — поток от curl и после него закрыт; без TTY все read сразу EOF (set -e).
if [[ ! -t 0 ]] && [[ -r /dev/tty ]]; then
  exec 0</dev/tty
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INFRA="$ROOT/infra"

if [[ ! -f "$INFRA/docker-compose.yml" ]]; then
  echo "Не найден $INFRA/docker-compose.yml (запускайте из репозитория)." >&2
  exit 1
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "Установите: $1" >&2; exit 1; }; }
need docker
docker compose version >/dev/null 2>&1 || { echo "Нужен Docker Compose v2 (docker compose)" >&2; exit 1; }
need openssl
need curl
need python3

read_secret() {
  local prompt="$1"
  local s
  read -r -s -p "$prompt" s || true
  echo
  printf '%s' "$s"
}

detect_ip() {
  curl -4fsS --max-time 5 https://ifconfig.io/ip 2>/dev/null || curl -4fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}'
}

echo "=== Установка Amnesia / Amnezia web panel ==="
echo

read -r -p "Логин администратора панели [admin]: " PANEL_USER
PANEL_USER="${PANEL_USER:-admin}"

while true; do
  PANEL_PASS1="$(read_secret "Пароль администратора: ")"
  echo
  PANEL_PASS2="$(read_secret "Повтор пароля: ")"
  echo
  if [[ "${#PANEL_PASS1}" -lt 10 ]]; then
    echo "Пароль не короче 10 символов."
    continue
  fi
  if [[ "$PANEL_PASS1" != "$PANEL_PASS2" ]]; then
    echo "Пароли не совпадают."
    continue
  fi
  break
done

# Без этого в .env мог попасть ведущий \\n (после read -s / копипаста) — пароль визуально «123…», а в базе другой.
strip_edges() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}
PANEL_PASS1="$(strip_edges "$PANEL_PASS1")"
PANEL_USER="$(strip_edges "$PANEL_USER")"

read -r -p "Внешний IP сервера для сертификата и ссылки [авто]: " SERVER_IP
SERVER_IP="${SERVER_IP:-$(detect_ip)}"
if [[ -z "$SERVER_IP" ]]; then
  echo "Не удалось определить IP — введите вручную." >&2
  read -r -p "IP: " SERVER_IP
fi

echo
echo "Режим доступа:"
echo "  1) Только HTTP (без SSL, браузер не ругается)"
echo "  2) HTTPS с самоподписанным сертификатом для IP (браузер покажет предупреждение)"
read -r -p "Выбор [2]: " TLS_CHOICE
TLS_CHOICE="${TLS_CHOICE:-2}"

if [[ "$TLS_CHOICE" == "1" ]]; then
  USE_TLS=0
  read -r -p "Порт панели (HTTP) [8080]: " PANEL_PORT
  PANEL_PORT="${PANEL_PORT:-8080}"
  CADDY_TARGET=80
  SCHEME="http"
else
  USE_TLS=1
  read -r -p "Порт панели (HTTPS) [8443]: " PANEL_PORT
  PANEL_PORT="${PANEL_PORT:-8443}"
  CADDY_TARGET=443
  SCHEME="https"
fi

read -r -p "Адрес привязки Docker [0.0.0.0]: " BIND_ADDR
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"

JWT_SECRET="$(openssl rand -hex 32)"
ENC_KEY="$(openssl rand -hex 32)"

CREDS_FILE="$ROOT/panel-credentials.txt"
ENV_FILE="$INFRA/.env"
CERT_DIR="$INFRA/certs"

mkdir -p "$CERT_DIR"

if [[ "$USE_TLS" -eq 1 ]]; then
  OPENSSL_CONF="$(mktemp)"
  cat >"$OPENSSL_CONF" <<EOF
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = $SERVER_IP

[v3_req]
keyUsage = keyEncipherment, dataEncipherment, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
IP.1 = $SERVER_IP
DNS.1 = localhost
EOF
  openssl req -x509 -newkey rsa:4096 -sha256 -days 825 -nodes \
    -keyout "$CERT_DIR/key.pem" -out "$CERT_DIR/cert.pem" -config "$OPENSSL_CONF" >/dev/null 2>&1
  rm -f "$OPENSSL_CONF"
  chmod 600 "$CERT_DIR/key.pem" "$CERT_DIR/cert.pem"
  cp -f "$SCRIPT_DIR/Caddyfile.https" "$INFRA/Caddyfile"
else
  rm -f "$CERT_DIR"/*.pem 2>/dev/null || true
  cp -f "$SCRIPT_DIR/Caddyfile.http" "$INFRA/Caddyfile"
fi

PUBLIC_ORIGIN="${SCHEME}://${SERVER_IP}:${PANEL_PORT}"

export _ENV_OUT="$ENV_FILE"
export _PUB_ADDR="$BIND_ADDR"
export _PUB_PORT="$PANEL_PORT"
export _CADDY_TARGET="$CADDY_TARGET"
export _JWT="$JWT_SECRET"
export _ENC="$ENC_KEY"
export _USER="$PANEL_USER"
export _PASS="$PANEL_PASS1"
export _ORIGIN="$PUBLIC_ORIGIN"

python3 <<'PY'
import os
from pathlib import Path

def esc_line(key: str, val: str) -> str:
    val = (val or "").strip("\r\n\t ")
    if val == "":
        return f'{key}='
    # Docker Compose подставляет $ из .env — литеральный $ задаётся как $$
    v0 = val.replace("$", "$$")
    if any(c in v0 for c in ' \t\n\r#"\'\\') or "$" in val:
        v = v0.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n").replace("\r", "\\r")
        return f'{key}="{v}"'
    return f"{key}={v0}"

p = Path(os.environ["_ENV_OUT"])
lines = [
    "# Сгенерировано install/install.sh — не коммитьте в git",
    esc_line("PANEL_PUBLIC_ADDR", os.environ["_PUB_ADDR"]),
    esc_line("PANEL_PUBLIC_PORT", os.environ["_PUB_PORT"]),
    esc_line("PANEL_CADDY_TARGET", os.environ["_CADDY_TARGET"]),
    esc_line("PANEL_JWT_SECRET", os.environ["_JWT"]),
    esc_line("PANEL_ENCRYPTION_KEY", os.environ["_ENC"]),
    esc_line("PANEL_BOOTSTRAP_USERNAME", os.environ["_USER"]),
    esc_line("PANEL_BOOTSTRAP_PASSWORD", os.environ["_PASS"]),
    esc_line("PANEL_CORS_ORIGIN", os.environ["_ORIGIN"]),
    esc_line("TRUST_PROXY", "true"),
    esc_line("ALLOW_REGISTER", "false"),
    # Один раз после установки синхронизирует хэш с .env (удалите строку после успешного входа)
    esc_line("PANEL_BOOTSTRAP_UPDATE_PASSWORD", "true"),
]
p.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
chmod 600 "$ENV_FILE"

unset _ENV_OUT _PUB_ADDR _PUB_PORT _CADDY_TARGET _JWT _ENC _USER _PASS _ORIGIN

cat >"$CREDS_FILE" <<EOF
Amnesia web panel — сохраните и удалите этот файл при необходимости.
Создано: $(date -Is)

URL:       ${PUBLIC_ORIGIN}/
Логин:     ${PANEL_USER}
Пароль:    ${PANEL_PASS1}

Перезапуск: cd ${INFRA} && docker compose --env-file .env up -d --build
EOF
chmod 600 "$CREDS_FILE"

echo
echo "Сборка и запуск контейнеров..."
cd "$INFRA"
docker compose --env-file .env pull 2>/dev/null || true
docker compose --env-file .env build --progress plain
docker compose --env-file .env up -d

HEALTH_URL="${PUBLIC_ORIGIN}/api/health"
echo "Ожидание готовности API: $HEALTH_URL"
for _i in $(seq 1 60); do
  CURL_ARGS=(-fsS --max-time 3)
  if [[ "$USE_TLS" -eq 1 ]]; then CURL_ARGS+=(-k); fi
  if curl "${CURL_ARGS[@]}" "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo
echo "================================================================"
echo " Готово"
echo "================================================================"
echo " Ссылка на панель: ${PUBLIC_ORIGIN}/"
echo " Логин:             ${PANEL_USER}"
echo " Пароль:            ${PANEL_PASS1}"
echo " Копия данных:      ${CREDS_FILE}"
echo "================================================================"
echo
echo "Важно: порт ${PANEL_PORT} — это веб-панель (Caddy). Не путайте с 5173: 5173 только для npm run dev на ПК."
echo "В infra/.env добавлено PANEL_BOOTSTRAP_UPDATE_PASSWORD=true — после первого успешного входа удалите эту строку и выполните:"
echo "  cd ${INFRA} && docker compose --env-file .env up -d"
echo
if [[ "$USE_TLS" -eq 1 ]]; then
  echo "Самоподписанный сертификат: в браузере откройте «Дополнительно» и перейдите на сайт."
fi
echo
echo "Повторный запуск установщика не сбросит пароль, если сохранился Docker volume panel_data."
echo "Полный сброс: cd ${INFRA} && docker compose --env-file .env down -v"
echo
