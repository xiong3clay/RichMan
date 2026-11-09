#!/usr/bin/env bash
# RichMan Linux 恢复：先停服务，再逐房间恢复；恢复后房间为暂停态，由房主在界面继续。
# 用法：sudo bash scripts/restore.sh --backup DIR --room 1234 [--room 5678] [--force]
#       sudo bash scripts/restore.sh --backup DIR --all [--force]
set -euo pipefail

DATA_DIR=/var/lib/richman
BACKUP=""
FORCE=0
ROOMS=()
ALL=0
SERVICE=richman
NODE=/opt/richman/node/bin/node
CLI=/opt/richman/app/server/backup-cli.mjs

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; exit "${3:-1}"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--backup 缺少值" 2; BACKUP="${2%/}"; shift 2 ;;
    --room) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--room 缺少值" 2; ROOMS+=("$2"); shift 2 ;;
    --all) ALL=1; shift ;;
    --force) FORCE=1; shift ;;
    --data-dir) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--data-dir 缺少值" 2; DATA_DIR="${2%/}"; shift 2 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) die BAD_ARGUMENT "未知参数：$1" 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die NOT_ROOT "请用 root：sudo bash scripts/restore.sh ..." 1
[ -d "$BACKUP" ] || die BAD_ARGUMENT "--backup 必须指向存在的备份目录" 2
[ -x "$NODE" ] || die NODE_MISSING "找不到 $NODE" 1
[ -f "$CLI" ] || die PACKAGE_INCOMPLETE "找不到 $CLI" 1
if [ "$ALL" -eq 1 ] && [ "${#ROOMS[@]}" -gt 0 ]; then die BAD_ARGUMENT "--all 与 --room 不能同时使用" 2; fi
if [ "$ALL" -eq 0 ] && [ "${#ROOMS[@]}" -eq 0 ]; then die BAD_ARGUMENT "必须给 --room 或 --all" 2; fi

if [ "$ALL" -eq 1 ]; then
  MANIFEST="$BACKUP/manifest.json"
  [ -f "$MANIFEST" ] || die BAD_ARGUMENT "备份里没有 manifest.json：$MANIFEST" 2
  mapfile -t ROOMS < <("$NODE" -e "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));for(const r of (m.rooms||[])){if(r&&r.code)console.log(String(r.code));}" "$MANIFEST")
fi
[ "${#ROOMS[@]}" -gt 0 ] || die BAD_ARGUMENT "备份里没有可恢复的房间" 2

WAS_ACTIVE=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SERVICE"; then
  WAS_ACTIVE=1
  log "停止服务 $SERVICE"
  systemctl stop "$SERVICE"
fi

for ROOM in "${ROOMS[@]}"; do
  log "恢复房间 $ROOM"
  ARGS=(restore --backup "$BACKUP" --data "$DATA_DIR" --room "$ROOM")
  [ "$FORCE" -eq 1 ] && ARGS+=(--force)
  "$NODE" "$CLI" "${ARGS[@]}"
done

if [ "$WAS_ACTIVE" -eq 1 ]; then
  log "重新启动服务 $SERVICE"
  systemctl start "$SERVICE"
fi
log "恢复完成。房间为暂停态：请房主在界面点“继续游戏”。"
