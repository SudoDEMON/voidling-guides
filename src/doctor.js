#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findAgy, installAgy } = require('../scripts/install-agy');
const { readRecord } = require('./admin-auth');
const { loadCatalog } = require('./catalog');
const { ensureLocalCatalog, loadSettings } = require('./settings');

async function runDoctor({
  root = path.resolve(__dirname, '..'),
  platform = process.platform,
  env = process.env,
  run = spawnSync,
  install = installAgy,
  checkOnly = false,
  log = console.log
} = {}) {
  let failed = false;
  function check(label, ok, detail = '') {
    log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failed = true;
  }

  check('Node.js', Number(process.versions.node.split('.')[0]) >= 22, process.version);
  for (const command of ['agy', 'yt-dlp', 'ffmpeg', 'ffprobe']) {
    const args = command === 'ffmpeg' || command === 'ffprobe' ? ['-version'] : ['--version'];
    const probeOptions = { env, encoding: 'utf8', timeout: 5000 };
    let executable = command;
    let result;
    if (command === 'agy') {
      const probe = findAgy({ platform, env, run });
      executable = probe.command;
      result = probe.result;
      if (result.error?.code === 'ENOENT' && !checkOnly) {
        log('INFO agy is missing; attempting Antigravity CLI installation.');
        try {
          executable = await install({ platform, env, run, log });
          result = run(executable, args, probeOptions);
        } catch (error) {
          result = { error };
        }
      }
    } else {
      result = run(command, args, probeOptions);
    }
    const ok = !result.error && result.status === 0;
    const version = String(result.stdout || result.stderr || '').trim().split(/\r?\n/)[0];
    check(command, ok, version || result.error?.message);
    if (command === 'agy' && !ok) {
      log('     Install or repair Antigravity CLI with npm run setup:agy.');
    } else if (command === 'agy' && executable !== 'agy') {
      log(`INFO agy found at ${executable}. Ensure that directory is on PATH in the terminal starting the server.`);
    }
  }
  log('INFO Antigravity sign-in is separate from the version check; run agy once to authenticate.');

  try {
    const catalogPath = env.VOIDLING_CATALOG_PATH || path.join(root, 'data', 'approved-guides.md');
    if (!checkOnly) ensureLocalCatalog(catalogPath, path.join(root, 'approved-guides.example.md'));
    fs.accessSync(catalogPath, fs.constants.R_OK);
    const games = loadCatalog(catalogPath);
    check('local approved guides', true, `${games.length} approved game(s)`);
    if (games.length === 0) {
      log(`INFO No approved games on this machine. Add them in /dad or copy your existing approved-guides.md to ${catalogPath}.`);
    }
  } catch (error) {
    check('local approved guides', false, error.message);
  }

  try {
    const data = path.join(root, 'data');
    if (!checkOnly) fs.mkdirSync(data, { recursive: true });
    fs.accessSync(data, fs.constants.R_OK | fs.constants.W_OK);
    check('data directory', true, data);
  } catch (error) {
    check('data directory', false, error.message);
  }

  try {
    const settingsPath = env.VOIDLING_SETTINGS_PATH || path.join(root, 'data', 'settings.json');
    const settings = loadSettings(settingsPath);
    check('client allowlist', true, env.VOIDLING_ALLOWED_CLIENTS || settings.allowedClients.join(', '));
  } catch (error) {
    check('client allowlist', false, error.message);
  }
  try {
    const configured = Boolean(readRecord(path.join(root, 'data', 'admin-auth.json')));
    log(`${configured ? 'OK  ' : 'INFO'} Dad password${configured ? ' — configured' : ' — run npm run set-password to enable /dad'}`);
  } catch (error) {
    check('Dad password', false, error.message);
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('Usage: npm run doctor [-- --check-only]\nInstalls a missing agy by default. --check-only disables installation and local-data initialization.');
  } else if (args.some(arg => arg !== '--check-only')) {
    console.error('Usage: npm run doctor [-- --check-only]');
    process.exitCode = 2;
  } else {
    runDoctor({ checkOnly: args.includes('--check-only') }).then(code => {
      process.exitCode = code;
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = { runDoctor };
