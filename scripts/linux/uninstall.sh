#!/usr/bin/env bash
# RichMan Linux 卸载：停止并移除 systemd 服务与应用；默认保留数据。
# 用法：sudo bash scripts/uninstall.sh [--purge] [--prefix /opt/richman] [--data-dir /var/lib/richman]
set -euo pipefail

SERVICE=richman
PREFIX=/opt/richman
DATA_DIR=/var/lib/richman
PURGE=0

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; exit "${3:-1}"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --prefix) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--prefix 缺少值" 2; PREFIX="${2%/}"; shift 2 ;;
    --data-dir) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--data-dir 缺少值" 2; DATA_DIR="${2%/}"; shift 2 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) die BAD_ARGUMENT "未知参数：$1" 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die NOT_ROOT "请用 root 运行：sudo bash scripts/uninstall.sh" 1

if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
fi
rm -f "/etc/systemd/system/$SERVICE.service"
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || true; fi

rm -rf "$PREFIX/app" "$PREFIX/node"
rmdir "$PREFIX" 2>/dev/null || true
log "已移除应用：$PREFIX"

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$DATA_DIR" "/etc/richman"
  if getent passwd "$SERVICE" >/dev/null 2>&1; then
    userdel "$SERVICE" 2>/dev/null || warn=1
  fi
  log "已删除数据目录、配置与系统用户（--purge）"
else
  log "已保留数据：$DATA_DIR"
  log "已保留配置：/etc/richman/richman.env"
  log "需要连数据一起删：sudo bash scripts/uninstall.sh --purge"
fi
