'use strict';

/* Admin login: scrypt password hashes, HMAC-signed cookie, per-IP lockout. Node built-ins only. */

const crypto = require('crypto');

const COOKIE = 'admin';
const SESSION_MS = 8 * 3600 * 1000;
const b64 = (buf) => Buffer.from(buf).toString('base64url');

/** -> "scrypt.<salt>.<hash>" (base64url, so it is safe inside ADMIN_USERS=user:hash,user:hash). */
function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt.${b64(salt)}.${b64(hash)}`;
}

function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('.');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** "vipin:scrypt.x.y,yash:scrypt.a.b" -> Map(user -> hash). Malformed entries are skipped. */
function parseUsers(raw) {
  const users = new Map();
  for (const part of String(raw || '').split(',')) {
    const i = part.indexOf(':');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const hash = part.slice(i + 1).trim();
    if (name && hash.startsWith('scrypt.')) users.set(name, hash);
  }
  return users;
}

const sign = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function makeCookie(username, secret, nowMs = Date.now()) {
  const payload = `${b64(username)}.${nowMs + SESSION_MS}`;
  return `${payload}.${sign(payload, secret)}`;
}

/** -> username or null (bad shape, bad signature, expired). */
function readCookie(value, secret, nowMs = Date.now()) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3) return null;
  const payload = `${parts[0]}.${parts[1]}`;
  const want = Buffer.from(sign(payload, secret));
  const got = Buffer.from(parts[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  if (!(Number(parts[1]) > nowMs)) return null;
  return Buffer.from(parts[0], 'base64url').toString('utf8');
}

function parseCookies(header) {
  const out = {};
  for (const kv of String(header || '').split(';')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

/** 5 failures per IP -> locked for 15 minutes. In memory (resets on restart). */
class Lockout {
  constructor({ max = 5, lockMs = 15 * 60 * 1000, now = Date.now } = {}) {
    Object.assign(this, { max, lockMs, now, fails: new Map() });
  }

  /** Minutes left if locked, else 0. */
  lockedMinutes(ip) {
    const f = this.fails.get(ip);
    if (!f || f.until <= this.now()) return 0;
    return Math.ceil((f.until - this.now()) / 60000);
  }

  fail(ip) {
    const f = this.fails.get(ip);
    const fresh = !f || (f.until && f.until <= this.now());
    const count = (fresh ? 0 : f.count) + 1;
    this.fails.set(ip, { count, until: count >= this.max ? this.now() + this.lockMs : 0 });
  }

  ok(ip) {
    this.fails.delete(ip);
  }
}

module.exports = { COOKIE, SESSION_MS, hashPassword, verifyPassword, parseUsers, makeCookie, readCookie, parseCookies, Lockout };
