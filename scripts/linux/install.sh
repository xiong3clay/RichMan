#!/usr/bin/env bash
# RichMan Linux 安装脚本：创建系统用户、安装到 /opt/richman、写 /etc/richman/richman.env、注册 systemd。
# 用法：sudo bash scripts/install.sh [--port 8000] [--prefix /opt/richman] [--data-dir /var/lib/richman] [--no-start] [--force]
set -euo pipefail

SERVICE=richman
PORT=8000
PREFIX=/opt/richman
DATA_DIR=/var/lib/richman
ENV_DIR=/etc/richman
ENV_FILE="$ENV_DIR/richman.env"
UNIT_FILE="/etc/systemd/system/$SERVICE.service"
START=1
FORCE=0
DOCTOR_ONLY=0

log() { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die() { printf 'ERROR [%s] %s\n' "$1" "$2" >&2; exit "${3:-1}"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--port 缺少值" 2; PORT="$2"; shift 2 ;;
    --prefix) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--prefix 缺少值" 2; PREFIX="${2%/}"; shift 2 ;;
    --data-dir) [ "$#" -ge 2 ] || die BAD_ARGUMENT "--data-dir 缺少值" 2; DATA_DIR="${2%/}"; shift 2 ;;
    --no-start) START=0; shift ;;
    --force) FORCE=1; shift ;;
    --check) DOCTOR_ONLY=1; shift ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) die BAD_ARGUMENT "未知参数：$1" 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(dirname "$SCRIPT_DIR")"
NODE_BIN="$PKG_ROOT/node/bin/node"

[ "$(id -u)" -eq 0 ] || die NOT_ROOT "请用 root 运行：sudo bash scripts/install.sh" 1
case "$PORT" in ''|*[!0-9]*) die BAD_ARGUMENT "端口必须是 1-65535 的整数" 2 ;; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die BAD_ARGUMENT "端口必须是 1-65535 的整数" 2
[ -f "$PKG_ROOT/app/server/server.mjs" ] || die PACKAGE_INCOMPLETE "包内缺少 app/server/server.mjs，请在解压后的目录内运行" 1
[ -x "$NODE_BIN" ] || die NODE_MISSING "包内缺少可执行的 node/bin/node" 1

NODE_VERSION_RAW="$("$NODE_BIN" --version 2>/dev/null || true)"
case "$NODE_VERSION_RAW" in
  v2[2-9].*|v[3-9][0-9].*) : ;;
  *) die NODE_MISSING "内置 Node 版本不可用（需要 v22+）：$NODE_VERSION_RAW" 1 ;;
esac

if [ "$DOCTOR_ONLY" -eq 0 ]; then
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    die SYSTEMD_MISSING "本机没有运行 systemd（容器或精简系统）。可参考使用说明-Linux.txt 第六节手动启动。" 3
  fi
fi

if command -v ss >/dev/null 2>&1 && [ "$FORCE" -eq 0 ]; then
  if [ "$DOCTOR_ONLY" -eq 0 ] && ! systemctl is-active --quiet "$SERVICE"; then
    if [ -n "$(ss -ltnH "sport = :$PORT" 2>/dev/null || true)" ]; then
      die PORT_IN_USE "TCP $PORT 已被占用；换端口：--port 8081" 1
    fi
  fi
fi

if [ "$DOCTOR_ONLY" -eq 1 ]; then
  log "node=$NODE_VERSION_RAW port=$PORT prefix=$PREFIX data=$DATA_DIR"
  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    log "systemd=yes"
  else
    warn "systemd=no（安装会失败，可用 --check 先确认）"
  fi
  exit 0
fi

if ! getent passwd "$SERVICE" >/dev/null 2>&1; then
  log "创建系统用户 $SERVICE"
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --user-group "$SERVICE" 2>/dev/null \
    || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE"
fi

log "安装应用 → $PREFIX"
install -d -m 0755 "$PREFIX" "$PREFIX/node/bin"
rm -rf "$PREFIX/.app.new" "$PREFIX/.app.old"
cp -a "$PKG_ROOT/app" "$PREFIX/.app.new"
if [ -d "$PREFIX/app" ]; then mv "$PREFIX/app" "$PREFIX/.app.old"; fi
mv "$PREFIX/.app.new" "$PREFIX/app"
rm -rf "$PREFIX/.app.old"
install -m 0755 "$NODE_BIN" "$PREFIX/node/bin/node"
install -m 0644 "$PKG_ROOT/node/LICENSE.txt" "$PREFIX/node/LICENSE.txt"

log "准备数据目录 → $DATA_DIR"
install -d -m 0750 -o "$SERVICE" -g "$SERVICE" "$DATA_DIR"

install -d -m 0750 -o root -g "$SERVICE" "$ENV_DIR"
if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE 已存在，保留原配置（如需换端口请手动改后重启）"
  if ! grep -q '^RICHMAN_STATIC_DIR=' "$ENV_FILE"; then
    printf 'RICHMAN_STATIC_DIR=%s/app/web/dist\n' "$PREFIX" >> "$ENV_FILE"
  fi
else
  log "写配置 → $ENV_FILE"
  umask 0027
  cat > "$ENV_FILE" <<EOF
# RichMan 运行配置（由 install.sh 生成；改完 systemctl restart richman）
PORT=$PORT
RICHMAN_DATA_DIR=$DATA_DIR
RICHMAN_STATIC_DIR=$PREFIX/app/web/dist
# RICHMAN_MAX_CONNECTIONS=200
# RICHMAN_MAX_CONNECTIONS_PER_IP=20
# RICHMAN_MAX_ROOMS=50
# RICHMAN_ALLOWED_ORIGINS=https://richman.example.com
# RICHMAN_TRUST_PROXY=1
EOF
  umask 0022
fi
chown root:"$SERVICE" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

log "安装 systemd 单元 → $UNIT_FILE"
sed -e "s|@PREFIX@|$PREFIX|g" -e "s|@DATA_DIR@|$DATA_DIR|g" -e "s|@NODE@|$PREFIX/node/bin/node|g" \
  "$PKG_ROOT/systemd/richman.service" > "$UNIT_FILE"
chmod 0644 "$UNIT_FILE"

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

if [ "$START" -eq 1 ]; then
  log "启动服务"
  systemctl restart "$SERVICE"
  HEALTH_URL="http://127.0.0.1:$PORT/health"
  healthy=0
  for _ in $(seq 1 30); do
    if command -v curl >/dev/null 2>&1; then
      if curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then healthy=1; break; fi
    else
      if "$PREFIX/node/bin/node" -e "fetch(process.argv[1]).then(r=>r.json()).then(j=>process.exit(j.ok===true?0:1)).catch(()=>process.exit(1))" "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
    fi
    sleep 1
  done
  if [ "$healthy" -ne 1 ]; then
    systemctl status "$SERVICE" --no-pager -l >&2 || true
    journalctl -u "$SERVICE" -n 30 --no-pager >&2 || true
    die HEALTH_TIMEOUT "服务 30 秒内未通过 /health 检查；日志见上。" 4
  fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<服务器IP>"
log ""
log "RichMan 安装完成。"
log "本机访问：http://127.0.0.1:$PORT/"
log "公网访问：http://$IP:$PORT/  （云服务器请在安全组放行 TCP $PORT）"
log "状态：systemctl status $SERVICE"
log "日志：journalctl -u $SERVICE -f"
log "配置：$ENV_FILE"
log "数据：$DATA_DIR"
log "防火墙示例：ufw allow $PORT/tcp  或  firewall-cmd --add-port=$PORT/tcp --permanent"
