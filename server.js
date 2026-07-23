#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isLoopbackAddress } = require('./src/admin-auth');
const { createAdminController } = require('./src/admin-controller');
const { RequestAudit } = require('./src/audit');
const { loadCatalog, publicGames } = require('./src/catalog');
const { convertGuide } = require('./src/converter');
const { discoverGuide, needsClarification, validatePinnedGuide } = require('./src/discovery');
const { addressAllowed, normalizeAddress } = require('./src/network');
const { normalizeKey, slug, stableId, validateBadge, validateGameName, validatePlatform } = require('./src/safety');
const { ensureLocalCatalog, loadSettings } = require('./src/settings');
const { LibraryStore } = require('./src/store');

const ROOT = __dirname;
const PUBLIC_ROOT = path.join(ROOT, 'public');
const DATA_ROOT = process.env.VOIDLING_DATA_ROOT ? path.resolve(process.env.VOIDLING_DATA_ROOT) : path.join(ROOT, 'data');
const SETTINGS_PATH = process.env.VOIDLING_SETTINGS_PATH ? path.resolve(process.env.VOIDLING_SETTINGS_PATH) : path.join(DATA_ROOT, 'settings.json');
const CATALOG_PATH = process.env.VOIDLING_CATALOG_PATH ? path.resolve(process.env.VOIDLING_CATALOG_PATH) : path.join(DATA_ROOT, 'approved-guides.md');
ensureLocalCatalog(CATALOG_PATH, path.join(ROOT, 'approved-guides.example.md'));
const localSettings = loadSettings(SETTINGS_PATH);
const HOST = process.env.VOIDLING_HOST || '0.0.0.0';
const PORT = Number(process.env.VOIDLING_PORT || 3002);
const ALLOWED_CLIENTS = new Set(
  String(process.env.VOIDLING_ALLOWED_CLIENTS || localSettings.allowedClients.join(','))
    .split(',').map(value => value.trim()).filter(Boolean)
);
const MAX_BODY = 16 * 1024;
const MAX_QUEUED = 5;
const MAX_PENDING_GAME_REQUESTS = 20;
const REQUEST_COOLDOWN_MS = 30_000;
const SAFE_FAILURE = "I couldn't find the exact guide. Please go get approval from your Dad for the video first.";
const MIME = {
  '.css': 'text/css; charset=utf-8', '.gif': 'image/gif', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp'
};

const store = new LibraryStore(path.join(DATA_ROOT, 'library.json'));
const audit = new RequestAudit(path.join(DATA_ROOT, 'request-log.md'));
store.load();
store.cleanup();
const queue = [];
const lastRequestByClient = new Map();
const lastGameRequestByClient = new Map();
let processing = false;

function clientAllowed(req) {
  return addressAllowed(req.socket.remoteAddress, ALLOWED_CLIENTS);
}

