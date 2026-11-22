require('dotenv').config();
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path = require('path');
const db = require('./db');

const app = express();
app.use(express.json({ limit: '1mb'}));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
if (!process.env.JWT_SECRET) {
console.warn('[警告] 未设置 JWT_SECRET 环境变量，使用开发默认值，生产环境请务必设置！');
}
const CODE_TTL_MS = 15 * 60 * 1000; // 验证码 15 分钟有效
const JWT_EXPIRES = '7d';

// ---------- 邮件 ----------
// 发件配置优先读数据库（管理员在设置页里填），再读 .env；都没配则打印到控制台。
function getSetting(key) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : '';
  } catch (e) {
    return '';
  }
}
function getMailConfig() {
  return {
    host: getSetting('smtp_host') || process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(getSetting('smtp_port') || process.env.SMTP_PORT || '587', 10),
    user: getSetting('smtp_user') || process.env.SMTP_USER || '',
    pass: getSetting('smtp_pass') || process.env.SMTP_PASS || '',
    from: getSetting('smtp_from') || process.env.SMTP_FROM || '',
  };
}
function getTransporter() {
  const c = getMailConfig();
  if (!c.user || !c.pass) return null;
  return nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,
    auth: { user: c.user, pass: c.pass },
  });
}
function mailConfigured() {
  const c = getMailConfig();
  return Boolean(c.user && c.pass);
}

// ---------- 航班查询 ----------
// 数据源：飞常准 CMCP（cmcp.variflight.com）的 getFlightStatus 工具。
// API Key 优先读数据库（管理员在设置页里填），再读 .env 的 VARIFLIGHT_KEY。
function getFlightApiKey() {
  return getSetting('flight_api_key') || process.env.VARIFLIGHT_KEY || '';
}

