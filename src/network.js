'use strict';

function normalizeAddress(value) {
  return String(value || '').replace(/^::ffff:/, '');
}

function ipv4Number(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function cidrContains(cidr, address) {
  const parsed = parseCidr(cidr);
  const candidate = ipv4Number(address);
  return Boolean(parsed && candidate != null && (parsed.network & parsed.mask) === (candidate & parsed.mask));
}

function parseCidr(value) {
  const match = String(value).match(/^([^/]+)\/(\d{1,2})$/);
  if (!match) return null;
  const network = ipv4Number(match[1]);
  const prefix = Number(match[2]);
  if (network == null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { network, prefix, mask };
}

function addressAllowed(value, rules) {
  const address = normalizeAddress(value);
  return [...rules].some(rule => rule === '*' || rule === address || cidrContains(rule, address));
}

module.exports = { addressAllowed, cidrContains, ipv4Number, normalizeAddress, parseCidr };