function securityHeaders(contentType) {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = `${JSON.stringify(data)}\n`;
  res.writeHead(status, { ...securityHeaders('application/json; charset=utf-8'), 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}

function sendText(res, status, message) {
  const body = `${message}\n`;
  res.writeHead(status, { ...securityHeaders('text/plain; charset=utf-8'), 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('Request is too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Request must contain valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function loadCurrentCatalog() {
  return loadCatalog(CATALOG_PATH);
}

function publicGuide(guide) {
  return {
    id: guide.id,
    gameId: guide.gameId,
    game: guide.game,
    platform: guide.platform,
    badge: guide.badge,
    status: guide.status,
    message: guide.message,
    sourceTitle: guide.sourceTitle || '',
    channel: guide.channel || '',
    duration: guide.duration || 0,
    size: guide.size || 0,
    createdAt: guide.createdAt,
    completedAt: guide.completedAt || null,
    suggestedBadge: guide.status === 'needs_confirmation' ? guide.suggestedBadge : null,
    mediaUrl: guide.status === 'complete' ? `/media/${encodeURIComponent(guide.id)}` : null
  };
}

function publicGameRequest(request) {
  return {
    id: request.id, platform: request.platform, name: request.name,
    status: request.status, createdAt: request.createdAt
  };
}

function listPublicGuides() {
  return store.state.guides
    .slice()
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .map(publicGuide);
}

function commandAvailable(command) {
  const args = command === 'ffmpeg' || command === 'ffprobe' ? ['-version'] : ['--version'];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 });
  return !result.error && result.status === 0;
}

function dependencyHealth() {
  return Object.fromEntries(['agy', 'yt-dlp', 'ffmpeg', 'ffprobe'].map(command => [command, commandAvailable(command)]));
}

function mascotUrl() {
  const name = ['voidling.png', 'voidling.webp', 'voidling.gif'].find(file => fs.existsSync(path.join(PUBLIC_ROOT, file)));
  return name ? `/${name}` : null;
}

function queuedCount() {
  return store.state.guides.filter(guide => guide.status === 'queued').length;
}

function outputPathFor(game, badge) {
  const gameDir = `${slug(game.name, 'game')}-${game.id.slice(-8)}`;
  return path.join(DATA_ROOT, 'videos', gameDir, `${slug(badge, 'badge')}.webm`);
}

function setStatus(id, status, message, extra = {}) {
  return store.update(id, { status, message, ...extra });
}

async function processGuide(id) {
  const guide = store.state.guides.find(item => item.id === id);
  if (!guide) return;
  try {
    const game = loadCurrentCatalog().find(item => item.id === guide.gameId);
    if (!game) throw new Error('The approved game was removed from the catalog.');
    const pinned = game.pinned[normalizeKey(guide.badge)];
    let selected;
    if (guide.approvedSelection) {
      selected = guide.approvedSelection;
    } else if (pinned) {
      setStatus(id, 'checking', 'Dad approved this guide. Checking the video...');
      selected = await validatePinnedGuide(pinned.url);
      selected.antigravityResponse = 'PINNED: Dad-approved URL override';
      selected.canonicalBadge = pinned.badge;
    } else {
      setStatus(id, 'searching', 'Looking for the exact guide...');
      selected = await discoverGuide(game, guide.badge);
    }

    if (!pinned && !guide.approvedSelection && needsClarification(guide.badge, selected.canonicalBadge)) {
      const pendingSelection = {
        id: selected.id, title: selected.title, channel: selected.channel,
        duration: selected.duration, webpageUrl: selected.webpageUrl,
        canonicalBadge: selected.canonicalBadge,
        selectionReason: selected.selectionReason,
        antigravityResponse: selected.antigravityResponse
      };
      setStatus(id, 'needs_confirmation', `Did you mean “${selected.canonicalBadge}”?`, {
        suggestedBadge: selected.canonicalBadge,
        sourceTitle: selected.title,
        channel: selected.channel,
        pendingSelection
      });
      audit.append('SUGGESTED', {
        game: guide.game, badge: guide.badge, client: guide.requestClient,
        video: selected.title, url: selected.webpageUrl,
        antigravity: selected.antigravityResponse,
        reason: `Did you mean ${selected.canonicalBadge}?`
      });
      return;
    }

    setStatus(id, 'downloading', 'Found it! Downloading the guide...', {
      sourceTitle: selected.title,
      channel: selected.channel
    });
    const media = await convertGuide({
      url: selected.webpageUrl,
      outputPath: guide.filePath,
      onOutput: (stream, text) => {
        if (stream === 'stderr' && /\b(?:ERROR|failed)\b/i.test(text)) console.error(`[${id}] ${text.trim()}`);
      }
    });
    const completedAt = new Date().toISOString();
    setStatus(id, 'complete', 'Ready to watch!', {
      completedAt,
      finishedAt: completedAt,
      duration: media.duration,
      size: media.size,
      codecs: media.codecs
    });
    audit.append('SERVED', {
      game: guide.game, badge: guide.badge, client: guide.requestClient,
      video: selected.title, url: selected.webpageUrl,
      antigravity: selected.antigravityResponse || selected.selectionReason || 'not recorded'
    });
  } catch (error) {
    console.error(`[guide ${id}] ${error.stack || error.message}`);
    setStatus(id, 'failed', SAFE_FAILURE, {
      finishedAt: new Date().toISOString(),
      internalError: String(error.message || error).slice(0, 2000)
    });
    audit.append('FAILED', {
      game: guide.game, badge: guide.badge, client: guide.requestClient,
      antigravity: error.antigravityResponse || '', reason: error.message || error
    });
  }
}

async function pumpQueue() {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) await processGuide(queue.shift());
  } finally {
    processing = false;
  }
}

function createRequest(game, badge, client) {
  store.cleanup();
  const key = `${game.id}:${normalizeKey(badge)}`;
  const duplicate = store.findDuplicate(key);
  if (duplicate) {
    audit.append('DUPLICATE', { game: game.name, badge, client, video: duplicate.sourceTitle || duplicate.status });
    return { guide: duplicate, duplicate: true };
  }
  for (const old of store.state.guides.filter(item => item.key === key && item.status === 'failed')) store.remove(old.id);
  const createdAt = new Date().toISOString();
  const guide = store.add({
    id: crypto.randomUUID(), key, gameId: game.id, game: game.name, platform: game.platform,
    badge, status: 'queued', message: 'Waiting for a turn...', createdAt, requestClient: client,
    filePath: outputPathFor(game, badge)
  });
  queue.push(guide.id);
  audit.append('REQUESTED', { game: game.name, badge, client, video: 'PENDING' });
  pumpQueue().catch(error => console.error(error));
  return { guide, duplicate: false };
}

const adminController = createAdminController({
  authPath: path.join(DATA_ROOT, 'admin-auth.json'),
  catalogPath: CATALOG_PATH,
  store,
  audit,
  sendJson,
  readJson,
  outputPathFor,
  enqueue(id) {
    queue.push(id);
    pumpQueue().catch(error => console.error(error));
  }
});

function serveStatic(req, res, pathname) {
  const files = {
    '/': 'index.html', '/styles.css': 'styles.css', '/app.js': 'app.js',
    '/voidling.png': 'voidling.png', '/voidling.webp': 'voidling.webp', '/voidling.gif': 'voidling.gif',
    '/dad': 'dad.html', '/dad/': 'dad.html', '/dad/styles.css': 'dad.css', '/dad/app.js': 'dad.js'
  };
  const relative = files[pathname];
  if (!relative) return sendText(res, 404, 'Not found');
  const target = path.join(PUBLIC_ROOT, relative);
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) return sendText(res, 404, 'Not found');
    res.writeHead(200, { ...securityHeaders(MIME[path.extname(target)] || 'application/octet-stream'), 'content-length': stat.size, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target).pipe(res);
  });
}

