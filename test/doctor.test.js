'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runDoctor } = require('../src/doctor');

const missing = { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) };
const success = { status: 0, stdout: 'test-version\n' };
const isAgy = command => command === 'agy' || command.endsWith('agy.exe');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voidling-doctor-'));
  fs.writeFileSync(path.join(root, 'approved-guides.example.md'), '# Approved Games\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = [];
  return { root, output, platform: 'win32', env: {}, log: line => output.push(line) };
}

test('doctor automatically installs missing agy and rechecks the returned executable', async t => {
  const options = fixture(t);
  let installed = false;
  let installs = 0;
  const checked = [];
  const result = await runDoctor({ ...options,
    run(command) {
      checked.push(command);
      return isAgy(command) && !installed ? missing : success;
    },
    install: async () => { installed = true; installs++; return 'new-location/agy.exe'; }
  });
  assert.equal(result, 0);
  assert.equal(installs, 1);
  assert.ok(checked.includes('new-location/agy.exe'));
  assert.ok(options.output.some(line => line.startsWith('OK   agy')));
});

test('check-only neither installs missing agy nor initializes local data', async t => {
  const options = fixture(t);
  const result = await runDoctor({ ...options, checkOnly: true,
    run: command => isAgy(command) ? missing : success,
    install: () => assert.fail('check-only must not install')
  });
  assert.equal(result, 1);
  assert.equal(fs.existsSync(path.join(options.root, 'data')), false);
  assert.ok(options.output.some(line => line.includes('npm run setup:agy')));
});

test('doctor preserves working agy and explains an empty local catalog', async t => {
  const options = fixture(t);
  assert.equal(await runDoctor({ ...options, run: () => success,
    install: () => assert.fail('working installation must be preserved')
  }), 0);
  assert.ok(options.output.some(line => line.includes('No approved games on this machine')));
  assert.ok(options.output.some(line => line.includes(path.join(options.root, 'data', 'approved-guides.md'))));
});

test('doctor reports installation errors and continues other checks', async t => {
  const options = fixture(t);
  assert.equal(await runDoctor({ ...options,
    run: command => isAgy(command) ? missing : success,
    install: async () => { throw new Error('installer unavailable'); }
  }), 1);
  assert.ok(options.output.some(line => line.includes('FAIL agy') && line.includes('installer unavailable')));
  assert.ok(options.output.some(line => line.startsWith('OK   ffmpeg')));
});

test('doctor does not reinstall an existing broken agy', async t => {
  assert.equal(await runDoctor({ ...fixture(t),
    run: command => isAgy(command) ? { status: 1, stderr: 'broken installation' } : success,
    install: () => assert.fail('broken installation needs diagnosis, not replacement')
  }), 1);
});

test('doctor fails if the installed executable cannot run', async t => {
  assert.equal(await runDoctor({ ...fixture(t),
    run: command => isAgy(command) ? missing : success,
    install: async () => 'still-missing/agy.exe'
  }), 1);
});
