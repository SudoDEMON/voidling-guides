'use strict';

const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installAgy } = require('../scripts/install-agy');

const missing = { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
const success = { status: 0, stdout: '1.2.6\n' };
const log = () => {};

test('setup leaves an existing working installation alone', async () => {
  const commands = [];
  await installAgy({ platform: 'win32', log, run(command) { commands.push(command); return success; } });
  assert.deepEqual(commands, ['agy']);
});

test('Windows setup installs for the current user and verifies the binary outside stale PATH', async () => {
  const commands = [];
  await installAgy({ platform: 'win32', env: { LOCALAPPDATA: 'local-app-data' }, log,
    run(command, args) { commands.push([command, args]); return command === 'agy' ? missing : success; }
  });
  assert.equal(commands[1][0], 'winget');
  assert.ok(commands[1][1].includes('Google.AntigravityCLI'));
  assert.equal(commands[1][1][commands[1][1].indexOf('--scope') + 1], 'user');
  assert.match(commands[2][0], /local-app-data.*WinGet.*agy\.exe$/);
  assert.deepEqual(commands[2][1], ['--version']);
});

test('setup reports installation failure without claiming success', async () => {
  await assert.rejects(installAgy({ platform: 'win32', log,
    run(command) { return command === 'agy' ? missing : { status: 5 }; }
  }), /installation failed: exit 5/);
});

test('setup does not overwrite an existing broken executable', async () => {
  await assert.rejects(installAgy({ platform: 'win32', log, run: () => ({ status: 1 }) }), /present but cannot run/);
});

test('Unix setup rejects a failed download before running an installer', async () => {
  await assert.rejects(installAgy({ platform: 'linux', log, run: () => missing,
    download: async () => ({ ok: false, status: 503 })
  }), /HTTP 503/);
});

test('Unix setup runs the downloaded file and removes temporary setup files', async () => {
  let installer;
  await installAgy({ platform: 'darwin', log,
    download: async url => {
      assert.equal(url, 'https://antigravity.google/cli/install.sh');
      return { ok: true, text: async () => '# installer fixture\n' };
    },
    run(command, args) {
      if (command === 'agy') return missing;
      if (command === 'bash') {
        [installer] = args;
        assert.equal(fs.readFileSync(installer, 'utf8'), '# installer fixture\n');
      }
      return success;
    }
  });
  assert.equal(fs.existsSync(installer), false);
});

test('setup rejects an installer that leaves no runnable binary', async () => {
  await assert.rejects(installAgy({ platform: 'win32', log,
    run(command) { return command === 'winget' ? success : missing; }
  }), /installer finished, but/);
});
