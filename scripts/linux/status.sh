#!/usr/bin/env bash
# RichMan Linux 状态检查：systemd 状态 + /health。只读，不启动/不修改。
# 用法：bash scripts/status.sh [--json] [--port 8000]
set -euo pipefail

SERVICE=richman
ENV_FILE=/etc/richman/richman.env
PORT=""
JSON=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --json) JSON=1; shift ;;
    --port) [ "$#" -ge 2 ] || { echo "ERROR [BAD_ARGUMENT] --port 缺少值" >&2; exit 2; }; PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "ERROR [BAD_ARGUMENT] 未知参数：$1" >&2; exit 2 ;;
  esac
done

if [ -z "$PORT" ] && [ -r "$ENV_FILE" ]; then
  PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '[:space:]')"
fi
[ -n "$PORT" ] || PORT=8000

ACTIVE=inactive
if command -v systemctl >/dev/null 2>&1; then
  ACTIVE="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  [ -n "$ACTIVE" ] || ACTIVE=inactive
fi

BODY=""
if command -v curl >/dev/null 2>&1; then
  BODY="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
elif [ -x /opt/richman/node/bin/node ]; then
  BODY="$(/opt/richman/node/bin/node -e "fetch('http://127.0.0.1:$PORT/health').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" 2>/dev/null || true)"
fi

OK=0
case "$BODY" in *'"ok":true'*) OK=1 ;; esac

if [ "$JSON" -eq 1 ]; then
  printf '{"ok":%s,"service":"%s","active":"%s","port":%s,"health":%s}\n' \
    "$([ "$OK" -eq 1 ] && echo true || echo false)" "$SERVICE" "$ACTIVE" "$PORT" "${BODY:-null}"
  [ "$OK" -eq 1 ] && exit 0 || exit 1
fi

echo "服务：$SERVICE（$ACTIVE）"
echo "端口：$PORT"
if [ "$OK" -eq 1 ]; then
  echo "健康：$BODY"
  exit 0
fi
echo "健康：不可用（/health 无响应或返回异常）"
exit 1
