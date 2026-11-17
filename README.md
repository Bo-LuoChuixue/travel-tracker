# 我的轨迹 — 飞行与火车出行记录网站

记录飞行航线和火车出行轨迹的网站：用户注册登录（邮箱验证码）、在地图上查看出行轨迹、按日期浏览行程列表。界面采用 iOS 27 液态玻璃风格。

## 一键部署（新服务器，一行命令）

```bash
curl -fsSL https://raw.githubusercontent.com/boluochuixue/travel-tracker/main/deploy.sh \
  | sudo bash -s <你的域名>
```

脚本会自动安装 Node.js 20、nginx、certbot，拉代码、装依赖、生成 `.env`（随机 JWT_SECRET）、起 systemd 服务、配 nginx、申请 HTTPS 证书。部署前请先做好两件事：域名的 A 记录指向这台服务器；防火墙放行 80 和 443 端口。部署完成后打开 `https://<你的域名>/`，第一个注册的用户自动成为管理员（无需验证码），再去「⚙️ 设置」里填发件邮箱和授权码。

> 隐私说明：这个仓库里没有任何隐私数据——`.env`（JWT 密钥）、`data/`（数据库：用户、行程、邮箱配置、API Key）都在 `.gitignore` 里，永远不会提交。发件邮箱、飞常准 Key、高德 Key 都是部署后在网站的管理员设置页里填的，只保存在你自己服务器的数据库里。

## 技术栈

- 后端：Node.js + Express + SQLite（better-sqlite3）
- 前端：原生 HTML/CSS/JS，无构建步骤；地图使用 Leaflet（unpkg CDN）
- 认证：bcrypt 密码哈希 + JWT（7 天有效期）
- 邮件：nodemailer（SMTP，管理员在网站设置页里配置，常用 163 邮箱）

## 功能

- 注册/登录/找回密码（邮箱验证码，同一邮箱每小时最多 5 次）
- 飞行、火车行程的增删改查；行程列表按日期分组，可按 ✈️ 飞行 / 🚄 火车筛选
- 全屏地图画轨迹线（飞行蓝色、火车黑色），同线路多行程自动错开画成平行弧线
- 航班号 + 日期一键查航班（飞常准 CMCP，30 天缓存），多段航班弹窗任选；航司小 logo 自动匹配，点 logo 可手动换（粘贴地址或本地上传图片，支持 PNG/JPG/GIF/WebP/SVG/BMP/ICO）
- 统计面板分 ✈️ 飞行 / 🚄 火车两页：次数、时长、去过的机场/车站 Top 10
- 昵称规则：最多 12 个字符（汉字算 2 个），仅限中英文；密码 8–20 位，需同时含字母和数字
- 管理员设置页：发件邮箱 + 授权码、飞常准 Key、高德 Key、测试邮件

## 快速开始（本地）

```bash
cd travel-tracker
npm install
cp .env.example .env   # 按需填写
node server.js
```

打开 http://localhost:3000 即可使用。默认端口 3000，可用 `PORT` 环境变量修改。

## 环境变量（.env）

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| PORT | 监听端口 | 3000 |
| JWT_SECRET | JWT 签名密钥（生产务必改成随机长字符） | 开发默认值 |
| SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM | 发件邮箱配置（可选；作为管理员设置页的备用默认值） | — |

> 未配置 SMTP 时，验证码会打印到服务器控制台（开发模式可用），接口仍返回成功，但响应中不包含验证码。发件邮箱推荐在网站的管理员设置页里配置，不用改服务器文件。

## 管理员与邮件设置

- **第一个注册的用户自动成为管理员**：无需邮箱验证码，可直接登录。之后由管理员在网站右上角「⚙️ 设置」里填写发件邮箱和授权码，其他用户注册时再走正常的邮箱验证码流程。
- 管理员设置页可配置：SMTP 服务器、端口、发件邮箱、授权码、发件人，并可发送测试邮件验证。授权码留空表示不修改已保存的值；授权码本身永不回显到前端。
- 发件配置优先读数据库（设置页），再读 `.env` 里的 SMTP 变量；都没配时验证码打印到服务器控制台。

163 邮箱授权码获取：登录 163 邮箱 → 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 获取授权码。SMTP 服务器填 `smtp.163.com`，端口填 `465`。

## API

认证（无需登录）：

