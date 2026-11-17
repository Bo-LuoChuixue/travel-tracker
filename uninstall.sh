#!/usr/bin/env bash
# 我的轨迹 — 一键卸载脚本（Ubuntu / Debian 服务器）
#
# 用法（在服务器上，一行命令，不需要参数，域名自动从 nginx 配置里读）：
#   curl -fsSL https://raw.githubusercontent.com/Bo-LuoChuixue/travel-tracker/main/uninstall.sh | sudo bash
#
# 运行后会先问一句：行程数据要保留还是删除？
#   - 保留：删程序前把行程数据库 + .env 备份到
#     /root/travel-tracker-backup-<时间>.tar.gz，数据不会丢
#   - 删除（默认，直接回车）：连数据一起删掉，不留备份
# 非交互运行（没有终端可问）时默认删除。也可以直接传参数跳过提问：
#   curl ... | sudo bash -s -- --keep-data     # 保留数据
#   curl ... | sudo bash -s -- --delete-data   # 删除数据
#
# 脚本会做这些事：
#   1. 停止并删除 systemd 服务 travel-tracker
#   2. 删除 nginx 站点配置 travel-tracker.conf 并 reload
#   3. 删除该域名的 Let's Encrypt 证书（域名从 nginx 配置里自动读取）
#   4. 备份数据（行程数据库 + .env）到 /root/travel-tracker-backup-<时间>.tar.gz
#   5. 删除 /opt/travel-tracker
#
# 不会动的东西：
#   - Node.js、nginx、certbot（系统软件，其他服务也可能在用）
#   - 云厂商安全组 / 主机防火墙的 80、443 规则
#   - 备份文件（删完程序，数据还在 /root/，随时能恢复）
#
# 恢复方法：重新跑一键部署，再把备份里的 data/ 和 .env 解压回
# /opt/travel-tracker/，然后 sudo systemctl restart travel-tracker。
set -euo pipefail

APP_DIR="/opt/travel-tracker"
SERVICE_FILE="/etc/systemd/system/travel-tracker.service"
NGINX_CONF="/etc/nginx/sites-enabled/travel-tracker.conf"

# 数据怎么处理：--keep-data / --delete-data 可直接指定；不指定就问一句
KEEP_DATA=""
for arg in "$@"; do
  case "$arg" in
    --keep-data)   KEEP_DATA="yes" ;;
    --delete-data) KEEP_DATA="no" ;;
    -h|--help)
      echo "用法：uninstall.sh [--keep-data | --delete-data]"
      echo "  --keep-data    保留行程数据（备份到 /root/）"
      echo "  --delete-data  连行程数据一起删掉，不留备份"
      echo "  不传参数时，脚本会问你选哪一种（默认删除）"
      exit 0
      ;;
    *) echo "未知参数：$arg（可用 --keep-data 或 --delete-data）" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 或 sudo 运行：curl ... | sudo bash" >&2
  exit 1
fi

if [ -z "$KEEP_DATA" ]; then
  if [ -r /dev/tty ]; then
    echo "行程数据（数据库 + .env）要保留还是删除？"
    echo "  [1] 保留：删程序前备份到 /root/travel-tracker-backup-<时间>.tar.gz"
    echo "  [2] 删除（默认）：连数据一起删掉，不留备份"
    printf "请选择 [1/2]（直接回车默认删除）："
    read -r choice < /dev/tty || choice=""
    case "$choice" in
      1) KEEP_DATA="yes" ;;
      *) KEEP_DATA="no" ;;
    esac
  else
    echo "没有终端可提问，默认删除数据。"
    KEEP_DATA="no"
  fi
fi
if [ "$KEEP_DATA" = "yes" ]; then
  echo "已选择：保留数据。"
else
  echo "已选择：删除数据。行程数据库和 .env 将一起删掉，不留备份。"
fi

# 域名：从 nginx 配置的 server_name 里读
DOMAIN=""
if [ -f "$NGINX_CONF" ]; then
  DOMAIN="$(sed -n 's/^[[:space:]]*server_name[[:space:]]\+\([^;]*\);.*/\1/p' "$NGINX_CONF" | head -n1 | awk '{print $1}')"
fi

echo "==> [1/5] 停止并删除服务 travel-tracker..."
systemctl stop travel-tracker 2>/dev/null || true
systemctl disable -q travel-tracker 2>/dev/null || true
rm -f "$SERVICE_FILE"
systemctl daemon-reload
echo "    服务已删"

echo "==> [2/5] 删除 nginx 配置..."
rm -f "$NGINX_CONF"
if command -v nginx >/dev/null 2>&1; then
  nginx -t -q && systemctl reload nginx
fi
echo "    nginx 配置已删"

echo "==> [3/5] 删除 HTTPS 证书..."
if [ -n "$DOMAIN" ] && command -v certbot >/dev/null 2>&1; then
  if certbot certificates 2>/dev/null | grep -q "Certificate Name: $DOMAIN"; then
    certbot delete --cert-name "$DOMAIN" --non-interactive -q
    echo "    证书 $DOMAIN 已删"
  else
    echo "    没有找到 $DOMAIN 的证书，跳过"
  fi
else
  echo "    域名读不到或未装 certbot，跳过（nginx 配置可能已被手动删掉）"
fi

echo "==> [4/5] 处理数据..."
BACKUP=""
if [ "$KEEP_DATA" = "yes" ]; then
  if [ -d "$APP_DIR/data" ] || [ -f "$APP_DIR/.env" ]; then
    BACKUP="/root/travel-tracker-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    ITEMS=""
    [ -d "$APP_DIR/data" ] && ITEMS="$ITEMS data"
    [ -f "$APP_DIR/.env" ] && ITEMS="$ITEMS .env"
    tar -czf "$BACKUP" -C "$APP_DIR" $ITEMS
    echo "    数据已备份到 $BACKUP（行程数据库 + .env，删了程序数据还在）"
  else
    echo "    没有数据可备份"
  fi
else
  echo "    按选择删除数据，不做备份"
fi

echo "==> [5/5] 删除程序目录 $APP_DIR..."
rm -rf "$APP_DIR"
echo "    程序已删"

echo
echo "卸载完成。"
if [ "$KEEP_DATA" = "yes" ]; then
  [ -n "$BACKUP" ] && echo "数据备份在：$BACKUP（想恢复时，先重新部署，再把里面的 data/ 和 .env 解压回 /opt/travel-tracker/）"
else
  echo "数据已按选择删除，没有留下备份。"
fi
echo "留下的东西：Node.js、nginx、certbot 还在（系统软件，其他服务可能在用）；"
echo "防火墙 80、443 规则没动，需要的话自己去云厂商后台关。"