// ---------- 飞常准 CMCP MCP 调用 ----------
// 飞常准 CMCP 平台（cmcp.variflight.com）的 MCP 服务：c-gw.variflight.com/chat_message/mcp/api。
// 认证：Authorization: Bearer <Key>；会话：initialize 后取响应头 Mcp-Session-Id，后续调用带上。
// 查航班用 getFlightStatus 工具（fnum 航班号、date 日期），返回 structuredContent.items 全部
// （同一航班号一日内可能有多段，例如早上一段、晚上一段，都要返回给前端让用户选）。
async function variflightGetFlightStatus(key, flight, date) {
  const base = 'https://c-gw.variflight.com/chat_message/mcp/api';
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: 'Bearer ' + key,
  };
  // 1) initialize，取会话 ID
  const init = await fetch(base, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'travel-tracker', version: '1.0' },
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const sessionId = init.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('飞常准未返回会话 ID');
  // 2) tools/call getFlightStatus
  const call = await fetch(base, {
    method: 'POST',
    headers: { ...headers, 'Mcp-Session-Id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'getFlightStatus', arguments: { fnum: flight, date } },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await call.text();
  // 响应可能是 SSE（data:{...}）或纯 JSON
  let body = text.trim();
  const m = body.match(/data:(.*)/s);
  if (m) body = m[1].trim();
  const data = JSON.parse(body);
  if (data.error) throw new Error('飞常准接口错误：' + (data.error.message || data.error.code || '未知错误'));
  const result = data.result || {};
  if (result.isError) {
    const msg = (result.content && result.content[0] && result.content[0].text) || '查询失败';
    throw new Error('飞常准查询失败：' + msg);
  }
  const items = (result.structuredContent && result.structuredContent.items) || [];
  if (!items.length) throw new Error('未找到航班');
  return items;
}
function flightCacheGet(flightIata, flightDate) {
  try {
    const row = db.prepare('SELECT data, created_at FROM flight_cache WHERE flight_iata = ? AND flight_date = ?').get(flightIata, flightDate);
    if (!row) return null;
    // 缓存 30 天有效（航班计划一般提前公布，过期后重新查）
    if (Date.now() - new Date(row.created_at).getTime() > 30 * 24 * 60 * 60 * 1000) return null;
    return JSON.parse(row.data);
  } catch (e) {
    return null;
  }
}
function flightCacheSet(flightIata, flightDate, data) {
  try {
    db.prepare(
      'INSERT INTO flight_cache (flight_iata, flight_date, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(flight_iata, flight_date) DO UPDATE SET data = excluded.data, created_at = excluded.created_at'
    ).run(flightIata, flightDate, JSON.stringify(data), new Date().toISOString());
  } catch (e) {
    console.error('[航班缓存] 写入失败：', e.message);
  }
}

// ---------- 地名解析（高德地理编码） ----------
// 用途：用户输入的机场/车站名不在内置库里时，调用高德地理编码 API 查真实坐标，
// 这样就不用依赖预设库。API Key 优先读数据库（管理员在设置页里填），再读 .env 的 AMAP_KEY。
// 高德免费额度：个人开发者地理编码每天 30 万次，足够用。返回坐标系为 GCJ-02，与地图一致。
function getAmapKey() {
  return getSetting('amap_api_key') || process.env.AMAP_KEY || '';
}
function placeCacheGet(name) {
  try {
    const row = db.prepare('SELECT lat, lon, created_at FROM place_cache WHERE name = ?').get(name);
    if (!row) return null;
    // 缓存 180 天有效（地名坐标基本不变）
    if (Date.now() - new Date(row.created_at).getTime() > 180 * 24 * 60 * 60 * 1000) return null;
    return { lat: row.lat, lon: row.lon };
  } catch (e) {
    return null;
  }
}
function placeCacheSet(name, lat, lon) {
  try {
    db.prepare(
      'INSERT INTO place_cache (name, lat, lon, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET lat = excluded.lat, lon = excluded.lon, created_at = excluded.created_at'
    ).run(name, lat, lon, new Date().toISOString());
  } catch (e) {
    console.error('[地名缓存] 写入失败：', e.message);
  }
}

async function sendCodeEmail(email, code) {
  const subject = '邮箱验证码';
  const text = `您好！\n\n您的邮箱验证码是：${code}\n\n该验证码 15 分钟内有效，请勿泄露给他人。\n\n—— 我的轨迹`;
  const html = `<p>您好！</p><p>您的邮箱验证码是：<strong style="font-size:24px;letter-spacing:4px;">${code}</strong></p><p>该验证码 15 分钟内有效，请勿泄露给他人。</p><p>—— 我的轨迹</p>`;
  const transporter = getTransporter();
  if (transporter) {
    const c = getMailConfig();
    await transporter.sendMail({
      from: c.from || c.user,
      to: email,
      subject,
      text,
      html,
    });
  } else {
    console.log(`[验证码] ${email} 的验证码是 ${code}（15 分钟内有效）`);
  }
}

// ---------- 验证码请求限流（内存） ----------
const codeRequests = new Map(); // email -> [timestamps]
function checkCodeRateLimit(email) {
const now = Date.now();
const list = (codeRequests.get(email) || []).filter((t) => now - t < 60 * 60 * 1000);
if (list.length >= 5) return false;
list.push(now);
codeRequests.set(email, list);
return true;
}

// ---------- 工具 ----------
function isValidEmail(email) {
return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}
// 密码：8-20 位，必须同时包含英文字母和数字
function isValidPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 20) return false;
  return /[A-Za-z]/.test(pw) && /[0-9]/.test(pw);
}
// 昵称长度：一个汉字算 2 个字符，最多 12 个字符（6 个汉字或 12 个字母数字）
function nameDisplayLength(name) {
  let len = 0;
  for (const ch of String(name)) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) len += 2;
    else len += 1;
  }
  return len;
}
function genCode() {
return String(Math.floor(100000 + Math.random() * 900000));
}
function nowIso() {
return new Date().toISOString();
}
function issueCode(email, purpose) {
const code = genCode();
const expiresAt = Date.now() + CODE_TTL_MS;
db.prepare(
'INSERT INTO verification_codes (email, code, purpose, expires_at, used, created_at) VALUES (?,?,?,?, 0,?)'
).run(email, code, purpose, expiresAt, nowIso());
return code;
}
function verifyCode(email, code, purpose) {
const row = db
.prepare(
'SELECT * FROM verification_codes WHERE email =? AND code =? AND purpose =? AND used = 0 ORDER BY id DESC LIMIT 1'
)
.get(email, code, purpose);
if (!row) return { ok: false, error: '验证码不正确'};
if (Date.now() > row.expires_at) return { ok: false, error: '验证码已过期，请重新获取'};
db.prepare('UPDATE verification_codes SET used = 1 WHERE id =?').run(row.id);
return { ok: true};
}

