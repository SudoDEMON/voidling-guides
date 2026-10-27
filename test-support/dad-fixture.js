'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { writePassword } = require('../src/admin-auth');
const { createAdminController } = require('../src/admin-controller');
const { LibraryStore } = require('../src/store');
const { RequestAudit } = require('../src/audit');
const { loadCatalog } = require('../src/catalog');
const { extractYouTubeId, canonicalYouTubeUrl } = require('../src/discovery');

// All fixture data and media are disposable. The real data directory is never read.
async function dadFixture({ validatePinnedGuide } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voidling-dad-'));
  const catalogPath = path.join(directory, 'approved-guides.md');
  fs.writeFileSync(catalogPath, '# Approved\n\nKeep this catalog note.\n\n## Roblox: Test Gmae\n\n- [Old Guide](https://youtu.be/SaPy5eZrv34)\n');
  const game = loadCatalog(catalogPath)[0];
  const store = new LibraryStore(path.join(directory, 'library.json'));
  store.load();
  const videosRoot = path.join(directory, 'videos');
  fs.mkdirSync(videosRoot);
  const filePath = path.join(videosRoot, 'original.webm');
  fs.writeFileSync(filePath, 'fixture webm');
  const guide = store.add({
    id: crypto.randomUUID(), key: `${game.id}:old guide`, gameId: game.id,
    game: game.name, platform: game.platform, badge: 'Old Guide', status: 'complete',
    sourceUrl: 'https://www.youtube.com/watch?v=SaPy5eZrv34', filePath,
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: new Date().toISOString(), requestClient: '127.0.0.1'
  });
  const request = store.addGameRequest({
    id: crypto.randomUUID(), key: 'roblox:kid game', name: 'Kid Game', platform: 'Roblox', status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z', requestClient: '127.0.0.1'
  });
  const audit = new RequestAudit(path.join(directory, 'request-log.md'));
  audit.append('REQUESTED', { game: game.name, badge: guide.badge, date: guide.createdAt });
  const authPath = path.join(directory, 'admin-auth.json');
  const password = 'temporary fixture password';
  writePassword(authPath, password);
  const enqueued = [];
  const errors = [];
  const controller = createAdminController({
    catalogPath, authPath, videosRoot, store, audit,
    outputPathFor: (_game, badge) => path.join(videosRoot, `${badge}.webm`),
    enqueue: id => enqueued.push(id),
    validatePinnedGuide: validatePinnedGuide || (async url => {
      const id = extractYouTubeId(url);
      if (!id) throw new Error('Pinned guide is not a canonical YouTube video URL.');
      return { id, title: 'Validated fixture video', channel: 'Fixture channel', duration: 100, webpageUrl: canonicalYouTubeUrl(id) };
    }),
    async readJson(req) {
      let data = '';
      for await (const chunk of req) data += chunk;
      return JSON.parse(data || '{}');
    },
    sendJson(res, status, data, headers = {}) {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    }
  });
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (await controller.handle(req, res, pathname)) return;
      const files = { '/dad': 'dad.html', '/dad/app.js': 'dad.js', '/dad/styles.css': 'dad.css' };
      if (files[pathname]) {
        res.setHeader('content-type', pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(fs.readFileSync(path.join(__dirname, '..', 'public', files[pathname])));
      } else { res.writeHead(404); res.end(); }
    } catch (error) {
      if (res.headersSent) { errors.push(error.message); res.end(); }
      else { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${origin}/dad/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password })
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  async function api(url, method = 'GET', body, headers = {}) {
    const response = await fetch(`${origin}${url}`, {
      method, headers: { cookie, origin, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    directory, catalogPath, store, audit, game, guide, request, enqueued, errors, api, origin, password,
    async close() {
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

module.exports = { dadFixture };
