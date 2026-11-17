const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'travel.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  email_verified INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT,
  flight_number TEXT,
  airline TEXT,
  aircraft TEXT,
  train_number TEXT,
  dep_code TEXT,
  dep_name TEXT NOT NULL,
  dep_lat REAL,
  dep_lon REAL,
  arr_code TEXT,
  arr_name TEXT NOT NULL,
  arr_lat REAL,
  arr_lon REAL,
  dep_time TEXT NOT NULL,
  arr_time TEXT,
  seat TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_codes_email ON verification_codes(email);
CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);
-- 航班查询缓存：航班号 + 日期 → API 返回的原始 JSON，避免重复消耗免费额度
CREATE TABLE IF NOT EXISTS flight_cache (
  flight_iata TEXT NOT NULL,
  flight_date TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (flight_iata, flight_date)
);
-- 地名解析缓存：地名 → 高德地理编码返回的经纬度（GCJ-02），避免重复调用
CREATE TABLE IF NOT EXISTS place_cache (
  name TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  created_at TEXT NOT NULL
);
-- 航司 logo 手动覆盖：用户可为某个 IATA 代码指定自定义 logo 图片地址，优先于 Kiwi 自动匹配
CREATE TABLE IF NOT EXISTS airline_logos (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, code)
);
`);

// 旧库迁移：users 表若无 is_admin 列则补上
const userCols = db.prepare('PRAGMA table_info(users)').all();
if (!userCols.some((c) => c.name === 'is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0');
}

// 旧库迁移：trips 表若无 aircraft（机型）列则补上
const tripCols = db.prepare('PRAGMA table_info(trips)').all();
if (!tripCols.some((c) => c.name === 'aircraft')) {
  db.exec('ALTER TABLE trips ADD COLUMN aircraft TEXT');
}

module.exports = db;
