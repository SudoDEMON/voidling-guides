#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAdminController } from './src/admin-controller.js';
import { resolveAgyCommand } from './src/agy.js';
import { RequestAudit } from './src/audit.js';
import { gameKey, loadCatalog, publicGames } from './src/catalog.js';
import { convertGuide as defaultConvertGuide } from './src/converter.js';
import { discoverGuide as defaultDiscoverGuide, needsClarification, validatePinnedGuide as defaultValidatePinnedGuide } from './src/discovery.js';
import { HttpError, isMainModule, isWithinDirectory } from './src/fs-utils.js';
import { addressAllowed, normalizeAddress } from './src/network.js';
import { killActiveProcesses, run } from './src/process.js';
import { normalizeKey, slug, validateGameName, validateGuideName, validatePlatform } from './src/safety.js';
import { ensureLocalCatalog, loadSettings } from './src/settings.js';
import { BUSY_STATUSES, LibraryStore } from './src/store.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 16 * 1024;
const MAX_QUEUED = 5;
const MAX_PENDING_GAME_REQUESTS = 20;
const REQUEST_COOLDOWN_MS = 10_000;
const HEALTH_CACHE_TTL_MS = 30_000;
const MAX_SSE_CLIENTS = 64;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const SSE_KEEPALIVE_MS = 25_000;
export const SAFE_FAILURE = "I couldn't find the exact guide. Please go get approval from your Dad for the video first.";

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png'
};

const STATIC_FILES = {
  '/': 'index.html',
  '/tokens.css': 'tokens.css',
  '/styles.css': 'styles.css',
  '/client-utils.js': 'client-utils.js',
  '/app.js': 'app.js',
  '/voidling-weightless-float.png': 'voidling-weightless-float.png',
  '/dad': 'dad.html',
  '/dad/': 'dad.html',
  '/dad/styles.css': 'dad.css',
  '/dad/app.js': 'dad.js'
};

function parsePort(explicitPort, envPort) {
  if (explicitPort !== undefined) {
    const port = Number(explicitPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('port must be an integer from 0 to 65535.');
    }
    return port;
  }
  const raw = String(envPort ?? '3002').trim();
  if (!/^[1-9]\d{0,4}$/.test(raw) || Number(raw) > 65535) {
    throw new Error('VOIDLING_PORT must be an integer from 1 to 65535.');
  }
  return Number(raw);
}

function isClientDisconnect(error) {
  return Boolean(error && ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE'].includes(error.code));
}

function securityHeaders(contentType) {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  };
}

function sendJson(res, status, data, extraHeaders = {}) {
  const body = `${JSON.stringify(data)}\n`;
  res.writeHead(status, {
    ...securityHeaders('application/json; charset=utf-8'),
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

function sendText(res, status, message) {
  const body = `${message}\n`;
  res.writeHead(status, {
    ...securityHeaders('text/plain; charset=utf-8'),
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', chunk => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.byteLength;
      if (totalBytes > MAX_BODY) {
        req.pause();
        fail(new HttpError(413, 'Request is too large.'));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, 'Request must contain valid JSON.'));
      }
    });
    req.on('error', fail);
  });
}

function parseByteRange(rangeHeader, totalSize) {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) return null;
  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= totalSize) {
    return null;
  }
  return { start, end };
}

async function defaultCheckDependencies() {
  const probe = async command => {
    const executable = command === 'agy' ? resolveAgyCommand() : command;
    const args = command === 'ffmpeg' || command === 'ffprobe' ? ['-version'] : ['--version'];
    try {
      await run(executable, args, { timeoutMs: 5000, maxBuffer: 256 * 1024 });
      return true;
    } catch {
      return false;
    }
  };
  const commands = ['agy', 'yt-dlp', 'ffmpeg', 'ffprobe'];
  const results = await Promise.all(commands.map(probe));
  return Object.fromEntries(commands.map((command, index) => [command, results[index]]));
}