// ---------- JWT 鉴权中间件 ----------
function authMiddleware(req, res, next) {
const h = req.headers.authorization || '';
const m = h.match(/^Bearer\s+(.+)$/);
if (!m) return res.status(401).json({ ok: false, error: '请先登录'});
try {
const payload = jwt.verify(m[1], JWT_SECRET);
req.user = payload;
next();
} catch (e) {
return res.status(401).json({ ok: false, error: '登录已过期，请重新登录'});
}
}

// ---------- 认证 API ----------
app.post('/api/auth/register', async (req, res) => {
try {
const { email, password, name} = req.body || {};
if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: '邮箱格式不正确'});
if (!isValidPassword(password))
return res.status(400).json({ ok: false, error: '密码需要 8-20 位，且同时包含英文字母和数字'});
const nickname = String(name || '').trim();
if (nickname) {
  if (nameDisplayLength(nickname) > 12)
    return res.status(400).json({ ok: false, error: '昵称最多 12 个字符（一个汉字算 2 个字符）'});
  if (!/^[A-Za-z\u4e00-\u9fff\u3400-\u4dbf]+$/.test(nickname))
    return res.status(400).json({ ok: false, error: '昵称只能使用英文字母和汉字'});
}
const existing = db.prepare('SELECT * FROM users WHERE email =?').get(email);
if (existing && existing.email_verified === 1)
return res.status(400).json({ ok: false, error: '该邮箱已注册，请直接登录'});
// 第一个用户即站长：无需邮箱验证码，直接验证通过并设为管理员，
// 之后由管理员在设置页里配好发件邮箱，其他用户再走正常的邮箱验证流程。
const adminCount = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
if (adminCount === 0) {
const hash = await bcrypt.hash(password, 10);
if (existing) {
db.prepare('UPDATE users SET password_hash =?, name =?, email_verified = 1, is_admin = 1 WHERE email =?').run(
hash,
name || existing.name || '',
email
);
} else {
db.prepare('INSERT INTO users (email, password_hash, name, email_verified, is_admin, created_at) VALUES (?,?,?, 1, 1,?)').run(
email,
hash,
name || '',
nowIso()
);
}
return res.json({ ok: true, firstUser: true, message: '注册成功，您是本站的第一个用户，已设为管理员，可直接登录' });
}
if (!checkCodeRateLimit(email))
return res.status(429).json({ ok: false, error: '验证码请求过于频繁，请一小时后再试'});
const hash = await bcrypt.hash(password, 10);
if (existing) {
db.prepare('UPDATE users SET password_hash =?, name =? WHERE email =?').run(
hash,
name || existing.name || '',
email
);
} else {
db.prepare('INSERT INTO users (email, password_hash, name, email_verified, created_at) VALUES (?,?,?, 0,?)').run(
email,
hash,
name || '',
nowIso()
);
}
const code = issueCode(email, 'register');
try {
await sendCodeEmail(email, code);
} catch (e) {
console.error('[邮件] 发送验证码失败：', e.message);
return res.status(500).json({ ok: false, error: '验证码发送失败，请稍后重试'});
}
return res.json({ ok: true, message: '验证码已发送到您的邮箱，15 分钟内有效'});
} catch (e) {
console.error(e);
return res.status(500).json({ ok: false, error: '服务器错误，请稍后重试'});
}
});

app.post('/api/auth/verify', (req, res) => {
const { email, code} = req.body || {};
if (!isValidEmail(email) || typeof code!== 'string' ||!code)
return res.status(400).json({ ok: false, error: '请填写邮箱和验证码'});
const r = verifyCode(email, code, 'register');
if (!r.ok) return res.status(400).json({ ok: false, error: r.error});
db.prepare('UPDATE users SET email_verified = 1 WHERE email =?').run(email);
return res.json({ ok: true, message: '邮箱验证成功，请登录'});
});

app.post('/api/auth/login', async (req, res) => {
const { email, password} = req.body || {};
if (!isValidEmail(email) || typeof password!== 'string')
return res.status(400).json({ ok: false, error: '请填写邮箱和密码'});
const user = db.prepare('SELECT * FROM users WHERE email =?').get(email);
if (!user) return res.status(400).json({ ok: false, error: '邮箱或密码不正确'});
if (user.email_verified!== 1)
return res.status(403).json({ ok: false, error: '邮箱尚未验证，请先完成验证'});
const match = await bcrypt.compare(password, user.password_hash);
if (!match) return res.status(400).json({ ok: false, error: '邮箱或密码不正确'});
const token = jwt.sign({ id: user.id, email: user.email, is_admin: user.is_admin === 1}, JWT_SECRET, { expiresIn: JWT_EXPIRES});
return res.json({ ok: true, token, user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin === 1}});
});

