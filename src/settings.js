'use strict';

const fs = require('fs');
const path = require('path');
const { ipv4Number, parseCidr } = require('./network');

const LOOPBACK_CLIENTS = ['127.0.0.1', '::1'];

function validClientRule(value) {
  return value === '*' || value === '::1' || ipv4Number(value) != null || parseCidr(value) != null;
}

function loadSettings(filePath) {
  if (!fs.existsSync(filePath)) return { version: 1, allowedClients: LOOPBACK_CLIENTS };
  const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!settings || settings.version !== 1 || !Array.isArray(settings.allowedClients)
      || settings.allowedClients.length === 0 || settings.allowedClients.some(rule => !validClientRule(rule))) {
    throw new Error('data/settings.json has an unsupported format.');
  }
  return settings;
}

function writeSettings(filePath, settings) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function ensureLocalCatalog(filePath, examplePath) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.copyFileSync(examplePath, filePath);
  fs.chmodSync(filePath, 0o600);
}

module.exports = { LOOPBACK_CLIENTS, ensureLocalCatalog, loadSettings, validClientRule, writeSettings };
