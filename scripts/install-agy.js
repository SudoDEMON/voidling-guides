#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgy } from '../src/agy.js';
import { isMainModule } from '../src/fs-utils.js';

const INSTALL_URL = 'https://antigravity.google/cli/install.sh';

export { findAgy };

export async function installAgy({
  platform = process.platform,
  env = process.env,
  run = spawnSync,
  download = fetch,
  log = console.log
} = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) {
    throw new Error(`Antigravity setup does not support ${platform}.`);
  }

  const probeOptions = { env, encoding: 'utf8', timeout: 5000 };
  const { command, result: existing } = findAgy({ platform, env, run });
  if (!existing.error && existing.status === 0) {
    log(`Antigravity CLI is already installed: ${existing.stdout.trim()}`);
    return command;
  }
  if (!existing.error || existing.error.code !== 'ENOENT') {
    throw new Error('agy is present but cannot run. Resolve its --version error before reinstalling.');
  }

  function execute(execCommand, args) {
    const result = run(execCommand, args, { env, stdio: 'inherit' });
    if (result.error || result.status !== 0) {
      throw new Error(`${execCommand} installation failed: ${result.error?.message || `exit ${result.status}`}`);
    }
  }

  let installedPath;
  if (platform === 'win32') {
    log('Installing Google Antigravity CLI for this user with WinGet.');
    execute('winget', [
      'install', '--id', 'Google.AntigravityCLI', '--exact', '--source', 'winget',
      '--scope', 'user', '--accept-package-agreements', '--accept-source-agreements',
      '--disable-interactivity'
    ]);
    installedPath = path.join(
      env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'Microsoft', 'WinGet', 'Links', 'agy.exe'
    );
  } else {
    log(`Installing Antigravity CLI with Google's installer: ${INSTALL_URL}`);
    const response = await download(INSTALL_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Could not download the Antigravity installer: HTTP ${response.status}`);
    const script = await response.text();
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'voidling-agy-'));
    try {
      const installer = path.join(temporary, 'install.sh');
      fs.writeFileSync(installer, script, { mode: 0o600 });
      execute('bash', [installer]);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
    installedPath = path.join(env.HOME || os.homedir(), '.local', 'bin', 'agy');
  }

  const installed = run(installedPath, ['--version'], probeOptions);
  if (installed.error || installed.status !== 0) {
    throw new Error(`The installer finished, but ${installedPath} could not run. Check the installer output.`);
  }
  log(`Antigravity CLI installed: ${installed.stdout.trim()}`);
  return installedPath;
}

if (isMainModule(import.meta.url)) {
  installAgy().then(() => {
    console.log('Open a fresh terminal, run agy once to sign in, then run npm run doctor.');
  }).catch(error => {
    console.error(error.message);
    console.error('Official setup help: https://antigravity.google/docs/cli-getting-started');
    process.exitCode = 1;
  });
}
