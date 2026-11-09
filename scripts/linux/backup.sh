#!/usr/bin/env bash
# RichMan Linux 备份：调用包内 backup-cli.mjs 生成一致性备份。
# 用法：sudo bash scripts/backup.sh [--out DIR] [--with-audit] [--keep N] [--data-dir DIR]
set -euo pipefail

DATA_DIR=/var/lib/richman
OUT=""
WITH_AUDIT=0
KEEP=""
NODE=/opt/richman/node/bin/node
CLI=/opt/richman/app/server/backup-cli.mjs

log() { printf '%s\n' "$*"; }
die() { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; exit "${3:-1}"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--out 缺少值" 2; OUT="$2"; shift 2 ;;
    --with-audit) WITH_AUDIT=1; shift ;;
    --keep) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--keep 缺少值" 2; KEEP="$2"; shift 2 ;;
    --data-dir) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--data-dir 缺少值" 2; DATA_DIR="${2%/}"; shift 2 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) die BAD_ARGUMENT "未知参数：$1" 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die NOT_ROOT "备份目录属主是 richman，请用 root：sudo bash scripts/backup.sh" 1
[ -x "$NODE" ] || die NODE_MISSING "找不到 $NODE；请先安装本发布包" 1
[ -f "$CLI" ] || die PACKAGE_INCOMPLETE "找不到 $CLI" 1
[ -d "$DATA_DIR" ] || die DATA_DIR_MISSING "数据目录不存在：$DATA_DIR" 1

if [ -z "$OUT" ]; then
  OUT="$DATA_DIR/backups/richman-backup-$(date +%Y%m%d-%H%M%S)"
fi
[ -e "$OUT" ] && die BACKUP_OUT_EXISTS "输出目录已存在：$OUT" 2

ARGS=(create --data "$DATA_DIR" --out "$OUT")
[ "$WITH_AUDIT" -eq 1 ] && ARGS+=(--with-audit)
[ -n "$KEEP" ] && ARGS+=(--keep "$KEEP")

"$NODE" "$CLI" "${ARGS[@]}"
log "备份完成：$OUT"
log "备份含身份摘要与私有账务，不得公开或上传。"
