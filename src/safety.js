'use strict';

const crypto = require('crypto');

const BLOCKED_TERMS = [
  'adult video', 'ass', 'bitch', 'boob', 'boobs', 'breast porn', 'cock', 'cocaine', 'cum',
  'dick', 'fetish', 'fuck', 'fucking', 'hentai', 'naked', 'nude', 'onlyfans',
  'porn', 'pornhub', 'pussy', 'rape', 'sex', 'sexual', 'shit', 'tits', 'vagina',
  'weed porn', 'xxx'
];

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

function collapseWhitespace(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeKey(value) {
  return collapseWhitespace(value).normalize('NFKC').toLocaleLowerCase('en-US');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsBlockedTerm(value) {
  const normalized = normalizeKey(value);
  return BLOCKED_TERMS.some(term => {
    const pattern = term.includes(' ')
      ? escapeRegExp(term).replace(/\\ /g, '\\s+')
      : `\\b${escapeRegExp(term)}\\b`;
    return new RegExp(pattern, 'iu').test(normalized);
  });
}

function validateBadge(value) {
  const badge = collapseWhitespace(value).normalize('NFKC');
  if (badge.length < 2 || badge.length > 64) {
    throw new Error('Badge name must be between 2 and 64 characters.');
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\s&'’().,!+_:\-]*$/u.test(badge)) {
    throw new Error('Badge name contains unsupported characters.');
  }
  if (INJECTION_PATTERNS.some(pattern => pattern.test(badge)) || containsBlockedTerm(badge)) {
    throw new Error('That request is not allowed. Please ask Dad for help.');
  }
  return badge;
}

function validateCatalogLabel(value, label, minimum, maximum) {
  const result = collapseWhitespace(value).normalize('NFKC');
  if (result.length < minimum || result.length > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum} characters.`);
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}\s&'’().,!+_:\-]*$/u.test(result)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  if (INJECTION_PATTERNS.some(pattern => pattern.test(result)) || containsBlockedTerm(result)) {
    throw new Error(`${label} is not allowed.`);
  }
  return result;
}

function validateGameName(value) {
  return validateCatalogLabel(value, 'Game name', 2, 100);
}

function validatePlatform(value) {
  return validateCatalogLabel(value, 'Platform', 2, 32);
}

function slug(value, fallback = 'guide') {
  const result = normalizeKey(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return result || fallback;
}

function stableId(value) {
  const base = slug(value, 'item');
  const suffix = crypto.createHash('sha256').update(normalizeKey(value)).digest('hex').slice(0, 8);
  return `${base}-${suffix}`;
}

function safeMetadata(candidate) {
  const text = [candidate.title, candidate.description, candidate.channel, candidate.transcript]
    .filter(Boolean)
    .join(' ');
  return !containsBlockedTerm(text);
}

module.exports = {
  BLOCKED_TERMS,
  collapseWhitespace,
  containsBlockedTerm,
  normalizeKey,
  safeMetadata,
  slug,
  stableId,
  validateBadge,
  validateGameName,
  validatePlatform
};