app.post('/api/auth/forgot', async (req, res) => {
const { email} = req.body || {};
if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: '邮箱格式不正确'});
const user = db.prepare('SELECT * FROM users WHERE email =?').get(email);
if (!user) return res.json({ ok: true, message: '如果该邮箱已注册，验证码已发送'});
if (!checkCodeRateLimit(email))
return res.status(429).json({ ok: false, error: '验证码请求过于频繁，请一小时后再试'});
const code = issueCode(email, 'reset');
try {
await sendCodeEmail(email, code);
} catch (e) {
console.error('[邮件] 发送验证码失败：', e.message);
return res.status(500).json({ ok: false, error: '验证码发送失败，请稍后重试'});
}
return res.json({ ok: true, message: '验证码已发送到您的邮箱，15 分钟内有效'});
});

app.post('/api/auth/reset', async (req, res) => {
const { email, code, newPassword} = req.body || {};
if (!isValidEmail(email) || typeof code!== 'string' ||!code)
return res.status(400).json({ ok: false, error: '请填写邮箱和验证码'});
if (!isValidPassword(newPassword))
return res.status(400).json({ ok: false, error: '新密码需要 8-20 位，且同时包含英文字母和数字'});
const r = verifyCode(email, code, 'reset');
if (!r.ok) return res.status(400).json({ ok: false, error: r.error});
const hash = await bcrypt.hash(newPassword, 10);
db.prepare('UPDATE users SET password_hash =? WHERE email =?').run(hash, email);
return res.json({ ok: true, message: '密码已重置，请使用新密码登录'});
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
const user = db.prepare('SELECT id, email, name, is_admin FROM users WHERE id =?').get(req.user.id);
if (!user) return res.status(401).json({ ok: false, error: '用户不存在'});
return res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, is_admin: user.is_admin === 1}});
});

// ---------- 管理员 API（邮件设置） ----------
function requireAdmin(req, res, next) {
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.is_admin !== 1)
    return res.status(403).json({ ok: false, error: '需要管理员权限' });
  next();
}

app.get('/api/admin/settings', authMiddleware, requireAdmin, (req, res) => {
  return res.json({
    ok: true,
    settings: {
      smtp_host: getSetting('smtp_host'),
      smtp_port: getSetting('smtp_port'),
      smtp_user: getSetting('smtp_user'),
      smtp_from: getSetting('smtp_from'),
      has_password: Boolean(getSetting('smtp_pass')),
      has_flight_api_key: Boolean(getFlightApiKey()),
      has_amap_api_key: Boolean(getAmapKey()),
    },
    mail_configured: mailConfigured(),
  });
});

app.post('/api/admin/settings', authMiddleware, requireAdmin, (req, res) => {
  const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from, flight_api_key, amap_api_key } = req.body || {};
  const set = (k, v) =>
    db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(k, v);
  if (smtp_host !== undefined) set('smtp_host', String(smtp_host || '').trim());
  if (smtp_port !== undefined) set('smtp_port', String(smtp_port || '').trim());
  if (smtp_user !== undefined) set('smtp_user', String(smtp_user || '').trim());
  if (smtp_from !== undefined) set('smtp_from', String(smtp_from || '').trim());
  // 授权码留空表示不修改已保存的值
  if (smtp_pass) set('smtp_pass', String(smtp_pass));
  // 航班查询 API Key 留空表示不修改已保存的值
  if (flight_api_key) set('flight_api_key', String(flight_api_key).trim());
  // 高德 API Key 留空表示不修改已保存的值
  if (amap_api_key) set('amap_api_key', String(amap_api_key).trim());
  return res.json({ ok: true, message: '设置已保存', mail_configured: mailConfigured() });
});

app.post('/api/admin/test-email', authMiddleware, requireAdmin, async (req, res) => {
  const transporter = getTransporter();
  if (!transporter)
    return res.status(400).json({ ok: false, error: '请先填写并保存发件邮箱和授权码' });
  const c = getMailConfig();
  try {
    await transporter.sendMail({
      from: c.from || c.user,
      to: req.user.email,
      subject: '我的轨迹 — 测试邮件',
      text: '这是一封测试邮件，说明发件邮箱配置正确，验证码可以正常发送。',
      html: '<p>这是一封测试邮件，说明发件邮箱配置正确，验证码可以正常发送。</p>',
    });
    return res.json({ ok: true, message: '测试邮件已发送到 ' + req.user.email + '，请查收' });
  } catch (e) {
    console.error('[邮件] 测试发送失败：', e.message);
    return res.status(500).json({ ok: false, error: '发送失败：' + e.message });
  }
});