function serveMedia(req, res, id) {
  const guide = store.state.guides.find(item => item.id === id && item.status === 'complete');
  if (!guide || !guide.filePath) return sendText(res, 404, 'Guide not found');
  let stat;
  try { stat = fs.statSync(guide.filePath); } catch { return sendText(res, 404, 'Guide not found'); }
  const range = req.headers.range;
  const baseHeaders = { ...securityHeaders('video/webm'), 'accept-ranges': 'bytes', 'content-disposition': `inline; filename="${slug(guide.badge, 'guide')}.webm"` };
  if (!range) {
    res.writeHead(200, { ...baseHeaders, 'content-length': stat.size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(guide.filePath).pipe(res);
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}` });
    return res.end();
  }
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) start = Math.max(0, stat.size - Number(match[2]));
  end = Math.min(end, stat.size - 1);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= stat.size) {
    res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(guide.filePath, { start, end }).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = url.pathname;
  const dadRoute = pathname === '/dad' || pathname.startsWith('/dad/');
  if (dadRoute && !isLoopbackAddress(req.socket.remoteAddress)) return sendText(res, 404, 'Not found');
  if (!clientAllowed(req)) return sendText(res, 403, 'This device is not allowed to use Voidling Guides.');
  if (dadRoute && await adminController.handle(req, res, pathname)) return;
  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204, securityHeaders('image/x-icon'));
    return res.end();
  }
  if (req.method === 'GET' && pathname === '/api/health') {
    const dependencies = dependencyHealth();
    return sendJson(res, 200, { ok: Object.values(dependencies).every(Boolean), dependencies, host: HOST, port: PORT, mascotUrl: mascotUrl() });
  }
  if (req.method === 'GET' && pathname === '/api/games') return sendJson(res, 200, { games: publicGames(loadCurrentCatalog()) });
  if (req.method === 'GET' && pathname === '/api/guides') {
    store.cleanup();
    return sendJson(res, 200, { guides: listPublicGuides() });
  }
  if (req.method === 'POST' && pathname === '/api/game-requests') {
    const body = await readJson(req);
    const platform = validatePlatform(body.platform);
    const name = validateGameName(body.name);
    const key = normalizeKey(`${platform}:${name}`);
    if (loadCurrentCatalog().some(game => game.id === stableId(`${platform}:${name}`))) {
      return sendJson(res, 409, { error: 'That game is already in the approved game list.' });
    }
    const duplicate = store.findPendingGameRequest(key);
    if (duplicate) return sendJson(res, 200, { request: publicGameRequest(duplicate), duplicate: true });
    if (store.state.gameRequests.filter(request => request.status === 'pending').length >= MAX_PENDING_GAME_REQUESTS) {
      return sendJson(res, 429, { error: 'Dad already has several game requests to review. Please try later.' });
    }
    const address = normalizeAddress(req.socket.remoteAddress);
    const last = lastGameRequestByClient.get(address) || 0;
    if (Date.now() - last < REQUEST_COOLDOWN_MS) {
      return sendJson(res, 429, { error: 'Please wait a moment before requesting another game.' });
    }
    lastGameRequestByClient.set(address, Date.now());
    const request = store.addGameRequest({
      id: crypto.randomUUID(), key, platform, name, status: 'pending',
      createdAt: new Date().toISOString(), requestClient: address
    });
    audit.append('GAME_REQUESTED', { game: name, client: address, reason: `Requested platform ${platform}` });
    return sendJson(res, 201, { request: publicGameRequest(request), duplicate: false });
  }
  if (req.method === 'POST' && pathname === '/api/requests') {
    const address = normalizeAddress(req.socket.remoteAddress);
    const last = lastRequestByClient.get(address) || 0;
    if (Date.now() - last < REQUEST_COOLDOWN_MS) return sendJson(res, 429, { error: 'Please wait a moment before requesting another guide.' });
    const body = await readJson(req);
    const game = loadCurrentCatalog().find(item => item.id === String(body.gameId || ''));
    if (!game) return sendJson(res, 400, { error: 'Please choose an approved game.' });
    const badge = validateBadge(body.badge);
    const duplicate = store.findDuplicate(`${game.id}:${normalizeKey(badge)}`);
    if (!duplicate && queuedCount() >= MAX_QUEUED) return sendJson(res, 429, { error: 'The guide queue is full. Please try again later.' });
    lastRequestByClient.set(address, Date.now());
    const result = createRequest(game, badge, address);
    return sendJson(res, result.duplicate ? 200 : 201, { guide: publicGuide(result.guide), duplicate: result.duplicate });
  }
  const confirmation = pathname.match(/^\/api\/guides\/([0-9a-f-]{36})\/confirmation$/i);
  if (req.method === 'POST' && confirmation) {
    const body = await readJson(req);
    if (typeof body.accept !== 'boolean') return sendJson(res, 400, { error: 'Confirmation must be yes or no.' });
    const guide = store.state.guides.find(item => item.id === confirmation[1]);
    if (!guide || guide.status !== 'needs_confirmation' || !guide.pendingSelection) {
      return sendJson(res, 409, { error: 'That guide is no longer waiting for confirmation.' });
    }
    const pending = guide.pendingSelection;
    const suggestedBadge = guide.suggestedBadge;
    if (!body.accept) {
      const declined = setStatus(guide.id, 'failed', 'Okay—no video was downloaded. Please ask Dad for help.', {
        finishedAt: new Date().toISOString(), pendingSelection: null, suggestedBadge: null
      });
      audit.append('DECLINED', {
        game: guide.game, badge: guide.badge, client: normalizeAddress(req.socket.remoteAddress),
        video: guide.sourceTitle, antigravity: pending.antigravityResponse,
        reason: `Rejected suggestion ${suggestedBadge}`
      });
      return sendJson(res, 200, { guide: publicGuide(declined) });
    }
    const game = loadCurrentCatalog().find(item => item.id === guide.gameId);
    if (!game) return sendJson(res, 409, { error: 'That game is no longer approved.' });
    const acceptedBadge = validateBadge(suggestedBadge);
    const newKey = `${game.id}:${normalizeKey(acceptedBadge)}`;
    const duplicate = store.findDuplicate(newKey);
    if (duplicate && duplicate.id !== guide.id) {
      store.remove(guide.id);
      audit.append('CONFIRMED_DUPLICATE', {
        game: guide.game, badge: acceptedBadge, client: normalizeAddress(req.socket.remoteAddress),
        video: duplicate.sourceTitle || duplicate.status
      });
      return sendJson(res, 200, { guide: publicGuide(duplicate), duplicate: true });
    }
    const accepted = store.update(guide.id, {
      badge: acceptedBadge, key: newKey, filePath: outputPathFor(game, acceptedBadge),
      status: 'queued', message: 'Confirmed! Waiting to download...',
      approvedSelection: pending, pendingSelection: null, suggestedBadge: null
    });
    audit.append('CONFIRMED', {
      game: guide.game, badge: acceptedBadge, client: normalizeAddress(req.socket.remoteAddress),
      video: guide.sourceTitle, antigravity: pending.antigravityResponse
    });
    queue.push(guide.id);
    pumpQueue().catch(error => console.error(error));
    return sendJson(res, 200, { guide: publicGuide(accepted), duplicate: false });
  }
  const media = pathname.match(/^\/media\/([0-9a-f-]{36})$/i);
  if ((req.method === 'GET' || req.method === 'HEAD') && media) return serveMedia(req, res, media[1]);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
  return sendText(res, 405, 'Method not allowed');
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error(error.stack || error.message);
    if (!res.headersSent) sendJson(res, 400, { error: error.message });
    else res.end();
  });
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} is already in use.` : error.message);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`Voidling Guides listening on http://127.0.0.1:${PORT}`);
  for (const values of Object.values(os.networkInterfaces())) {
    for (const address of values || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:${PORT}`);
    }
  }
  console.log(`Allowed clients: ${[...ALLOWED_CLIENTS].join(', ')}`);
});

const cleanupTimer = setInterval(() => store.cleanup(), 60 * 60 * 1000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

module.exports = { ALLOWED_CLIENTS, HOST, PORT, SAFE_FAILURE, clientAllowed, isLoopbackAddress, server };
