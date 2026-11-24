import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fs-utils.js';
import { ipv4Number, parseCidr } from './network.js';

export const LOOPBACK_CLIENTS = ['127.0.0.1', '::1'];

function validClientRule(value) {
  return value === '*' || value === '::1' || ipv4Number(value) != null || parseCidr(value) != null;
}

export function loadSettings(filePath) {
  if (!fs.existsSync(filePath)) return { version: 1, allowedClients: LOOPBACK_CLIENTS };
  const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!settings || settings.version !== 1 || !Array.isArray(settings.allowedClients)
      || settings.allowedClients.length === 0 || settings.allowedClients.some(rule => !validClientRule(rule))) {
    throw new Error('data/settings.json has an unsupported format.');
  }
  return settings;
}

export function writeSettings(filePath, settings) {
  writeFileAtomic(filePath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export function ensureLocalCatalog(filePath, examplePath) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(examplePath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (!['ENOTSUP', 'ENOSYS'].includes(error?.code)) throw error;
  }
}
