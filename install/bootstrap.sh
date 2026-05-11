#!/usr/bin/env bash
# Полная подготовка Linux-сервера (Debian/Ubuntu) и установка веб-панели.
#
# С сервера (одной вставкой, репозиторий по умолчанию — pirogira/amnezia):
#   curl -fsSL https://raw.githubusercontent.com/pirogira/amnezia/main/install/bootstrap.sh | sudo -E bash
#
# Уже после git clone, из каталога репозитория:
#   sudo bash install/bootstrap.sh
#
# Переменные окружения (опционально):
#   REPO_URL     — URL git (по умолчанию: https://github.com/pirogira/amnezia.git)
#   INSTALL_DIR  — каталог установки (по умолчанию: /opt/amnesia-veb)
#   GIT_BRANCH   — ветка (по умолчанию: main)

set -euo pipefail

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите от root: sudo bash install/bootstrap.sh" >&2
  echo "или: curl .../bootstrap.sh | sudo -E bash" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

REPO_URL="${REPO_URL:-https://github.com/pirogira/amnezia.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/amnesia-veb}"
GIT_BRANCH="${GIT_BRANCH:-main}"

need_cmd() { command -v "$1" >/dev/null 2>&1 || { echo "Нужна команда: $1" >&2; exit 1; }; }

detect_in_repo() {
  local src="${BASH_SOURCE[0]:-}"
  if [[ "$src" == "-" ]]; then
    return 1
  fi
  if [[ ! -f "$src" ]]; then
    return 1
  fi
  local sd root
  sd="$(cd "$(dirname "$src")" && pwd)"
  root="$(cd "$sd/.." && pwd)"
  if [[ -f "$root/infra/docker-compose.yml" ]]; then
    INSTALL_DIR="$root"
    return 0
  fi
  return 1
}

have_docker_compose() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

install_docker_apt() {
  if have_docker_compose; then
    return 0
  fi
  if [[ ! -f /etc/os-release ]]; then
    echo "Нет /etc/os-release — установите Docker вручную: https://docs.docker.com/engine/install/" >&2
    exit 1
  fi
  # shellcheck source=/dev/null
  . /etc/os-release
  local dist=""
  case "${ID:-}" in
    ubuntu) dist=ubuntu ;;
    debian) dist=debian ;;
    *)
      echo "Автоустановка Docker поддержана только для Debian/Ubuntu (сейчас: ${ID:-unknown})." >&2
      echo "Установите Docker Engine и плагин compose v2, затем повторите запуск." >&2
      exit 1
      ;;
  esac

  local codename="${VERSION_CODENAME:-}"
  if [[ -z "$codename" ]]; then
    codename="${UBUNTU_CODENAME:-}"
  fi
  if [[ -z "$codename" ]]; then
    echo "Не удалось определить VERSION_CODENAME — установите Docker вручную." >&2
    exit 1
  fi

  apt-get update -y
  apt-get install -y ca-certificates curl

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${dist}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${dist} ${codename} stable" \
    >/etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

ensure_repo() {
  if detect_in_repo; then
    echo "=== Репозиторий уже на месте: ${INSTALL_DIR} ==="
    return 0
  fi
  need_cmd git
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    echo "=== Обновление ${INSTALL_DIR} (ветка ${GIT_BRANCH}) ==="
    git -C "$INSTALL_DIR" fetch --depth 1 origin "$GIT_BRANCH"
    git -C "$INSTALL_DIR" checkout "$GIT_BRANCH"
    git -C "$INSTALL_DIR" pull --ff-only origin "$GIT_BRANCH" || true
    return 0
  fi
  echo "=== Клонирование в ${INSTALL_DIR} ==="
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$GIT_BRANCH" "$REPO_URL" "$INSTALL_DIR"
}

echo "=== Amnesia / Amnezia web panel — bootstrap сервера ==="
echo

apt-get update -y
apt-get install -y ca-certificates curl git openssl python3

install_docker_apt
need_cmd docker
docker compose version >/dev/null 2>&1 || { echo "Нужен Docker Compose v2 (docker compose)." >&2; exit 1; }

ensure_repo

if [[ ! -f "${INSTALL_DIR}/install/install.sh" ]]; then
  echo "Не найден ${INSTALL_DIR}/install/install.sh" >&2
  exit 1
fi

exec bash "${INSTALL_DIR}/install/install.sh"