// ---------- 航班查询 API ----------
// GET /api/flights/lookup?flight=CA1831&date=2026-11-15
// 只按航班号 + 日期查询（不带时间）。返回该航班当日的全部航段 options（同一航班号一日内可能有多段），
// 每段含起降机场（IATA 代码、机场名）与三组时间：实际、计划、预计；为兼容单段用法，顶层同时带第一段的字段。
// 先查本地缓存（30 天），没有再调飞常准 CMCP 的 getFlightStatus 工具。
function normalizeFlightCache(cached) {
  if (!cached) return null;
  if (Array.isArray(cached.options) && cached.options.length) {
    // 旧版缓存没有 actual（实际时间）字段，视为过期，重新查接口拿实际时间
    if (!cached.options[0].departure || !('actual' in cached.options[0].departure)) return null;
    // 旧版缓存没有 aircraft（机型）字段，视为过期，重新查接口拿机型
    if (!('aircraft' in cached.options[0])) return null;
    return cached;
  }
  // 旧版缓存：单条结果，没有 actual 字段，重新查接口
  return null;
}
// 机型英文转中文：Boeing→波音、Airbus→空客等；只有 ICAO 代码时按常见机型映射
const AIRCRAFT_MAKERS = [
  [/^Boeing\b/i, '波音'],
  [/^Airbus\b/i, '空客'],
  [/^Embraer\b/i, '巴航工业'],
  [/^Bombardier\b/i, '庞巴迪'],
  [/^COMAC\b/i, '中国商飞'],
  [/^McDonnell Douglas\b/i, '麦道'],
  [/^Sukhoi\b/i, '苏霍伊'],
  [/^Tupolev\b/i, '图波列夫'],
  [/^Ilyushin\b/i, '伊尔'],
  [/^Antonov\b/i, '安东诺夫'],
];
const AIRCRAFT_CODES = {
  B737: '波音 737-700', B738: '波音 737-800', B739: '波音 737-900',
  B752: '波音 757-200', B763: '波音 767-300',
  B772: '波音 777-200', B773: '波音 777-300', B77W: '波音 777-300ER',
  B788: '波音 787-8', B789: '波音 787-9', B78X: '波音 787-10',
  B744: '波音 747-400', B748: '波音 747-8',
  A318: '空客 A318', A319: '空客 A319', A320: '空客 A320', A321: '空客 A321',
  A332: '空客 A330-200', A333: '空客 A330-300',
  A359: '空客 A350-900', A35K: '空客 A350-1000', A388: '空客 A380-800',
  E170: '巴航工业 E170', E190: '巴航工业 E190', E195: '巴航工业 E195',
  C919: '中国商飞 C919', ARJ21: '中国商飞 ARJ21', MA60: '新舟 60',
};
function translateAircraft(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  for (const [re, zh] of AIRCRAFT_MAKERS) {
    if (re.test(s)) return s.replace(re, zh);
  }
  const code = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (AIRCRAFT_CODES[code]) return AIRCRAFT_CODES[code];
  return s;
}
app.get('/api/flights/lookup', authMiddleware, async (req, res) => {
  const flight = String(req.query.flight || '').trim().toUpperCase();
  const date = String(req.query.date || '').trim();
  if (!/^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$/.test(flight))
    return res.status(400).json({ ok: false, error: '航班号格式不正确，例如 CA1831' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ ok: false, error: '日期格式不正确，例如 2026-11-15' });

  const cached = normalizeFlightCache(flightCacheGet(flight, date));
  if (cached) return res.json({ ok: true, cached: true, ...cached.options[0], ...cached });

  const key = getFlightApiKey();
  if (!key)
    return res.status(400).json({
      ok: false,
      error: '未配置航班查询 API Key，请管理员在设置里填写飞常准 CMCP 的 API Key',
    });

  try {
    const items = await variflightGetFlightStatus(key, flight, date);
    // 飞常准时间格式 "2026-11-15 06:45:00" → ISO "2026-11-15T06:45:00"，前端按 ISO 截取填入时间框
    const toIso = (s) => (s ? String(s).replace(' ', 'T') : '');
    const options = items
      .map((f) => ({
        flight: flight,
        flight_date: date,
        airline: f.FlightCompany || '',
        // 机型：飞常准航班状态接口的 generic（全称，如 Boeing 737-85N）或 ftype（代码，如 B738），英文厂商名自动转中文
        aircraft: translateAircraft(f.generic || f.ftype || ''),
        departure: {
          airport: f.FlightDepAirport || f.FlightDep || '',
          iata: f.FlightDepcode || '',
          icao: '',
          scheduled: toIso(f.FlightDeptimePlanDate),
          estimated: toIso(f.FlightDeptimeEstDate),
          actual: toIso(f.FlightDeptimeDate),
        },
        arrival: {
          airport: f.FlightArrAirport || f.FlightArr || '',
          iata: f.FlightArrcode || '',
          icao: '',
          scheduled: toIso(f.FlightArrtimePlanDate),
          estimated: toIso(f.FlightArrtimeEstDate),
          actual: toIso(f.FlightArrtimeDate),
        },
      }))
      .filter((o) => o.departure.iata && o.arrival.iata);
    if (!options.length)
      return res.status(404).json({ ok: false, error: `未找到 ${flight} 在 ${date} 的航班` });
    const result = { flight, flight_date: date, options };
    flightCacheSet(flight, date, result);
    return res.json({ ok: true, cached: false, ...options[0], ...result });
  } catch (e) {
    console.error('[航班查询] 请求失败：', e.message);
    // Key 无效时飞常准返回 401，提示用户检查 Key
    if (/401|Invalid API key|API key 无效/i.test(e.message))
      return res.status(502).json({ ok: false, error: '飞常准 API Key 无效，请检查设置里的 Key 是否正确（cmcp.variflight.com）' });
    if (/未找到航班/.test(e.message))
      return res.status(404).json({ ok: false, error: `未找到 ${flight} 在 ${date} 的航班` });
    return res.status(502).json({ ok: false, error: '查询航班失败：' + e.message });
  }
});

