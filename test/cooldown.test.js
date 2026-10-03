'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const { createRequire } = require('node:module');
const { parseCatalog } = require('../src/catalog');

function fixture(t) {
  const root = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voidling-cooldown-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const catalog = '# Approved\n\n## Roblox: Fixture Game\n';
  const catalogPath = path.join(scratch, 'catalog.md');
  fs.writeFileSync(catalogPath, catalog);
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const load = createRequire(path.join(root, 'server.js'));
  const module = { exports: {} };
  const server = { on() { return this; }, listen() { return this; } };
  const context = vm.createContext({ module, __dirname: root, Buffer, URL, Date: Clock,
    console, setInterval: () => ({ unref() {} }),
    process: { env: { VOIDLING_DATA_ROOT: scratch, VOIDLING_CATALOG_PATH: catalogPath,
      VOIDLING_ALLOWED_CLIENTS: '127.0.0.1' } },
    require(name) {
      if (name === 'http') return { createServer: () => server };
      if (name === 'child_process') return { spawnSync() { throw Error('External process forbidden'); } };
      if (name === './src/converter' || name === './src/discovery') {
        return new Proxy({}, { get() { return () => { throw Error('External service forbidden'); }; } });
      }
      return load(name);
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8') +
    '\npumpQueue = async () => {}; module.exports = { handleRequest, store, queue };', context);
  return {
    gameId: parseCatalog(catalog)[0].id,
    advance(ms) { now += ms; },
    async post(route, body) {
      const req = Readable.from([JSON.stringify(body)]);
      req.method = 'POST'; req.url = route; req.headers = { host: 'localhost' };
      req.socket = { remoteAddress: '127.0.0.1' };
      let status, payload;
      const res = { writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); } };
      await module.exports.handleRequest(req, res);
      return { status, payload };
    }
  };
}

for (const route of ['/api/game-requests', '/api/requests']) {
  test(`${route} rejects before ten seconds and accepts at the boundary`, async t => {
    const f = fixture(t);
    const body = name => route === '/api/game-requests'
      ? { platform: 'Roblox', name } : { gameId: f.gameId, guide: name };
    assert.equal((await f.post(route, body('First'))).status, 201);
    f.advance(9_999);
    assert.equal((await f.post(route, body('Second'))).status, 429);
    f.advance(1);
    assert.equal((await f.post(route, body('Second'))).status, 201);
    assert.equal((await f.post(route, body('Third'))).status, 429);
  });
}
test('guide queue remains capped at five and duplicates reuse the existing job', async t => {
  const f = fixture(t);
  const body = guide => ({ gameId: f.gameId, guide });
  const first = await f.post('/api/requests', body('Guide 0'));
  for (let i = 1; i < 5; i++) {
    f.advance(10_000);
    assert.equal((await f.post('/api/requests', body(`Guide ${i}`))).status, 201);
  }
  f.advance(10_000);
  assert.equal((await f.post('/api/requests', body('Overflow'))).status, 429);
  const duplicate = await f.post('/api/requests', body('Guide 0'));
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.payload.duplicate, true);
  assert.equal(duplicate.payload.guide.id, first.payload.guide.id);
});
test('game duplicates do not add requests, and guide/game cooldowns are independent', async t => {
  const f = fixture(t);
  const body = { platform: 'Roblox', name: 'New Game' };
  const first = await f.post('/api/game-requests', body);
  const duplicate = await f.post('/api/game-requests', body);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.payload.duplicate, true);
  assert.equal(duplicate.payload.request.id, first.payload.request.id);
  assert.equal((await f.post('/api/requests', { gameId: f.gameId, guide: 'Guide' })).status, 201);
});
test('pending game request cap remains twenty with the shorter cooldown', async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) {
    assert.equal((await f.post('/api/game-requests', { platform: 'Roblox', name: `Game ${i}` })).status, 201);
    f.advance(10_000);
  }
  assert.equal((await f.post('/api/game-requests', { platform: 'Roblox', name: 'Overflow' })).status, 429);
});
