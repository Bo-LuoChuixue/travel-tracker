#!/usr/bin/env bash
# 我的轨迹 — 一键部署脚本（Ubuntu / Debian 服务器）
#
# 用法（在新服务器上，一行命令；仓库是私有的，需要一个只读 token）：
#   curl -fsSL -H "Authorization: Bearer <你的只读 token>" \
#     https://raw.githubusercontent.com/Bo-LuoChuixue/travel-tracker/main/deploy.sh \
#     | sudo GH_TOKEN=<你的只读 token> bash -s <你的域名> [分支]
# 例如：
#   curl -fsSL -H "Authorization: Bearer ghp_xxx" \
#     https://raw.githubusercontent.com/Bo-LuoChuixue/travel-tracker/main/deploy.sh \
#     | sudo GH_TOKEN=ghp_xxx bash -s travel.example.com
#
# 只读 token 获取（细粒度 PAT，只给这一个仓库的读权限）：
#   GitHub → Settings → Developer settings → Personal access tokens →
#   Fine-grained tokens → Generate new token → Repository access 选
#   Only select repositories → 选 travel-tracker → Permissions 里
#   Contents 选 Read-only → Generate token。
# 这个 token 只用来拉代码，丢了/泄露了随时可以在同一页删掉重建。
#
# 脚本会做这些事（幂等，可重复跑）：
#   1. 安装 Node.js 20、nginx、certbot
#   2. 把代码拉到 /opt/travel-tracker（已有则 git pull 更新）
#   3. npm install --omit=dev
#   4. 生成 .env（PORT=3000 + 随机 JWT_SECRET；已有 .env 不动）
#   5. 创建并启动 systemd 服务 travel-tracker（只重启这一个服务）
#   6. 写 nginx 配置并 reload；用 certbot 申请 HTTPS 证书
#
# 需要你事先做好两件事：
#   - 域名 DNS 的 A 记录指向这台服务器的公网 IP
#   - 服务器防火墙放行 80 和 443 端口（云厂商安全组 + 主机防火墙）
# 证书申请失败不影响部署：网站仍可通过 HTTP 访问，之后再跑
#   sudo certbot --nginx -d <你的域名>
# 即可补办证书。
#
# 部署完成后：
#   - 打开 https://<你的域名>/，第一个注册的用户自动成为管理员，无需验证码
#   - 管理员在网站右上角「⚙️ 设置」里填发件邮箱和授权码，之后其他用户
#     注册才走邮箱验证码流程
set -euo pipefail

DOMAIN="${1:-}"
BRANCH="${2:-main}"
# 私有仓库：传 GH_TOKEN（只读 PAT）即可，脚本自动用它拉代码；
# 也可以直接传 REPO_URL（带 token 的克隆地址），此时 GH_TOKEN 不生效。
if [ -n "${GH_TOKEN:-}" ] && [ -z "${REPO_URL:-}" ]; then
  REPO_URL="https://x-access-token:${GH_TOKEN}@github.com/Bo-LuoChuixue/travel-tracker.git"
else
  REPO_URL="${REPO_URL:-https://github.com/Bo-LuoChuixue/travel-tracker.git}"
fi
APP_DIR="/opt/travel-tracker"

if [ -z "$DOMAIN" ]; then
  echo "用法: $0 <域名> [分支]" >&2
  echo "例如: $0 travel.example.com" >&2
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 或 sudo 运行：curl ... | sudo bash -s $DOMAIN" >&2
  exit 1
fi

echo "==> [1/6] 安装 Node.js 20、nginx、certbot..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates nginx python3-certbot-nginx >/dev/null
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -q '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    node $(node --version)，npm $(npm --version)"

echo "==> [2/6] 拉取代码到 $APP_DIR..."
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" checkout -q "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  rm -rf "$APP_DIR"
  git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

echo "==> [3/6] 安装依赖..."
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

echo "==> [4/6] 生成 .env（已有则不动）..."
if [ ! -f "$APP_DIR/.env" ]; then
  JWT_SECRET="$(openssl rand -hex 32)"
  printf 'PORT=3000\nJWT_SECRET=%s\n' "$JWT_SECRET" > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "    已生成新的 JWT_SECRET"
else
  echo "    .env 已存在，保持不变"
fi
mkdir -p "$APP_DIR/data"
chown -R "$(logname 2>/dev/null || echo ubuntu):$(logname 2>/dev/null || echo ubuntu)" "$APP_DIR" 2>/dev/null || chown -R 1000:1000 "$APP_DIR"

echo "==> [5/6] 配置并启动 travel-tracker 服务..."
cat > /etc/systemd/system/travel-tracker.service <<EOF
[Unit]
Description=Travel Tracker - flight and train trip records
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server.js
Restart=always
EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q travel-tracker
systemctl restart travel-tracker
sleep 2
systemctl is-active -q travel-tracker || { echo "服务启动失败，查看日志：journalctl -u travel-tracker -n 50" >&2; exit 1; }
curl -fsS -o /dev/null http://127.0.0.1:3000/ && echo "    本地 http://127.0.0.1:3000 已通"

echo "==> [6/6] 配置 nginx + 申请 HTTPS 证书..."
cat > /etc/nginx/sites-enabled/travel-tracker.conf <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF
nginx -t -q
systemctl reload nginx
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect; then
  echo "    HTTPS 证书已申请并启用"
else
  echo "    证书申请失败（常见原因：DNS 还没指向本机、80 端口未放行）"
  echo "    网站仍可通过 http://$DOMAIN/ 访问，修好 DNS/防火墙后运行："
  echo "      sudo certbot --nginx -d $DOMAIN"
fi

echo
echo "部署完成：https://$DOMAIN/"
echo "第一个注册的用户自动成为管理员（无需验证码），再去「⚙️ 设置」里填发件邮箱和授权码。"
