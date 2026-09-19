'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configureFirewall } = require('../scripts/configure-firewall');

function capture(platform, args, env = {}) {
  let invocation;
  configureFirewall(args, { platform, env, nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    run(command, commandArgs, options) {
      invocation = { command, args: commandArgs, options };
      return { status: 0 };
    }
  });
  return invocation;
}

test('Windows firewall uses PowerShell with literal subnet and program arguments', () => {
  const result = capture('win32', ['add', '10.10.1.0/24']);
  assert.equal(result.command, 'powershell.exe');
  assert.ok(result.args.some(value => value.endsWith('configure-firewall.ps1')));
  assert.equal(result.args[result.args.indexOf('-LanCidr') + 1], '10.10.1.0/24');
  assert.equal(result.args[result.args.indexOf('-Port') + 1], '3002');
  assert.equal(result.args[result.args.indexOf('-Program') + 1], 'C:\\Program Files\\nodejs\\node.exe');
  assert.equal(result.options.shell, undefined);
});

test('Linux firewall preserves UFW add, remove, and replace arguments', () => {
  for (const mode of ['add', 'remove', 'replace']) {
    const args = [mode, '10.10.1.0/24', ...(mode === 'replace' ? ['192.168.1.0/24', '192.0.2.1'] : [])];
    const result = capture('linux', args);
    assert.equal(result.command, 'sudo');
    assert.equal(result.args[0], 'bash');
    assert.deepEqual(result.args.slice(2), args);
  }
});

test('Windows replacement forwards only validated previous clients', () => {
  const result = capture('win32', ['replace', '10.10.1.0/24', '192.168.1.0/24', '192.0.2.1']);
  assert.equal(result.args[result.args.indexOf('-PreviousClients') + 1], '192.168.1.0/24,192.0.2.1');
});

test('custom server port reaches both firewall helpers', () => {
  for (const platform of ['win32', 'linux']) {
    const result = capture(platform, ['add', '10.10.1.0/24'], { VOIDLING_PORT: '4567' });
    assert.equal(result.options.env.VOIDLING_PORT, '4567');
    if (platform === 'win32') assert.equal(result.args[result.args.indexOf('-Port') + 1], '4567');
  }
});

test('invalid subnet, previous client, mode, and port fail before a privileged command', () => {
  const run = () => assert.fail('must not execute a firewall command');
  for (const args of [[], ['allow', '10.10.1.0/24'], ['add', '999.1.1.0/24'],
    ['add', '10.10.1.0/33'], ['add', '10.10.1.0/24;echo'],
    ['remove', '10.10.1.0/24', '10.0.0.0/8'], ['replace', '10.10.1.0/24', '*']]) {
    assert.throws(() => configureFirewall(args, { run }), /Usage:/);
  }
  for (const port of ['0', '65536', '-1', '3002;echo', '3002.1']) {
    assert.throws(() => configureFirewall(['add', '10.10.1.0/24'], { env: { VOIDLING_PORT: port }, run }), /VOIDLING_PORT/);
  }
});

test('unsupported platforms and failed firewall helpers report errors', () => {
  assert.throws(() => capture('darwin', ['add', '10.10.1.0/24']), /supports Windows Firewall and Linux UFW/);
  assert.throws(() => configureFirewall(['add', '10.10.1.0/24'], {
    platform: 'win32', run: () => ({ status: 1 })
  }), /Firewall configuration failed: exit 1/);
});
