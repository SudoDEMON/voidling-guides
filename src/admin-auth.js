import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { writeFileAtomic } from './fs-utils.js';

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const ADMIN_COOKIE = 'voidling_dad';
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;

export function dadPostAllowed(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return false;
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin') return false;
  try {
    const origin = new URL(String(req.headers.origin || ''));
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
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

export class AdminSessions {
  constructor(ttl = ADMIN_SESSION_MS, maxSessions = 64) {
    this.ttl = ttl;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  prune(now = Date.now()) {
    for (const [token, expires] of this.sessions) {
      if (expires <= now) this.sessions.delete(token);
    }
  }

  authenticated(req) {
    const now = Date.now();
    this.prune(now);
    const token = cookieValue(req);
    return Boolean(token && (this.sessions.get(token) || 0) > now);
  }

  create() {
    const now = Date.now();
    this.prune(now);
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(token, now + this.ttl);
    return token;
  }

  destroy(req) {
    const token = cookieValue(req);
    if (token) this.sessions.delete(token);
  }

  cookie(token, maxAge = Math.floor(this.ttl / 1000), { secure = false } = {}) {
    return `${ADMIN_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/dad; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
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

export function writePassword(filePath, password) {
  const record = passwordRecord(password);
  writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function readRecord(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!record || record.version !== 1 || record.algorithm !== 'scrypt' || !record.salt || !record.hash) {
    throw new Error('Dad password file has an unsupported format.');
  }
  return record;
}

export async function verifyPassword(filePath, password) {
  const record = readRecord(filePath);
  if (!record || typeof password !== 'string' || password.length > 256) return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(record.salt, 'base64'), expected.length, SCRYPT_OPTIONS);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
