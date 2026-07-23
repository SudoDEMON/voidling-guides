'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ADMIN_COOKIE = 'voidling_dad';
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

function isLoopbackAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '');
  return address.startsWith('127.') || address === '::1';
}

function dadPostAllowed(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return false;
  try {
    const origin = new URL(String(req.headers.origin || ''));
    return origin.protocol === 'http:' && origin.host === req.headers.host;
  } catch {
    return false;
  }
}

function cookieValue(req, name = ADMIN_COOKIE) {
  for (const cookie of String(req.headers.cookie || '').split(';')) {
    const separator = cookie.indexOf('=');
    if (separator >= 0 && cookie.slice(0, separator).trim() === name) return cookie.slice(separator + 1).trim();
  }
  return '';
}

class AdminSessions {
  constructor(ttl = ADMIN_SESSION_MS) {
    this.ttl = ttl;
    this.sessions = new Map();
  }

  authenticated(req) {
    const now = Date.now();
    for (const [token, expires] of this.sessions) if (expires <= now) this.sessions.delete(token);
    const token = cookieValue(req);
    return Boolean(token && (this.sessions.get(token) || 0) > now);
  }

  create() {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, Date.now() + this.ttl);
    return token;
  }

  destroy(req) {
    const token = cookieValue(req);
    if (token) this.sessions.delete(token);
  }

  cookie(token, maxAge = Math.floor(this.ttl / 1000)) {
    return `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/dad; Max-Age=${maxAge}`;
  }
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < 10) throw new Error('Dad password must be at least 10 characters.');
  if (value.length > 256) throw new Error('Dad password is too long.');
  return value;
}

function passwordRecord(password, salt = crypto.randomBytes(16)) {
  const value = validatePassword(password);
  const hash = crypto.scryptSync(value, salt, 32, SCRYPT_OPTIONS);
  return { version: 1, algorithm: 'scrypt', salt: salt.toString('base64'), hash: hash.toString('base64') };
}

function writePassword(filePath, password) {
  const record = passwordRecord(password);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function readRecord(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!record || record.version !== 1 || record.algorithm !== 'scrypt' || !record.salt || !record.hash) {
    throw new Error('Dad password file has an unsupported format.');
  }
  return record;
}

function verifyPassword(filePath, password) {
  const record = readRecord(filePath);
  if (!record || typeof password !== 'string' || password.length > 256) return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(record.salt, 'base64'), expected.length, SCRYPT_OPTIONS);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

module.exports = {
  AdminSessions, dadPostAllowed, isLoopbackAddress,
  passwordRecord, readRecord, validatePassword, verifyPassword, writePassword
};