- `POST /api/auth/register` `{email, password, name}` — 注册并发送 6 位验证码（15 分钟有效）
- `POST /api/auth/verify` `{email, code}` — 验证邮箱
- `POST /api/auth/login` `{email, password}` — 登录，返回 JWT token
- `POST /api/auth/forgot` `{email}` — 发送重置验证码
- `POST /api/auth/reset` `{email, code, newPassword}` — 重置密码
- `GET /api/auth/me` — 需 `Authorization: Bearer <token>`

行程（均需 JWT）：

- `GET /api/trips` — 当前用户的行程列表（按出发时间倒序）
- `POST /api/trips` — 新建行程（必填：type、dep_name、arr_name、dep_time）
- `PUT /api/trips/:id` — 修改自己的行程
- `DELETE /api/trips/:id` — 删除自己的行程
- `GET /api/stats` — `{flights, trains, total}`

验证码请求限流：同一邮箱每小时最多 5 次。

管理员（需管理员账号的 JWT）：

- `GET /api/admin/settings` — 读取当前邮件配置（授权码不回显，只返回是否已设置）
- `POST /api/admin/settings` `{smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from}` — 保存邮件配置，授权码留空表示不修改
- `POST /api/admin/test-email` — 向管理员自己的邮箱发送一封测试邮件

## 数据

SQLite 数据库文件位于 `./data/travel.db`（首次启动自动创建）：

- `users` — 用户（邮箱唯一、密码哈希、邮箱验证状态、`is_admin` 管理员标志）
- `settings` — 网站设置（键值对，存放管理员在设置页里填的 SMTP 配置）
- `verification_codes` — 验证码（用途 register/reset、15 分钟过期、一次性）
- `trips` — 行程（flight/train、航班号/车次、出发到达地名与经纬度、时间、座位、备注）

机场数据：`public/airports.json`（65 个主要机场，IATA 代码 + 经纬度）；
火车站数据：`public/stations.json`（52 个主要中国火车站 + 经纬度，含都江堰站、犀浦站）。
添加行程时可从列表选择（自动填经纬度），也可以自由输入地名并手动填经纬度。

## 部署到 Oracle 服务器（Ubuntu 26.04 ARM64 + Nginx）

```bash
# 1. 安装 Node.js 20+（示例使用 NodeSource）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 2. 上传代码并安装依赖
cd /opt/travel-tracker
npm install --omit=dev

# 3. 配置环境变量
cp .env.example .env
nano .env   # 填 JWT_SECRET、SMTP_USER、SMTP_PASS 等

# 4. 用 systemd 托管（示例）
sudo tee /etc/systemd/system/travel-tracker.service > /dev/null <<'EOF'
[Unit]
Description=Travel Tracker
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/travel-tracker
EnvironmentFile=/opt/travel-tracker/.env
ExecStart=/usr/bin/node server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now travel-tracker

# 5. Nginx 反代（示例，域名换成自己的）
sudo tee /etc/nginx/sites-available/travel-tracker > /dev/null <<'EOF'
server {
    listen 80;
    server_name travel.example.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
sudo ln -s /etc/nginx/sites-available/travel-tracker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
# 再用 certbot 配 HTTPS（略）
```

> 注意：`better-sqlite3` 使用预编译二进制，ARM64 上 `npm install` 无需编译。
> 数据库文件在 `./data/travel.db`，做好定期备份。

## 航班自动查询

在「添加行程」里选「飞行」，填好航班号（例如 CA1831）和出发日期，点「🔍 查航班」，会自动查出该航班的起降机场和计划起降时间并填好（机场按 IATA 代码匹配内置机场库，自动带上经纬度；起降时间取航班当地时间）。查询只按航班号 + 出发日期，不带时间（没填出发时间就查今天）。同一航班号一日内有多段时，会弹窗列出各段让你选一段。识别到航空公司后，航空公司输入框右侧会自动显示该航司的小 logo（按航班号前两位 IATA 代码取 Kiwi 的免费 logo，没有对应 logo 时不显示）。到达时间不能早于出发时间（填表时实时提示，提交和服务端都会拦截）。

- 数据源：飞常准 CMCP（cmcp.variflight.com）的 getFlightStatus 工具。在飞常准 CMCP 控制台创建 API Key，填在网站「⚙️ 设置」→「航班查询 API Key」里（Key 只保存在服务器数据库，不会回显）。
- 查过的航班会缓存 30 天（`flight_cache` 表），同一航班同一日期重复查不消耗额度。
- 没配 Key 时点查询会提示去设置里填写；机场不在内置的 65 个机场列表里时，只填名字、坐标需手动补。