export function createApp(options = {}) {
  const root = options.root ? path.resolve(options.root) : ROOT_DIR;
  const publicRoot = options.publicRoot ? path.resolve(options.publicRoot) : path.join(root, 'public');
  const dataRoot = options.dataRoot
    ? path.resolve(options.dataRoot)
    : (process.env.VOIDLING_DATA_ROOT ? path.resolve(process.env.VOIDLING_DATA_ROOT) : path.join(root, 'data'));
  const settingsPath = options.settingsPath
    ? path.resolve(options.settingsPath)
    : (process.env.VOIDLING_SETTINGS_PATH ? path.resolve(process.env.VOIDLING_SETTINGS_PATH) : path.join(dataRoot, 'settings.json'));
  const catalogPath = options.catalogPath
    ? path.resolve(options.catalogPath)
    : (process.env.VOIDLING_CATALOG_PATH ? path.resolve(process.env.VOIDLING_CATALOG_PATH) : path.join(dataRoot, 'approved-guides.md'));
  const videosRoot = path.join(dataRoot, 'videos');
  const now = options.now || (() => Date.now());

  ensureLocalCatalog(catalogPath, path.join(root, 'approved-guides.example.md'));
  const localSettings = loadSettings(settingsPath);
  const host = options.host ?? process.env.VOIDLING_HOST ?? '0.0.0.0';
  const port = parsePort(options.port, process.env.VOIDLING_PORT);
  const allowedSource = options.allowedClients ?? (process.env.VOIDLING_ALLOWED_CLIENTS || localSettings.allowedClients.join(','));
  const allowedClients = new Set(
    (Array.isArray(allowedSource) ? allowedSource : String(allowedSource).split(','))
      .map(value => String(value).trim())
      .filter(Boolean)
  );

  const discoverGuideImpl = options.discoverGuide || defaultDiscoverGuide;
  const validatePinnedGuideImpl = options.validatePinnedGuide || defaultValidatePinnedGuide;
  const convertGuideImpl = options.convertGuide || defaultConvertGuide;
  const checkDependenciesImpl = options.checkDependencies || defaultCheckDependencies;
  const mascotUrl = fs.existsSync(path.join(publicRoot, 'voidling-weightless-float.png'))
    ? '/voidling-weightless-float.png'
    : null;

  const store = new LibraryStore(path.join(dataRoot, 'library.json'), { videosRoot, now });
  const audit = new RequestAudit(path.join(dataRoot, 'request-log.md'));
  store.load();
  store.cleanup();

  const queue = [];
  const lastRequestByClient = new Map();
  const lastGameRequestByClient = new Map();
  const sseClients = new Set();
  let processing = false;
  let healthCache = null;
  let healthInFlight = null;

  function clientAllowed(req) {
    return addressAllowed(req.socket?.remoteAddress, allowedClients);
  }

  function broadcastEvent(eventName) {
    if (sseClients.size === 0) return;
    const payload = `event: ${eventName}\ndata: {}\n\n`;
    for (const res of sseClients) {
      if (!res.writableEnded) res.write(payload);
    }
  }

  function pruneCooldowns(map, currentTime) {
    for (const [address, timestamp] of map) {
      if (currentTime - timestamp >= REQUEST_COOLDOWN_MS) map.delete(address);
    }
  }

  function loadCurrentCatalog() {
    return loadCatalog(catalogPath);
  }

  function publicGuide(guide) {
    return {
      id: guide.id,
      gameId: guide.gameId,
      game: guide.game,
      platform: guide.platform,
      guide: guide.guide,
      status: guide.status,
      message: guide.message,
      sourceTitle: guide.sourceTitle || '',
      channel: guide.channel || '',
      duration: guide.duration || 0,
      size: guide.size || 0,
      createdAt: guide.createdAt,
      completedAt: guide.completedAt || null,
      suggestedGuide: guide.status === 'needs_confirmation' ? guide.suggestedGuide : null,
      mediaUrl: guide.status === 'complete' ? `/media/${encodeURIComponent(guide.id)}` : null
    };
  }

  function publicGameRequest(request) {
    return {
      id: request.id,
      platform: request.platform,
      name: request.name,
      status: request.status,
      createdAt: request.createdAt
    };
  }

  function listPublicGuides() {
    return store.state.guides
      .slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(publicGuide);
  }

  function queuedCount() {
    return store.state.guides.filter(guide => guide.status === 'queued').length;
  }

  function outputPathFor(game, guideName) {
    const gameDir = `${slug(game.name, 'game')}-${game.id.slice(-8)}`;
    return path.join(videosRoot, gameDir, `${slug(guideName, 'guide')}.webm`);
  }

  function setStatus(id, status, message, extra = {}) {
    const updated = store.update(id, { status, message, ...extra });
    broadcastEvent('guides');
    return updated;
  }

  async function dependencyHealth() {
    const current = now();
    if (healthCache && current - healthCache.timestamp < HEALTH_CACHE_TTL_MS) {
      return healthCache.dependencies;
    }
    if (!healthInFlight) {
      healthInFlight = Promise.resolve()
        .then(() => checkDependenciesImpl())
        .then(dependencies => {
          healthCache = { timestamp: now(), dependencies };
          return dependencies;
        })
        .finally(() => {
          healthInFlight = null;
        });
    }
    return healthInFlight;
  }

  async function processGuide(id) {
    const guide = store.state.guides.find(item => item.id === id);
    if (!guide) return;
    try {
      const game = loadCurrentCatalog().find(item => item.id === guide.gameId);
      if (!game) throw new Error('The approved game was removed from the catalog.');
      const pinned = game.pinned[normalizeKey(guide.guide)];
      let selected;
      if (guide.approvedSelection) {
        selected = guide.approvedSelection;
      } else if (pinned) {
        setStatus(id, 'checking', 'Dad approved this guide. Checking the video...');
        selected = await validatePinnedGuideImpl(pinned.url);
        selected.antigravityResponse = 'PINNED: Dad-approved URL override';
        selected.canonicalGuide = pinned.guide;
      } else {
        setStatus(id, 'searching', 'Looking for the exact guide...');
        selected = await discoverGuideImpl(game, guide.guide);
      }

      if (!pinned && !guide.approvedSelection && needsClarification(guide.guide, selected.canonicalGuide)) {
        const pendingSelection = {
          id: selected.id,
          title: selected.title,
          channel: selected.channel,
          duration: selected.duration,
          webpageUrl: selected.webpageUrl,
          canonicalGuide: selected.canonicalGuide,
          selectionReason: selected.selectionReason,
          antigravityResponse: selected.antigravityResponse
        };
        setStatus(id, 'needs_confirmation', `Did you mean “${selected.canonicalGuide}”?`, {
          suggestedGuide: selected.canonicalGuide,
          sourceTitle: selected.title,
          channel: selected.channel,
          pendingSelection
        });
        audit.append('SUGGESTED', {
          game: guide.game, guide: guide.guide, client: guide.requestClient,
          video: selected.title, url: selected.webpageUrl,
          antigravity: selected.antigravityResponse,
          reason: `Did you mean ${selected.canonicalGuide}?`
        });
        return;
      }

      setStatus(id, 'downloading', 'Found it! Downloading the guide...', {
        sourceTitle: selected.title,
        channel: selected.channel
      });
      const media = await convertGuideImpl({
        url: selected.webpageUrl,
        outputPath: guide.filePath,
        overwrite: Boolean(guide.forceDownload),
        onOutput: (stream, text) => {
          if (stream === 'stderr' && /\b(?:ERROR|failed)\b/i.test(text)) console.error(`[${id}] ${text.trim()}`);
        }
      });
      const completedAt = new Date(now()).toISOString();
      setStatus(id, 'complete', 'Ready to watch!', {
        completedAt,
        finishedAt: completedAt,
        duration: media.duration,
        size: media.size,
        codecs: media.codecs,
        sourceUrl: selected.webpageUrl,
        forceDownload: false
      });
      audit.append('SERVED', {
        game: guide.game, guide: guide.guide, client: guide.requestClient,
        video: selected.title, url: selected.webpageUrl,
        antigravity: selected.antigravityResponse || selected.selectionReason || 'not recorded'
      });
    } catch (error) {
      console.error(`[guide ${id}] ${error.stack || error.message}`);
      setStatus(id, 'failed', SAFE_FAILURE, {
        finishedAt: new Date(now()).toISOString(),
        internalError: String(error.message || error).slice(0, 2000)
      });
      audit.append('FAILED', {
        game: guide.game, guide: guide.guide, client: guide.requestClient,
        antigravity: error.antigravityResponse || '', reason: error.message || error
      });
    }
  }

  async function pumpQueue() {
    if (options.disableQueueAutoPump || processing) return;
    processing = true;
    try {
      while (queue.length > 0) await processGuide(queue.shift());
    } finally {
      processing = false;
    }
  }

  function enqueue(id) {
    if (!queue.includes(id)) queue.push(id);
    if (!options.disableQueueAutoPump) {
      pumpQueue().catch(error => console.error(error));
    }
  }

  function createRequest(game, guideName, client) {
    store.cleanup();
    const key = `${game.id}:${normalizeKey(guideName)}`;
    const duplicate = store.findDuplicate(key);
    if (duplicate) {
      audit.append('DUPLICATE', { game: game.name, guide: guideName, client, video: duplicate.sourceTitle || duplicate.status });
      return { guide: duplicate, duplicate: true };
    }
    const failed = store.state.guides.filter(item => item.key === key && item.status === 'failed');
    const forceDownload = failed.some(old => old.forceDownload);
    for (const old of failed) store.remove(old.id);
    const createdAt = new Date(now()).toISOString();
    const guide = store.add({
      id: crypto.randomUUID(),
      key,
      gameId: game.id,
      game: game.name,
      platform: game.platform,
      guide: guideName,
      status: 'queued',
      message: 'Waiting for a turn...',
      createdAt,
      requestClient: client,
      filePath: outputPathFor(game, guideName),
      forceDownload
    });
    enqueue(guide.id);
    audit.append('REQUESTED', { game: game.name, guide: guideName, client, video: 'PENDING' });
    broadcastEvent('guides');
    return { guide, duplicate: false };
  }

  const adminController = createAdminController({
    authPath: path.join(dataRoot, 'admin-auth.json'),
    catalogPath,
    videosRoot,
    store,
    audit,
    sendJson,
    readJson,
    outputPathFor,
    validatePinnedGuide: validatePinnedGuideImpl,
    trustProxy: Boolean(options.trustProxy),
    enqueue,
    onChange(topic) {
      broadcastEvent(topic);
    }
  });

  function serveStatic(req, res, pathname) {
    const relative = STATIC_FILES[pathname];
    if (!relative) return sendText(res, 404, 'Not found');
    const target = path.join(publicRoot, relative);
    fs.stat(target, (error, stat) => {
      if (error || !stat.isFile()) return sendText(res, 404, 'Not found');
      const etag = `W/"${stat.size}-${Math.trunc(stat.mtimeMs)}"`;
      const headers = {
        ...securityHeaders(MIME[path.extname(target)] || 'application/octet-stream'),
        'content-length': stat.size,
        'cache-control': 'no-cache',
        etag,
        'last-modified': stat.mtime.toUTCString()
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      pipeline(fs.createReadStream(target), res, pipeError => {
        if (pipeError && !isClientDisconnect(pipeError)) {
          console.error(`Static stream error (${pathname}): ${pipeError.message}`);
          if (!res.headersSent) sendText(res, 500, 'Read failed');
          else res.destroy();
        }
      });
    });
  }

  function serveMedia(req, res, id) {
    const guide = store.state.guides.find(item => item.id === id && item.status === 'complete');
    if (!guide || !guide.filePath || !isWithinDirectory(videosRoot, guide.filePath)) {
      return sendText(res, 404, 'Guide not found');
    }
    let stat;
    try {
      stat = fs.statSync(guide.filePath);
    } catch {
      return sendText(res, 404, 'Guide not found');
    }
    if (!stat.isFile()) return sendText(res, 404, 'Guide not found');

    const range = req.headers.range;
    const baseHeaders = {
      ...securityHeaders('video/webm'),
      'accept-ranges': 'bytes',
      'content-disposition': `inline; filename="${slug(guide.guide, 'guide')}.webm"`
    };
    if (!range) {
      res.writeHead(200, { ...baseHeaders, 'content-length': stat.size });
      if (req.method === 'HEAD') return res.end();
      return pipeline(fs.createReadStream(guide.filePath), res, pipeError => {
        if (pipeError && !isClientDisconnect(pipeError)) {
          console.error(`Media stream error (${id}): ${pipeError.message}`);
          if (!res.headersSent) sendText(res, 500, 'Read failed');
          else res.destroy();
        }
      });
    }
    const parsedRange = parseByteRange(range, stat.size);
    if (!parsedRange) {
      res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    const { start, end } = parsedRange;
    res.writeHead(206, {
      ...baseHeaders,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1
    });
    if (req.method === 'HEAD') return res.end();
    pipeline(fs.createReadStream(guide.filePath, { start, end }), res, pipeError => {
      if (pipeError && !isClientDisconnect(pipeError)) {
        console.error(`Media range error (${id}): ${pipeError.message}`);
        if (!res.headersSent) sendText(res, 500, 'Read failed');
        else res.destroy();
      }
    });
  }

  function handleEvents(req, res) {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      return sendText(res, 503, 'Too many event listeners.');
    }
    res.writeHead(200, {
      ...securityHeaders('text/event-stream; charset=utf-8'),
      'cache-control': 'no-store',
      connection: 'keep-alive'
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
  }

  async function handleRequest(req, res) {
    if (!clientAllowed(req)) {
      return sendText(res, 403, 'This device is not allowed to use Voidling Guides.');
    }
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || `${host}:${port}`}`);
    } catch {
      throw new HttpError(400, 'Invalid request URL.');
    }
    const pathname = url.pathname;
    const dadRoute = pathname === '/dad' || pathname.startsWith('/dad/');
    if (dadRoute && await adminController.handle(req, res, pathname)) return;

    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204, securityHeaders('image/x-icon'));
      return res.end();
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      return handleEvents(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/health') {
      const dependencies = await dependencyHealth();
      return sendJson(res, 200, {
        ok: Object.values(dependencies).every(Boolean),
        dependencies,
        host,
        port: server.address()?.port ?? port,
        mascotUrl
      });
    }
    if (req.method === 'GET' && pathname === '/api/games') {
      return sendJson(res, 200, { games: publicGames(loadCurrentCatalog()) });
    }
    if (req.method === 'GET' && pathname === '/api/guides') {
      store.cleanup();
      return sendJson(res, 200, { guides: listPublicGuides() });
    }
    if (req.method === 'POST' && pathname === '/api/game-requests') {
      const body = await readJson(req);
      const platform = validatePlatform(body.platform);
      const name = validateGameName(body.name);
      const key = normalizeKey(`${platform}:${name}`);
      if (loadCurrentCatalog().some(game => gameKey(game.platform, game.name) === gameKey(platform, name))) {
        return sendJson(res, 409, { error: 'That game is already in the approved game list.' });
      }
      const duplicate = store.findPendingGameRequest(key);
      if (duplicate) return sendJson(res, 200, { request: publicGameRequest(duplicate), duplicate: true });
      if (store.state.gameRequests.filter(request => request.status === 'pending').length >= MAX_PENDING_GAME_REQUESTS) {
        return sendJson(res, 429, { error: 'Dad already has several game requests to review. Please try later.' });
      }
      const currentTime = now();
      pruneCooldowns(lastGameRequestByClient, currentTime);
      const address = normalizeAddress(req.socket?.remoteAddress);
      const last = lastGameRequestByClient.get(address) || 0;
      if (currentTime - last < REQUEST_COOLDOWN_MS) {
        return sendJson(res, 429, { error: 'Please wait a moment before requesting another game.' });
      }
      lastGameRequestByClient.set(address, currentTime);
      const request = store.addGameRequest({
        id: crypto.randomUUID(),
        key,
        platform,
        name,
        status: 'pending',
        createdAt: new Date(currentTime).toISOString(),
        requestClient: address
      });
      audit.append('GAME_REQUESTED', { game: name, client: address, reason: `Requested platform ${platform}` });
      return sendJson(res, 201, { request: publicGameRequest(request), duplicate: false });
    }
    if (req.method === 'POST' && pathname === '/api/requests') {
      const body = await readJson(req);
      const game = loadCurrentCatalog().find(item => item.id === String(body.gameId || ''));
      if (!game) return sendJson(res, 400, { error: 'Please choose an approved game.' });
      const guideName = validateGuideName(body.guide);
      const duplicate = store.findDuplicate(`${game.id}:${normalizeKey(guideName)}`);
      const address = normalizeAddress(req.socket?.remoteAddress);
      if (duplicate) {
        const result = createRequest(game, guideName, address);
        return sendJson(res, 200, { guide: publicGuide(result.guide), duplicate: true });
      }
      const currentTime = now();
      pruneCooldowns(lastRequestByClient, currentTime);
      const last = lastRequestByClient.get(address) || 0;
      if (currentTime - last < REQUEST_COOLDOWN_MS) {
        return sendJson(res, 429, { error: 'Please wait a moment before requesting another guide.' });
      }
      if (queuedCount() >= MAX_QUEUED) {
        return sendJson(res, 429, { error: 'The guide queue is full. Please try again later.' });
      }
      lastRequestByClient.set(address, currentTime);
      const result = createRequest(game, guideName, address);
      return sendJson(res, 201, { guide: publicGuide(result.guide), duplicate: false });
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
      const suggestedGuide = guide.suggestedGuide;
      if (!body.accept) {
        const declined = setStatus(guide.id, 'failed', 'Okay—no video was downloaded. Please ask Dad for help.', {
          finishedAt: new Date(now()).toISOString(),
          pendingSelection: null,
          suggestedGuide: null
        });
        audit.append('DECLINED', {
          game: guide.game, guide: guide.guide, client: normalizeAddress(req.socket?.remoteAddress),
          video: guide.sourceTitle, antigravity: pending.antigravityResponse,
          reason: `Rejected suggestion ${suggestedGuide}`
        });
        return sendJson(res, 200, { guide: publicGuide(declined) });
      }
      const game = loadCurrentCatalog().find(item => item.id === guide.gameId);
      if (!game) return sendJson(res, 409, { error: 'That game is no longer approved.' });
      const acceptedGuide = validateGuideName(suggestedGuide);
      const newKey = `${game.id}:${normalizeKey(acceptedGuide)}`;
      const duplicate = store.findDuplicate(newKey);
      if (duplicate && duplicate.id !== guide.id) {
        store.remove(guide.id);
        broadcastEvent('guides');
        audit.append('CONFIRMED_DUPLICATE', {
          game: guide.game, guide: acceptedGuide, client: normalizeAddress(req.socket?.remoteAddress),
          video: duplicate.sourceTitle || duplicate.status
        });
        return sendJson(res, 200, { guide: publicGuide(duplicate), duplicate: true });
      }
      if (queuedCount() >= MAX_QUEUED) {
        return sendJson(res, 429, { error: 'The guide queue is full. Please try again later.' });
      }
      const accepted = store.update(guide.id, {
        guide: acceptedGuide,
        key: newKey,
        filePath: outputPathFor(game, acceptedGuide),
        status: 'queued',
        message: 'Confirmed! Waiting to download...',
        approvedSelection: pending,
        pendingSelection: null,
        suggestedGuide: null
      });
      broadcastEvent('guides');
      audit.append('CONFIRMED', {
        game: guide.game, guide: acceptedGuide, client: normalizeAddress(req.socket?.remoteAddress),
        video: guide.sourceTitle, antigravity: pending.antigravityResponse
      });
      enqueue(guide.id);
      return sendJson(res, 200, { guide: publicGuide(accepted), duplicate: false });
    }

    const media = pathname.match(/^\/media\/([0-9a-f-]{36})$/i);
    if ((req.method === 'GET' || req.method === 'HEAD') && media) return serveMedia(req, res, media[1]);
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    return sendText(res, 405, 'Method not allowed');
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(error => {
      const status = error instanceof HttpError ? error.statusCode : 500;
      const clientMessage = error instanceof HttpError ? error.message : 'An unexpected server error occurred.';
      if (!(error instanceof HttpError)) console.error(error.stack || error.message);
      if (!res.headersSent) {
        const headers = status === 413 ? { connection: 'close' } : {};
        sendJson(res, status, { error: clientMessage }, headers);
        if (status === 413) res.once('finish', () => req.destroy());
      } else {
        res.destroy();
      }
    });
  });

  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : error.message);
    process.exitCode = 1;
  });

  const keepaliveTimer = setInterval(() => {
    for (const res of sseClients) {
      if (!res.writableEnded) res.write(': keepalive\n\n');
    }
  }, SSE_KEEPALIVE_MS);
  if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();

  let cleanupTimer = null;
  if (!options.disableCleanupTimer) {
    cleanupTimer = setInterval(() => {
      const hasBusy = store.state.guides.some(guide => BUSY_STATUSES.has(guide.status));
      const removed = store.cleanup({ sweepOrphans: !hasBusy });
      if (removed.length > 0) broadcastEvent('guides');
    }, CLEANUP_INTERVAL_MS);
    if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();
  }

  async function start() {
    store.cleanup({ sweepOrphans: true, minOrphanAgeMs: 0 });
    await new Promise((resolve, reject) => {
      const onError = err => reject(err);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    const actualPort = server.address()?.port ?? port;
    console.log(`Voidling Guides listening on http://127.0.0.1:${actualPort}`);
    for (const values of Object.values(os.networkInterfaces())) {
      for (const address of values || []) {
        if (address.family === 'IPv4' && !address.internal) console.log(`LAN: http://${address.address}:${actualPort}`);
      }
    }
    console.log(`Allowed clients: ${[...allowedClients].join(', ')}`);
    return server;
  }

  async function close() {
    clearInterval(keepaliveTimer);
    if (cleanupTimer) clearInterval(cleanupTimer);
    for (const res of sseClients) {
      if (!res.writableEnded) res.end();
    }
    sseClients.clear();
    killActiveProcesses('SIGTERM');
    if (!server.listening) return;
    await new Promise(resolve => server.close(() => resolve()));
  }

  return {
    ALLOWED_CLIENTS: allowedClients,
    HOST: host,
    PORT: port,
    SAFE_FAILURE,
    clientAllowed,
    close,
    handleRequest,
    queue,
    server,
    start,
    store
  };
}

if (isMainModule(import.meta.url)) {
  const app = createApp();
  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down Voidling Guides...`);
    app.close().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  app.start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
