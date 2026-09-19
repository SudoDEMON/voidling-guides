#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { ipv4Number, parseCidr } = require('../src/network');

const USAGE = 'Usage: npm run firewall -- <add|remove|replace> <lan-cidr> [previous-client ...]';

function configureFirewall(args, {
  platform = process.platform,
  env = process.env,
  nodePath = process.execPath,
  run = spawnSync
} = {}) {
  const [mode, cidr, ...previous] = args;
  const port = String(env.VOIDLING_PORT || '3002');
  if (!['add', 'remove', 'replace'].includes(mode) || !parseCidr(cidr)
      || (mode !== 'replace' && previous.length)
      || previous.some(client => !parseCidr(client) && ipv4Number(client) == null)) {
    throw new Error(USAGE);
  }
  if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) {
    throw new Error('VOIDLING_PORT must be an integer from 1 to 65535.');
  }

  let command;
  let commandArgs;
  if (platform === 'win32') {
    command = 'powershell.exe';
    commandArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'configure-firewall.ps1'),
      '-Mode', mode, '-LanCidr', cidr, '-Port', port, '-Program', nodePath];
    if (previous.length) commandArgs.push('-PreviousClients', previous.join(','));
  } else if (platform === 'linux') {
    command = 'sudo';
    commandArgs = ['bash', path.join(__dirname, 'configure-firewall.sh'), mode, cidr, ...previous];
  } else {
    throw new Error(`Automatic firewall setup supports Windows Firewall and Linux UFW, not ${platform}.`);
  }
  const result = run(command, commandArgs, {
    env: { ...env, VOIDLING_PORT: port }, stdio: 'inherit', windowsHide: true
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Firewall configuration failed: ${result.error?.message || `exit ${result.status}`}`);
  }
}

if (require.main === module) {
  try {
    configureFirewall(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { configureFirewall };
