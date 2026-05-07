#!/usr/bin/env bash
# Скачать и установить панель на Linux-сервер (нужны curl, git, docker).
# Пример:
#   curl -fsSL https://raw.githubusercontent.com/YOUR_USER/amnesia_veb/main/get.sh | sudo -E bash
# Перед запуском задайте URL репозитория:
#   export REPO_URL="https://github.com/YOUR_USER/amnesia_veb.git"
# Опционально:
#   export INSTALL_DIR="/opt/amnesia-veb"
#   export GIT_BRANCH="main"

set -euo pipefail

if [[ "${EUID:-0}" -ne 0 ]]; then
  echo "Запустите от root или через: curl ... | sudo bash" >&2
  exit 1
fi

INSTALL_DIR="${INSTALL_DIR:-/opt/amnesia-veb}"
GIT_BRANCH="${GIT_BRANCH:-main}"

if [[ -z "${REPO_URL:-}" ]]; then
  echo "Укажите URL git-репозитория, например:" >&2
  echo "  export REPO_URL=\"https://github.com/YOUR_USER/amnesia_veb.git\"" >&2
  echo "  curl -fsSL .../get.sh | sudo -E bash" >&2
  exit 1
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "Нужна команда: $1" >&2; exit 1; }; }
need curl
need git

if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --depth 1 origin "$GIT_BRANCH"
  git -C "$INSTALL_DIR" checkout "$GIT_BRANCH"
  git -C "$INSTALL_DIR" pull --ff-only origin "$GIT_BRANCH" || true
else
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$GIT_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

exec bash "$INSTALL_DIR/install/install.sh"