本站通过 HTTPS 对外提供服务，部署时除了服务器本机防火墙，别忘了云厂商的安全组/安全列表也要放行 80 和 443 端口，否则公网 HTTPS 请求会在云厂商侧被拦截（表现为超时），而服务器本地 curl 却是通的。

## 地图（高德）

登录后是全屏地图，右上角小图标切换图层：**高德标准**（默认）、**高德卫星**，另有「路网标注」叠加层（在卫星图上显示路名）。底部是 iOS 27 液态玻璃 Dock 栏：添加、行程、统计、设置，点一下弹出对应悬浮面板，再点一下或点地图收起。Dock 按钮带轮廓光（外层柔光 + 内层亮边）；当前打开面板对应的按钮轮廓光最亮（双层主题色光晕 + 更亮的内边），一眼就能看出停在哪一页；鼠标滑过按钮时按钮会往上弹 6px，比别的按钮高一点（带回弹的动画），按下去时会微微回落。顶部没有横幅；切换用户和退出登录在 Dock 的「设置」面板里（账号区，所有登录用户可见；邮件和航班 Key 设置仅管理员可见）。「设置」里还有外观区：液态玻璃透明度滑杆（0~100 无级调节，默认 12%，存在浏览器本地，改完立即生效）和深色/浅色切换。透明度滑杆控制的是整块玻璃的效果：背景、模糊、边框、阴影都跟着滑杆走，滑到 0 时玻璃就完全看得穿（之前只调了背景，24px 的模糊还留着，所以 0 看着还是雾蒙蒙的）。地图左下角是行程提示：没行程时提示去添加，有行程时显示「已加载 x 条航线[蓝]，x 条铁路线[黑]。」（小段颜色跟在文字后面，与地图上的线同色：航线蓝色、铁路线黑色）。右下角没有 Leaflet 署名行。地图上的线路只有线、没有定位标，路线两端显示地名标签（小圆角深色 pill，悬在端点下方，10px 字，如「都江堰」「犀浦」）。设置 → 外观里可以切换地图源：高德地图（标准/卫星，卫星自动叠加路网标注）或 OpenStreetMap（标准地图 / 卫星地图）；另有「显示地名」开关（默认开）：关掉后底图换成无地名的干净底图（标准图用 Esri 深灰底图——之前用的浅灰底图太淡，道路几乎看不见；卫星图本身无地名），只留轨迹两端的地名标签。深灰底图上航线是浅蓝、铁路线是白色、地名标签是白底小 pill（有地名时是蓝线/黑线/深色 pill）。注意：CartoDB 底图（basemaps.cartocdn.com）现已要求 API Key，会返回「API KEY REQUIRED」占位图，已弃用，改用无需 Key 的 Esri 瓦片服务。

注意：数据库和内置机场/车站存的都是 WGS-84（GPS 坐标）。高德用 GCJ-02 坐标系，同一个点在国内会差约数百米，所以画线时按当前地图源换算：高德 → WGS-84 转 GCJ-02 再画（`app.js` 里 `toMapCoords` / `wgs84ToGcj02`），OSM → 直接用 WGS-84；切地图源时自动按新坐标系重画路线。高德地理编码返回的是 GCJ-02，存库前先转回 WGS-84（`gcj02ToWgs84`，往返误差约 0.2 米）。

## 同线路多行程

同一对地点、同一类型的多条行程按顺序依次增大弧度，画成一组平行弧线：飞机第一条弧度正常、往后每条更弯；火车第一条直线、往后每条依次变弯，不会再完全重叠。

## 添加行程字段顺序（飞行）

航班号 → 出发时间 → 查航班 → 到达时间 → 出发机场 → 到达机场 → 航空公司 → 机型 → 座位号 → 备注。机型是新增字段（`trips.aircraft`，旧库启动时自动补列）。经纬度输入框已删除（2026-11-15）：坐标优先从内置机场/车站库取（匹配时去掉“站/机场”后缀再比，“都江堰”能匹配“都江堰站”）；不在库里的地名调用高德地理编码查真实坐标（需要管理员在设置里填高德 Web 服务 API Key，lbs.amap.com 免费申请），结果缓存 180 天；未配 Key 且不在库里时，行程仍可保存、只是在地图上画不出这条线。出发/到达是纯文本输入，没有下拉选择（2026-11-15 改动）：查航班自动识别填入，或手动输入。出发/到达输入框的提示按类型切换：飞行显示「输入出发机场/到达机场」，火车显示「输入出发车站/到达车站」。地图上的路线两端显示地名文字标签（无图钉）。