// ---------- 地名解析 API ----------
// GET /api/places/geocode?name=都江堰站
// 用户输入的地名不在内置库里时，调用高德地理编码 API 查真实坐标（GCJ-02，与地图一致）。
// 先查本地缓存（180 天），没有再调高德（免费额度每天 30 万次）。需要管理员在设置里填高德 Web 服务 API Key。
app.get('/api/places/geocode', authMiddleware, async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: '请提供地名' });
  if (name.length > 50) return res.status(400).json({ ok: false, error: '地名过长' });

  const cached = placeCacheGet(name);
  if (cached) return res.json({ ok: true, cached: true, name, lat: cached.lat, lon: cached.lon });

  const key = getAmapKey();
  if (!key)
    return res.status(400).json({
      ok: false,
      error: '未配置高德 API Key，请管理员在设置里填写高德 Web 服务 API Key（lbs.amap.com 免费申请）',
    });

  try {
    const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(name)}&key=${encodeURIComponent(key)}&output=json`;
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    if (data.status !== '1' || !data.geocodes || !data.geocodes.length)
      return res.status(404).json({ ok: false, error: `未找到「${name}」的位置` });
    // 取第一个结果；location 格式为 "经度,纬度"，坐标系 GCJ-02
    const loc = String(data.geocodes[0].location || '').split(',');
    const lon = parseFloat(loc[0]);
    const lat = parseFloat(loc[1]);
    if (!isFinite(lat) || !isFinite(lon))
      return res.status(502).json({ ok: false, error: '高德返回的坐标无效' });
    placeCacheSet(name, lat, lon);
    return res.json({ ok: true, cached: false, name, lat, lon });
  } catch (e) {
    console.error('[地名解析] 请求失败：', e.message);
    return res.status(502).json({ ok: false, error: '查询地名失败，请稍后重试' });
  }
});

// ---------- 行程 API ----------
function validateTrip(body) {
const t = body || {};
if (t.type!== 'flight' && t.type!== 'train') return '行程类型不正确';
if (!t.dep_name || typeof t.dep_name!== 'string') return '请填写出发地';
if (!t.arr_name || typeof t.arr_name!== 'string') return '请填写目的地';
if (!t.dep_time || typeof t.dep_time!== 'string') return '请填写出发时间';
if (t.arr_time && t.dep_time && t.arr_time < t.dep_time) return '到达时间不能早于出发时间';
return null;
}
function tripFields(body) {
const t = body || {};
const num = (v) => (v === '' || v === null || v === undefined? null: Number(v));
return {
type: t.type,
title: t.title || '',
flight_number: t.flight_number || '',
airline: t.airline || '',
aircraft: t.aircraft || '',
train_number: t.train_number || '',
dep_code: t.dep_code || '',
dep_name: t.dep_name,
dep_lat: num(t.dep_lat),
dep_lon: num(t.dep_lon),
arr_code: t.arr_code || '',
arr_name: t.arr_name,
arr_lat: num(t.arr_lat),
arr_lon: num(t.arr_lon),
dep_time: t.dep_time,
arr_time: t.arr_time || '',
seat: t.seat || '',
notes: t.notes || '',
};
}
// ---------- 行程去重 ----------
// 同一条行程的判定：同一用户、同一类型、同一起降地（地名去掉末尾的“站/机场”再比，
// 这样“青城山”和“青城山站”算同一地），并且：
// - 双方都有航班号/车次号：同一天 + 同一班次号；
// - 至少一方没有班次号：同一出发时刻。
// 编辑时排除自身。
function dupKey(t) {
const normName = (s) => String(s || '').trim().replace(/(站|机场)$/, '');
const num = t.type === 'flight'
? String(t.flight_number || '').trim().toUpperCase()
: String(t.train_number || '').trim().toUpperCase();
return {
type: t.type,
num,
date: String(t.dep_time || '').slice(0, 10),
dep: normName(t.dep_name),
arr: normName(t.arr_name),
depTime: String(t.dep_time || ''),
};
}
function isDuplicateTrip(a, b) {
if (a.type !== b.type || a.dep !== b.dep || a.arr !== b.arr) return false;
if (a.num && b.num) return a.num === b.num && a.date === b.date;
return a.depTime !== '' && a.depTime === b.depTime;
}
function findDuplicateTrip(userId, fields, excludeId) {
const rows = db.prepare('SELECT * FROM trips WHERE user_id = ?').all(userId);
const key = dupKey(fields);
return rows.find((r) => r.id !== excludeId && isDuplicateTrip(key, dupKey(r))) || null;
}
function dupLabel(t) {
const num = t.type === 'flight' ? t.flight_number : t.train_number;
const date = String(t.dep_time || '').slice(0, 10);
return `${num ? num + ' ' : ''}${t.dep_name} → ${t.arr_name}（${date}）`;
}
const TRIP_COLS = ['type', 'title', 'flight_number', 'airline', 'aircraft', 'train_number', 'dep_code', 'dep_name', 'dep_lat', 'dep_lon', 'arr_code', 'arr_name', 'arr_lat', 'arr_lon', 'dep_time', 'arr_time', 'seat', 'notes'];

app.get('/api/trips', authMiddleware, (req, res) => {
const rows = db
.prepare('SELECT * FROM trips WHERE user_id =? ORDER BY dep_time DESC, id DESC')
.all(req.user.id);
return res.json({ ok: true, trips: rows});
});

app.post('/api/trips', authMiddleware, (req, res) => {
const err = validateTrip(req.body);
if (err) return res.status(400).json({ ok: false, error: err});
const f = tripFields(req.body);
const dup = findDuplicateTrip(req.user.id, f);
if (dup) return res.status(409).json({ ok: false, error: `已有相同行程：${dupLabel(dup)}，请勿重复添加` });
const info = db
.prepare(
`INSERT INTO trips (user_id, ${TRIP_COLS.join(', ')}, created_at) VALUES (?, ${TRIP_COLS.map(() => '?').join(', ')},?)`
)
.run(req.user.id,...TRIP_COLS.map((c) => f[c]), nowIso());
const trip = db.prepare('SELECT * FROM trips WHERE id =?').get(info.lastInsertRowid);
return res.status(201).json({ ok: true, trip});
});

app.put('/api/trips/:id', authMiddleware, (req, res) => {
const id = parseInt(req.params.id, 10);
const existing = db.prepare('SELECT * FROM trips WHERE id =? AND user_id =?').get(id, req.user.id);
if (!existing) return res.status(404).json({ ok: false, error: '行程不存在'});
const merged = Object.assign({}, existing, req.body);
const err = validateTrip(merged);
if (err) return res.status(400).json({ ok: false, error: err});
const f = tripFields(merged);
const dup = findDuplicateTrip(req.user.id, f, id);
if (dup) return res.status(409).json({ ok: false, error: `已有相同行程：${dupLabel(dup)}，请勿重复添加` });
db.prepare(
`UPDATE trips SET ${TRIP_COLS.map((c) => `${c} =?`).join(', ')} WHERE id =? AND user_id =?`
).run(...TRIP_COLS.map((c) => f[c]), id, req.user.id);
const trip = db.prepare('SELECT * FROM trips WHERE id =?').get(id);
return res.json({ ok: true, trip});
});

app.delete('/api/trips/:id', authMiddleware, (req, res) => {
const id = parseInt(req.params.id, 10);
const info = db.prepare('DELETE FROM trips WHERE id =? AND user_id =?').run(id, req.user.id);
if (info.changes === 0) return res.status(404).json({ ok: false, error: '行程不存在'});
return res.json({ ok: true, message: '已删除'});
});

app.get('/api/stats', authMiddleware, (req, res) => {
// 乘机/乘车次数 + 总时长（分钟）：时长只累计到达晚于出发的有效行程，缺失或无效时间按 0 计
const rows = db
.prepare(`SELECT type, COUNT(*) AS n, COALESCE(SUM(CASE WHEN arr_time IS NOT NULL AND arr_time <> '' AND dep_time IS NOT NULL AND dep_time <> '' AND arr_time > dep_time THEN (julianday(arr_time) - julianday(dep_time)) * 1440 ELSE 0 END), 0) AS minutes FROM trips WHERE user_id = ? GROUP BY type`)
.all(req.user.id);
let flights = 0;
let trains = 0;
let flightMinutes = 0;
let trainMinutes = 0;
for (const r of rows) {
if (r.type === 'flight') { flights = r.n; flightMinutes = Math.round(r.minutes || 0); }
if (r.type === 'train') { trains = r.n; trainMinutes = Math.round(r.minutes || 0); }
}
return res.json({ ok: true, flights, trains, total: flights + trains, flightMinutes, trainMinutes, totalMinutes: flightMinutes + trainMinutes });
});

// ---------- 航司 logo 手动覆盖 ----------
// 自动匹配（Kiwi）为默认、优先；用户可为某个 IATA 代码指定自定义 logo 图片地址，覆盖自动匹配。
// 空地址 = 删除覆盖、恢复自动匹配。覆盖按用户隔离。
app.get('/api/airline-logos', authMiddleware, (req, res) => {
const rows = db.prepare('SELECT code, url FROM airline_logos WHERE user_id = ?').all(req.user.id);
const logos = {};
rows.forEach((r) => { logos[r.code] = r.url; });
return res.json({ ok: true, logos });
});
app.post('/api/airline-logos', authMiddleware, (req, res) => {
const code = String(req.body.code || '').trim().toUpperCase();
const url = String(req.body.url || '').trim();
if (!/^[A-Z0-9]{2}$/.test(code)) return res.status(400).json({ ok: false, error: '航司代码应为两位字母或数字，例如 8L' });
if (!url) {
db.prepare('DELETE FROM airline_logos WHERE user_id = ? AND code = ?').run(req.user.id, code);
return res.json({ ok: true, message: '已恢复自动匹配' });
}
// 接受两种地址：http(s) 图片链接（≤500 字符），或本地上传转成的 data:image/...;base64 数据（≤200KB）
const isDataUrl = /^data:image\/(png|jpeg|gif|webp|svg\+xml|bmp|x-icon);base64,[A-Za-z0-9+/=]+$/.test(url);
if (isDataUrl) {
if (url.length > 200000) return res.status(400).json({ ok: false, error: '图片太大，请换一张小一点的图片（200KB 以内）' });
} else if (!/^https?:\/\/.+/.test(url) || url.length > 500) {
return res.status(400).json({ ok: false, error: '请输入以 http:// 或 https:// 开头的图片地址' });
}
db.prepare('INSERT INTO airline_logos (user_id, code, url, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, code) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at').run(req.user.id, code, url, nowIso());
return res.json({ ok: true, message: '已保存' });
});
app.delete('/api/airline-logos/:code', authMiddleware, (req, res) => {
const code = String(req.params.code || '').trim().toUpperCase();
db.prepare('DELETE FROM airline_logos WHERE user_id = ? AND code = ?').run(req.user.id, code);
return res.json({ ok: true, message: '已恢复自动匹配' });
});

// ---------- 启动 ----------
app.listen(PORT, '0.0.0.0', () => {
console.log(`[我的轨迹] 服务已启动：http://0.0.0.0:${PORT}`);
});
