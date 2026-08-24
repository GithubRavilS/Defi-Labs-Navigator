/**
 * Проверка пароля VIP и сессии для DeFi Compass (Vercel + MySQL).
 * Пароль в формате NAV:{client_id}:{secret} — как выдаёт бот Криптосовет.
 */

const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

let _pool;

function getPool() {
  if (_pool) return _pool;
  const host = process.env.MYSQL_HOST;
  const user = process.env.MYSQL_USER;
  const password = process.env.MYSQL_PASSWORD;
  const database = process.env.MYSQL_DATABASE;
  if (!host || !user || !database) {
    throw new Error("MYSQL_* env vars are not set");
  }
  _pool = mysql.createPool({
    host,
    user,
    password: password || "",
    database,
    waitForConnections: true,
    connectionLimit: 4,
    ssl: process.env.MYSQL_SSL === "true" ? {} : undefined,
  });
  return _pool;
}

function parseNavPassword(raw) {
  // Вставка из Telegram/HTML иногда добавляет ZWSP, BOM, перевод строки или «полное» двоеточие (U+FF1A).
  let s = String(raw || "")
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200F\u2028\u2029]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n]+/g, "")
    .replace(/[：﹕]/g, ":")
    .replace(/\s+/g, "")
    .trim();
  const m = /^NAV:(\d+):(.+)$/i.exec(s);
  if (!m) return null;
  return { clientId: parseInt(m[1], 10), secret: m[2] };
}

async function verifyNavPassword(fullPassword) {
  const p = parseNavPassword(fullPassword);
  if (!p) return { ok: false, reason: "bad_format" };
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT a.client_id AS client_id, a.token_hash AS token_hash, a.code_version AS code_version,
            a.valid_until AS valid_until, c.status AS status
     FROM vip_navigator_access a
     INNER JOIN vip_clients c ON c.id = a.client_id
     WHERE a.client_id = ?`,
    [p.clientId],
  );
  if (!rows.length) return { ok: false, reason: "unknown" };
  const row = rows[0];
  if (String(row.status).toLowerCase() !== "active") return { ok: false, reason: "inactive" };

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const vu = new Date(row.valid_until);
  vu.setHours(0, 0, 0, 0);
  if (today > vu) return { ok: false, reason: "expired" };

  const match = await bcrypt.compare(p.secret, String(row.token_hash));
  if (!match) return { ok: false, reason: "wrong_password" };

  return {
    ok: true,
    clientId: Number(row.client_id),
    codeVersion: Number(row.code_version),
    validUntil: row.valid_until,
  };
}

function signNavToken({ clientId, codeVersion, validUntil }, jwtSecret) {
  const vu = new Date(validUntil);
  vu.setHours(23, 59, 59, 999);
  const expMs = vu.getTime() + 86400 * 2 * 1000;
  const maxSec = Math.max(120, Math.floor((expMs - Date.now()) / 1000));
  return jwt.sign({ sub: clientId, v: codeVersion, typ: "nav" }, jwtSecret, {
    algorithm: "HS256",
    expiresIn: maxSec,
  });
}

function verifyNavToken(token, jwtSecret) {
  try {
    return jwt.verify(token, jwtSecret, { algorithms: ["HS256"] });
  } catch {
    return null;
  }
}

async function assertNavSession(decoded) {
  if (!decoded || decoded.typ !== "nav" || decoded.sub == null || decoded.v == null) return false;
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT a.code_version AS code_version, a.valid_until AS valid_until, c.status AS status
     FROM vip_navigator_access a
     INNER JOIN vip_clients c ON c.id = a.client_id
     WHERE a.client_id = ?`,
    [decoded.sub],
  );
  if (!rows.length) return false;
  const row = rows[0];
  if (String(row.status).toLowerCase() !== "active") return false;
  if (Number(row.code_version) !== Number(decoded.v)) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const vu = new Date(row.valid_until);
  vu.setHours(0, 0, 0, 0);
  if (today > vu) return false;
  return true;
}

function getCookie(req, name) {
  const header = req.headers.cookie || "";
  const parts = header.split(";").map((s) => s.trim());
  const prefix = name + "=";
  for (const p of parts) {
    if (p.startsWith(prefix)) return decodeURIComponent(p.slice(prefix.length));
  }
  return null;
}

async function fetchJsonpAsJson(url) {
  const cb = `defilabsJsonp${Date.now()}`;
  const sep = url.includes("?") ? "&" : "?";
  const u = `${url}${sep}callback=${encodeURIComponent(cb)}&_=${Date.now()}`;
  const res = await fetch(u);
  const text = await res.text();
  const trimmed = text.trim();
  const re = new RegExp(`^${cb}\\((.*)\\);?\\s*$`, "s");
  const m = re.exec(trimmed);
  if (!m) {
    throw new Error("Invalid JSONP response");
  }
  return JSON.parse(m[1]);
}

module.exports = {
  getPool,
  parseNavPassword,
  verifyNavPassword,
  signNavToken,
  verifyNavToken,
  assertNavSession,
  getCookie,
  fetchJsonpAsJson,
};
