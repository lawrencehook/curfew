const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const config = require('../config');

/***************
 * Database setup
 ***************/

let db = null;

function getDb() {
  if (db) return db;

  const dataDir = config.DATA_DIR;
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  db = new Database(path.join(dataDir, 'storage.db'));
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS login_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      ip TEXT
    );

    CREATE TABLE IF NOT EXISTS documents (
      user_id TEXT PRIMARY KEY,
      policies_json TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS email_rate_limits (
      key_hash TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ip_rate_limits (
      key_hash TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL
    );
  `);

  return db;
}

function ensureDirectories() {
  getDb();
}

function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

/***************
 * Hash helpers
 ***************/

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function shortHash(value) {
  return sha256(value).slice(0, 16);
}

function hashCode(code) {
  return sha256(code);
}

/***************
 * Users
 ***************/

function getOrCreateUserByEmail(email) {
  const lower = email.toLowerCase();
  const d = getDb();
  const existing = d.prepare('SELECT * FROM users WHERE email = ?').get(lower);
  if (existing) return existing;
  const id = uuidv4();
  d.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run(id, lower, Date.now());
  return { id, email: lower, created_at: Date.now() };
}

function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()) || null;
}

/***************
 * Login codes
 ***************/

function createLoginCode(email, code, { ip } = {}) {
  const lower = email.toLowerCase();
  const now = Date.now();
  const expiresAt = now + config.CODE_EXPIRY_MS;
  const codeHash = hashCode(code);
  getDb().prepare(`
    INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at, ip)
    VALUES (?, ?, ?, 0, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      code_hash = excluded.code_hash,
      expires_at = excluded.expires_at,
      attempts = 0,
      created_at = excluded.created_at,
      ip = excluded.ip
  `).run(lower, codeHash, expiresAt, now, ip || null);
}

function consumeLoginCode(email, code) {
  // Returns { ok: true } on success, or { ok: false, reason } otherwise.
  // Side effects: increments attempts on miss; clears the row on success or attempts-exhausted.
  const lower = email.toLowerCase();
  const d = getDb();
  const row = d.prepare('SELECT * FROM login_codes WHERE email = ?').get(lower);
  if (!row) return { ok: false, reason: 'no_code' };

  if (Date.now() > row.expires_at) {
    d.prepare('DELETE FROM login_codes WHERE email = ?').run(lower);
    return { ok: false, reason: 'expired' };
  }

  if (row.attempts >= config.CODE_MAX_ATTEMPTS) {
    d.prepare('DELETE FROM login_codes WHERE email = ?').run(lower);
    return { ok: false, reason: 'too_many_attempts' };
  }

  if (hashCode(code) !== row.code_hash) {
    const next = row.attempts + 1;
    if (next >= config.CODE_MAX_ATTEMPTS) {
      d.prepare('DELETE FROM login_codes WHERE email = ?').run(lower);
    } else {
      d.prepare('UPDATE login_codes SET attempts = ? WHERE email = ?').run(next, lower);
    }
    return { ok: false, reason: 'wrong_code', remaining: Math.max(0, config.CODE_MAX_ATTEMPTS - next) };
  }

  // Success — burn the code so it can't be reused.
  d.prepare('DELETE FROM login_codes WHERE email = ?').run(lower);
  return { ok: true };
}

function pruneExpiredLoginCodes() {
  const result = getDb().prepare('DELETE FROM login_codes WHERE expires_at < ?').run(Date.now());
  if (result.changes > 0) {
    console.log(`Pruned ${result.changes} expired login codes`);
  }
  return result.changes;
}

/***************
 * Documents (sync)
 ***************/

function getDocument(userId) {
  return getDb().prepare('SELECT * FROM documents WHERE user_id = ?').get(userId) || null;
}

function putDocument(userId, policiesJson, expectedVersion) {
  // Optimistic concurrency: succeeds only when expectedVersion matches.
  // Returns { ok: true, version } on success, or { ok: false, current: { policies, version, updated_at } } on conflict.
  const d = getDb();
  const existing = d.prepare('SELECT * FROM documents WHERE user_id = ?').get(userId);

  if (!existing) {
    if (expectedVersion !== 0) {
      return { ok: false, current: null };
    }
    const now = Date.now();
    d.prepare(`
      INSERT INTO documents (user_id, policies_json, version, updated_at)
      VALUES (?, ?, 1, ?)
    `).run(userId, policiesJson, now);
    return { ok: true, version: 1, updated_at: now };
  }

  if (existing.version !== expectedVersion) {
    return {
      ok: false,
      current: {
        policies_json: existing.policies_json,
        version: existing.version,
        updated_at: existing.updated_at,
      },
    };
  }

  const newVersion = existing.version + 1;
  const now = Date.now();
  d.prepare(`
    UPDATE documents SET policies_json = ?, version = ?, updated_at = ?
    WHERE user_id = ?
  `).run(policiesJson, newVersion, now, userId);
  return { ok: true, version: newVersion, updated_at: now };
}

/***************
 * Rate limiting
 ***************/

function _checkRateLimit(table, keyHash, windowMs, maxRequests) {
  const now = Date.now();
  const d = getDb();

  let row = d.prepare(`SELECT * FROM ${table} WHERE key_hash = ?`).get(keyHash);

  if (row && now - row.window_start > windowMs) {
    d.prepare(`DELETE FROM ${table} WHERE key_hash = ?`).run(keyHash);
    row = null;
  }

  if (!row) {
    row = { key_hash: keyHash, count: 0, window_start: now };
  }

  if (row.count >= maxRequests) {
    return { allowed: false, resetTime: row.window_start + windowMs };
  }

  row.count++;
  d.prepare(`
    INSERT INTO ${table} (key_hash, count, window_start)
    VALUES (?, ?, ?)
    ON CONFLICT(key_hash) DO UPDATE SET count=excluded.count, window_start=excluded.window_start
  `).run(keyHash, row.count, row.window_start);

  return { allowed: true, remaining: maxRequests - row.count };
}

function _decrementRateLimit(table, keyHash) {
  const d = getDb();
  const row = d.prepare(`SELECT * FROM ${table} WHERE key_hash = ?`).get(keyHash);
  if (row && row.count > 0) {
    d.prepare(`UPDATE ${table} SET count = ? WHERE key_hash = ?`).run(row.count - 1, keyHash);
  }
}

function _pruneExpiredRateLimits(table, windowMs, label) {
  const cutoff = Date.now() - windowMs;
  const result = getDb().prepare(`DELETE FROM ${table} WHERE window_start < ?`).run(cutoff);
  if (result.changes > 0) {
    console.log(`Pruned ${result.changes} expired ${label} records`);
  }
  return result.changes;
}

function checkEmailRateLimit(email) {
  return _checkRateLimit(
    'email_rate_limits',
    shortHash(email.toLowerCase()),
    config.RATE_LIMIT_WINDOW_MS,
    config.RATE_LIMIT_MAX_REQUESTS
  );
}

function decrementEmailRateLimit(email) {
  _decrementRateLimit('email_rate_limits', shortHash(email.toLowerCase()));
}

function pruneExpiredEmailRateLimits() {
  return _pruneExpiredRateLimits('email_rate_limits', config.RATE_LIMIT_WINDOW_MS, 'email rate limit');
}

function checkIpRateLimit(ip) {
  return _checkRateLimit(
    'ip_rate_limits',
    shortHash(ip),
    config.IP_RATE_LIMIT_WINDOW_MS,
    config.IP_RATE_LIMIT_MAX_REQUESTS
  );
}

function pruneExpiredIpRateLimits() {
  return _pruneExpiredRateLimits('ip_rate_limits', config.IP_RATE_LIMIT_WINDOW_MS, 'IP rate limit');
}

module.exports = {
  // Setup
  ensureDirectories,
  closeDatabase,
  getDb,

  // Users
  getOrCreateUserByEmail,
  getUserByEmail,

  // Login codes
  createLoginCode,
  consumeLoginCode,
  pruneExpiredLoginCodes,

  // Sync documents
  getDocument,
  putDocument,

  // Rate limits
  checkEmailRateLimit,
  decrementEmailRateLimit,
  pruneExpiredEmailRateLimits,
  checkIpRateLimit,
  pruneExpiredIpRateLimits,
};
