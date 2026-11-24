import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePassword } from '../src/admin-auth.js';
import { createAdminController } from '../src/admin-controller.js';
import { RequestAudit } from '../src/audit.js';
import { loadCatalog } from '../src/catalog.js';
import { HttpError } from '../src/fs-utils.js';
import { LibraryStore } from '../src/store.js';
import { canonicalYouTubeUrl, extractYouTubeId } from '../src/youtube.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

// All fixture data and media are disposable. The real data directory is never read.
export async function dadFixture({ validatePinnedGuide } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voidling-dad-'));
  const catalogPath = path.join(directory, 'approved-guides.md');
  fs.writeFileSync(catalogPath, '# Approved\n\nKeep this catalog note.\n\n## Roblox: Test Gmae\n\n- [Old Guide](https://youtu.be/SaPy5eZrv34)\n');
  const game = loadCatalog(catalogPath)[0];
  const videosRoot = path.join(directory, 'videos');
  fs.mkdirSync(videosRoot);
  const store = new LibraryStore(path.join(directory, 'library.json'), { videosRoot });
  store.load();
  const filePath = path.join(videosRoot, 'original.webm');
  fs.writeFileSync(filePath, 'fixture webm');
  const guide = store.add({
    id: crypto.randomUUID(), key: `${game.id}:old guide`, gameId: game.id,
    game: game.name, platform: game.platform, guide: 'Old Guide', status: 'complete',
    sourceUrl: 'https://www.youtube.com/watch?v=SaPy5eZrv34', filePath,
    createdAt: '2026-01-01T00:00:00.000Z', completedAt: new Date().toISOString(), requestClient: '127.0.0.1'
  });
  const request = store.addGameRequest({
    id: crypto.randomUUID(), key: 'roblox:kid game', name: 'Kid Game', platform: 'Roblox', status: 'pending',
    createdAt: '2026-01-01T00:00:00.000Z', requestClient: '127.0.0.1'
  });
  const audit = new RequestAudit(path.join(directory, 'request-log.md'));
  audit.append('REQUESTED', { game: game.name, guide: guide.guide, date: guide.createdAt });
  const authPath = path.join(directory, 'admin-auth.json');
  const password = 'temporary fixture password';
  writePassword(authPath, password);
  const enqueued = [];
  const errors = [];
  const controller = createAdminController({
    catalogPath, authPath, videosRoot, store, audit,
    outputPathFor: (_game, guideName) => path.join(videosRoot, `${guideName}.webm`),
    enqueue: id => enqueued.push(id),
    validatePinnedGuide: validatePinnedGuide || (async url => {
      const id = extractYouTubeId(url);
      if (!id) throw new HttpError(400, 'Pinned guide is not a canonical YouTube video URL.');
      return { id, title: 'Validated fixture video', channel: 'Fixture channel', duration: 100, webpageUrl: canonicalYouTubeUrl(id) };
    }),
    async readJson(req) {
      let data = '';
      for await (const chunk of req) data += chunk;
      return JSON.parse(data || '{}');
    },
    sendJson(res, status, data, headers = {}) {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(data));
    }
  });
  const files = {
    '/tokens.css': 'tokens.css',
    '/client-utils.js': 'client-utils.js',
    '/dad': 'dad.html',
    '/dad/app.js': 'dad.js',
    '/dad/styles.css': 'dad.css'
  };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (await controller.handle(req, res, pathname)) return;
      const target = files[pathname];
      if (target) {
        res.setHeader('content-type', MIME[path.extname(target)] || 'application/octet-stream');
        res.end(fs.readFileSync(path.join(PUBLIC_DIR, target)));
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof HttpError ? error.message : 'Unexpected fixture error';
      if (!(error instanceof HttpError)) errors.push(error.message);
      if (res.headersSent) {
        errors.push(error.message);
        res.end();
      } else {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: message }));
      }
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
