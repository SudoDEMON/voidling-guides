#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readRecord } = require('./admin-auth');
const { loadCatalog } = require('./catalog');
const { ensureLocalCatalog, loadSettings } = require('./settings');

const ROOT = path.resolve(__dirname, '..');
let failed = false;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

check('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.version);
for (const command of ['agy', 'yt-dlp', 'ffmpeg', 'ffprobe']) {
  const args = command === 'ffmpeg' || command === 'ffprobe' ? ['-version'] : ['--version'];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  const version = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0];
  check(command, !result.error && result.status === 0, version || (result.error && result.error.message));
}

try {
  const catalogPath = process.env.VOIDLING_CATALOG_PATH || path.join(ROOT, 'data', 'approved-guides.md');
  ensureLocalCatalog(catalogPath, path.join(ROOT, 'approved-guides.example.md'));
  const games = loadCatalog(catalogPath);
  check('local approved guides', true, `${games.length} approved game(s)`);
} catch (error) {
  check('local approved guides', false, error.message);
}

try {
  const data = path.join(ROOT, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.accessSync(data, fs.constants.R_OK | fs.constants.W_OK);
  check('data directory', true, data);
} catch (error) {
  check('data directory', false, error.message);
}

try {
  const settingsPath = process.env.VOIDLING_SETTINGS_PATH || path.join(ROOT, 'data', 'settings.json');
  const settings = loadSettings(settingsPath);
  check('client allowlist', true, process.env.VOIDLING_ALLOWED_CLIENTS || settings.allowedClients.join(', '));
} catch (error) {
  check('client allowlist', false, error.message);
}
try {
  const authPath = path.join(ROOT, 'data', 'admin-auth.json');
  const configured = Boolean(readRecord(authPath));
  console.log(`${configured ? 'OK  ' : 'INFO'} Dad password${configured ? ' — configured' : ' — run npm run set-password to enable /dad'}`);
} catch (error) {
  check('Dad password', false, error.message);
}
if (failed) process.exitCode = 1;
