import crypto from 'node:crypto';
import { HttpError } from './fs-utils.js';

const BLOCKED_TERMS = [
  'adult video', 'ass', 'bitch', 'boob', 'boobs', 'cock', 'cocaine', 'cum',
  'dick', 'fetish', 'fuck', 'fucking', 'hentai', 'naked', 'nude', 'onlyfans',
  'porn', 'pornhub', 'pussy', 'rape', 'sex', 'sexual', 'shit', 'tits', 'vagina', 'xxx'
];

const BLOCKED_PATTERN = new RegExp(
  BLOCKED_TERMS.map(term => (
    term.includes(' ')
      ? RegExp.escape(term).replace(/\\ /g, '\\s+')
      : `\\b${RegExp.escape(term)}\\b`
  )).join('|'),
  'iu'
);

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /system\s+prompt/i,
  /developer\s+message/i,
  /do\s+not\s+follow/i,
  /jailbreak/i,
  /prompt\s+injection/i,
  /\b(?:https?|ftp):\/\//i,
  /\bwww\./i,
  /[<>`{}\[\]\\]/
];

const ALLOWED_LABEL_CHARS = /^[\p{L}\p{N}][\p{L}\p{N}\s&'’().,!+_:\-]*$/u;

function collapseWhitespace(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function normalizeKey(value) {
  return collapseWhitespace(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

export function containsBlockedTerm(value) {
  return BLOCKED_PATTERN.test(normalizeKey(value));
}

function validateLabel(value, label, minimum, maximum, blockedMessage = `${label} is not allowed.`) {
  const result = collapseWhitespace(value).normalize('NFKC');
  if (result.length < minimum || result.length > maximum) {
    throw new HttpError(400, `${label} must be between ${minimum} and ${maximum} characters.`);
  }
  if (!ALLOWED_LABEL_CHARS.test(result)) {
    throw new HttpError(400, `${label} contains unsupported characters.`);
  }
  if (INJECTION_PATTERNS.some(pattern => pattern.test(result)) || containsBlockedTerm(result)) {
    throw new HttpError(400, blockedMessage);
  }
  return result;
}

export function validateGuideName(value) {
  return validateLabel(value, 'Guide name', 2, 64, 'That request is not allowed. Please ask Dad for help.');
}

export function validateGameName(value) {
  return validateLabel(value, 'Game name', 2, 100);
}

export function validatePlatform(value) {
  const name = validateLabel(value, 'Platform', 2, 32);
  if (name.includes(':')) throw new HttpError(400, 'Platform cannot contain a colon.');
  return name;
}

export function slug(value, fallback = 'guide') {
  const result = normalizeKey(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return result || fallback;
}

export function stableId(value) {
  const base = slug(value, 'item');
  const suffix = crypto.createHash('sha256').update(normalizeKey(value)).digest('hex').slice(0, 8);
  return `${base}-${suffix}`;
}

export function safeMetadata(candidate) {
  const text = [candidate.title, candidate.description, candidate.channel, candidate.transcript]
    .filter(Boolean)
    .join(' ');
  return !containsBlockedTerm(text);
}
