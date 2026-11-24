import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AdminSessions, dadPostAllowed, verifyPassword } from './admin-auth.js';
import { createPinHandler } from './admin-pins.js';
import {
  addApprovedGame, addPlatform, gameKey, loadCatalog, loadPlatforms,
  removeApprovedGame, removePlatform, updateApprovedGame, updatePlatform, upsertPinnedGuide
} from './catalog.js';
import { isWithinDirectory } from './fs-utils.js';
import { normalizeAddress } from './network.js';
import { normalizeKey, validateGuideName } from './safety.js';
import { BUSY_STATUSES } from './store.js';

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 10;

export function queueApprovedGuide(options, game, guideName, selected, client) {
  const key = `${game.id}:${normalizeKey(guideName)}`;
  const existing = options.store.state.guides.filter(guide => guide.key === key).at(-1) || null;
  const createdAt = new Date().toISOString();
  const approvedSelection = {
    id: selected.id, title: selected.title, channel: selected.channel,
    duration: selected.duration, webpageUrl: selected.webpageUrl,
    canonicalGuide: guideName, selectionReason: 'Dad-approved URL',
    antigravityResponse: 'PINNED: Dad-approved URL override'
  };
  const fields = {
    key, gameId: game.id, game: game.name, platform: game.platform, guide: guideName,
    status: 'queued', message: 'Dad approved this video. Waiting to download...',
    createdAt: existing?.createdAt || createdAt, requestClient: existing?.requestClient || client,
    filePath: existing?.filePath || options.outputPathFor(game, guideName), sourceUrl: selected.webpageUrl,
    approvedSelection, pendingSelection: null, suggestedGuide: null,
    sourceTitle: selected.title, channel: selected.channel,
    forceDownload: true, completedAt: null, finishedAt: null,
    duration: null, size: null, codecs: null, internalError: null
  };
  const guide = existing
    ? options.store.update(existing.id, fields)
    : options.store.add({ id: crypto.randomUUID(), ...fields });
  options.enqueue(guide.id);
  return { guide, reused: Boolean(existing) };
}

export function createAdminController(options) {
  const sessions = new AdminSessions();
  const loginFailuresByClient = new Map();

  function cookieSecurity(req) {
    if (req.socket?.encrypted) return true;
    return Boolean(options.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  }

  function state() {
    const games = loadCatalog(options.catalogPath).map(game => ({
      id: game.id, platform: game.platform, name: game.name,
      pins: Object.values(game.pinned).sort((a, b) => a.guide.localeCompare(b.guide))
    }));
    const requests = options.store.state.guides.slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(guide => ({
        id: guide.id, gameId: guide.gameId, game: guide.game, platform: guide.platform,
        guide: guide.guide, suggestedGuide: guide.suggestedGuide || null,
        status: guide.status, message: guide.message, sourceTitle: guide.sourceTitle || '',
        requestClient: guide.requestClient || '', createdAt: guide.createdAt,
        url: guide.sourceUrl || guide.approvedSelection?.webpageUrl || guide.pendingSelection?.webpageUrl || ''
      }));
    const gameRequests = options.store.state.gameRequests.slice()
      .sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1)
        || Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(request => ({
        id: request.id, platform: request.platform, name: request.name,
        status: request.status, createdAt: request.createdAt,
        resolvedAt: request.resolvedAt || null, requestClient: request.requestClient || ''
      }));
    const { history, log } = options.audit.snapshot(50, 30);
    return { games, platforms: loadPlatforms(options.catalogPath), requests, gameRequests, history, log };
  }

  function rejectMutation(req, res, action) {
    if (!dadPostAllowed(req)) {
      options.sendJson(res, 403, { error: `${action} must come from the Dad portal.` });
      return true;
    }
    if (!sessions.authenticated(req)) {
      options.sendJson(res, 401, { error: 'Please sign in again.' });
      return true;
    }
    return false;
  }

  function removeGuideFile(guide) {
    if (!guide.filePath || !fs.existsSync(guide.filePath)) return false;
    if (!isWithinDirectory(options.videosRoot, guide.filePath)) {
      throw new Error('Refusing to remove a guide file outside the managed videos directory.');
    }
    fs.rmSync(guide.filePath, { force: true });
    const parent = path.dirname(guide.filePath);
    if (isWithinDirectory(options.videosRoot, parent)) {
      try {
        fs.rmdirSync(parent);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
    }
    return true;
  }

  function pruneFailures(now) {
    for (const [client, timestamps] of loginFailuresByClient) {
      const active = timestamps.filter(time => now - time < LOGIN_WINDOW_MS);
      if (active.length === 0) loginFailuresByClient.delete(client);
      else loginFailuresByClient.set(client, active);
    }
  }

  async function updateRequest(req, res, id) {
    if (rejectMutation(req, res, 'Request editing')) return true;
    const body = await options.readJson(req);
    const guide = options.store.state.guides.find(item => item.id === id);
    if (!guide) {
      options.sendJson(res, 404, { error: 'That request no longer exists.' });
      return true;
    }
    if (BUSY_STATUSES.has(guide.status)) {
      options.sendJson(res, 409, { error: 'Wait for the current guide work to finish before editing it.' });
      return true;
    }
    const catalog = loadCatalog(options.catalogPath);
    const game = catalog.find(item => item.id === String(body.gameId || ''));
    if (!game) {
      options.sendJson(res, 400, { error: 'Please choose an approved game.' });
      return true;
    }
    const guideName = validateGuideName(body.guide);
    const key = `${game.id}:${normalizeKey(guideName)}`;
    const duplicate = options.store.findDuplicate(key);
    if (duplicate && duplicate.id !== guide.id) {
      options.sendJson(res, 409, { error: 'That corrected request already exists in the library.' });
      return true;
    }

    const oldLabel = `${guide.platform}: ${guide.game} / ${guide.guide}`;
    const changes = { gameId: game.id, game: game.name, platform: game.platform, guide: guideName, key };
    let requeued = false;
    if (guide.status === 'failed' || guide.status === 'needs_confirmation') {
      const acceptedSuggestion = guide.gameId === game.id && guide.status === 'needs_confirmation'
        && normalizeKey(guide.suggestedGuide) === normalizeKey(guideName)
        && guide.pendingSelection;
      Object.assign(changes, {
        status: 'queued', message: 'Dad corrected this request. Waiting to download...',
        filePath: options.outputPathFor(game, guideName), finishedAt: null, internalError: null,
        approvedSelection: acceptedSuggestion || null, pendingSelection: null, suggestedGuide: null
      });
      if (!acceptedSuggestion) Object.assign(changes, { sourceTitle: '', channel: '' });
      requeued = true;
    }
    const oldGame = catalog.find(item => item.id === guide.gameId);
    const pin = oldGame?.pinned[normalizeKey(guide.guide)];
    if (pin) {
      upsertPinnedGuide(options.catalogPath, game.id, guideName, pin.url, { gameId: oldGame.id, id: pin.id });
    }
    if (guide.status === 'complete' && guide.approvedSelection) {
      changes.approvedSelection = { ...guide.approvedSelection, canonicalGuide: guideName };
    }
    const updated = options.store.update(guide.id, changes);
    options.audit.append('DAD_REQUEST_UPDATED', {
      game: game.name, guide: guideName, client: normalizeAddress(req.socket.remoteAddress),
      video: updated.sourceTitle || updated.status, reason: `${oldLabel} -> ${game.platform}: ${game.name} / ${guideName}`
    });
    if (requeued) options.enqueue(guide.id);
    options.onChange?.('guides');
    options.sendJson(res, 200, {
      message: requeued ? `Updated ${guideName} and queued it again.` : `Renamed the library entry to ${guideName}.`,
      ...state()
    });
    return true;
  }

  const handlePins = createPinHandler(options, { rejectMutation, state, busyStatuses: BUSY_STATUSES, queueApprovedGuide });

  function refreshGameLabels(games) {
    for (const guide of options.store.state.guides) {
      const game = games.find(item => item.id === guide.gameId);
      if (game) Object.assign(guide, { game: game.name, platform: game.platform });
    }
    options.store.save();
  }

  async function handle(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/dad/api/state') {
      const authenticated = sessions.authenticated(req);
      const configured = fs.existsSync(options.authPath);
      options.sendJson(res, 200, authenticated ? { configured, authenticated, ...state() } : { configured, authenticated });
      return true;
    }
    if (req.method === 'GET' && pathname === '/dad/api/history') {
      if (!sessions.authenticated(req)) {
        options.sendJson(res, 401, { error: 'Please sign in again.' });
        return true;
      }
      const offset = new URL(req.url, 'http://localhost').searchParams.get('offset');
      options.sendJson(res, 200, options.audit.guideHistory(Number(offset)));
      return true;
    }
    if (req.method === 'POST' && pathname === '/dad/api/login') {
      if (!dadPostAllowed(req)) {
        options.sendJson(res, 403, { error: 'Login must come from the Dad portal.' });
        return true;
      }
      if (!fs.existsSync(options.authPath)) {
        options.sendJson(res, 503, { error: 'Dad password is not configured. Run npm run set-password first.' });
        return true;
      }
      const client = normalizeAddress(req.socket.remoteAddress);
      const now = Date.now();
      pruneFailures(now);
      const failures = loginFailuresByClient.get(client) || [];
      if (failures.length >= MAX_LOGIN_FAILURES) {
        options.sendJson(res, 429, { error: 'Too many login attempts. Try again later.' });
        return true;
      }
      const body = await options.readJson(req);
      if (!await verifyPassword(options.authPath, body.password)) {
        failures.push(now);
        loginFailuresByClient.set(client, failures);
        options.audit.append('DAD_LOGIN_FAILED', { client, reason: 'Incorrect password' });
        options.sendJson(res, 401, { error: 'Incorrect password.' });
        return true;
      }
      loginFailuresByClient.delete(client);
      const token = sessions.create();
      options.audit.append('DAD_LOGIN', { client, reason: 'Password-protected Dad portal login' });
      options.sendJson(res, 200, { authenticated: true }, {
        'set-cookie': sessions.cookie(token, undefined, { secure: cookieSecurity(req) })
      });
      return true;
    }
    if (req.method === 'POST' && pathname === '/dad/api/logout') {
      if (!dadPostAllowed(req)) {
        options.sendJson(res, 403, { error: 'Logout must come from the Dad portal.' });
        return true;
      }
      sessions.destroy(req);
      options.sendJson(res, 200, { authenticated: false }, {
        'set-cookie': sessions.cookie('', 0, { secure: cookieSecurity(req) })
      });
      return true;
    }

    const platformMatch = pathname.match(/^\/dad\/api\/platforms\/([a-z0-9-]{3,160})$/i);
    if ((req.method === 'POST' && pathname === '/dad/api/platforms')
      || (platformMatch && ['PATCH', 'DELETE'].includes(req.method))) {
      if (rejectMutation(req, res, 'Platform management')) return true;
      const body = await options.readJson(req);
      const old = platformMatch && loadPlatforms(options.catalogPath).find(item => item.id === platformMatch[1]);
      if (platformMatch && !old) {
        options.sendJson(res, 404, { error: 'That platform no longer exists.' });
        return true;
      }
      const games = loadCatalog(options.catalogPath);
      if (old && req.method === 'DELETE' && (games.some(game => normalizeKey(game.platform) === normalizeKey(old.name))
        || options.store.state.guides.some(guide => normalizeKey(guide.platform) === normalizeKey(old.name)))) {
        options.sendJson(res, 409, { error: 'Move or remove the games and guides using this platform first.' });
        return true;
      }
      if (old && req.method === 'PATCH' && options.store.state.guides.some(guide =>
        normalizeKey(guide.platform) === normalizeKey(old.name) && BUSY_STATUSES.has(guide.status))) {
        options.sendJson(res, 409, { error: 'Wait for this platform’s guide work to finish before editing it.' });
        return true;
      }
      const platform = req.method === 'POST' ? addPlatform(options.catalogPath, body.name)
        : req.method === 'PATCH' ? updatePlatform(options.catalogPath, old.id, body.name)
          : removePlatform(options.catalogPath, old.id);
      if (req.method === 'PATCH') {
        refreshGameLabels(loadCatalog(options.catalogPath));
        options.onChange?.('games');
        options.onChange?.('guides');
      }
      options.audit.append(`DAD_PLATFORM_${req.method === 'POST' ? 'ADDED' : req.method === 'PATCH' ? 'UPDATED' : 'REMOVED'}`, {
        client: normalizeAddress(req.socket.remoteAddress), reason: old ? `${old.name} -> ${platform.name}` : platform.name
      });
      options.sendJson(res, req.method === 'POST' ? 201 : 200, {
        message: `${req.method === 'DELETE' ? 'Removed' : 'Saved'} platform ${platform.name}.`, ...state()
      });
      return true;
    }

    if (req.method === 'POST' && pathname === '/dad/api/games') {
      if (rejectMutation(req, res, 'Game approval')) return true;
      const body = await options.readJson(req);
      const game = addApprovedGame(options.catalogPath, body.platform, body.name);
      options.audit.append('DAD_GAME_ADDED', {
        game: game.name, client: normalizeAddress(req.socket.remoteAddress), reason: `Approved platform ${game.platform}`
      });
      options.onChange?.('games');
      options.sendJson(res, 201, { message: `Added ${game.name}.`, game, ...state() });
      return true;
    }

    const gameMatch = pathname.match(/^\/dad\/api\/games\/([a-z0-9-]{3,160})$/i);
    if (req.method === 'PATCH' && gameMatch) {
      if (rejectMutation(req, res, 'Game editing')) return true;
      const body = await options.readJson(req);
      const old = loadCatalog(options.catalogPath).find(item => item.id === gameMatch[1]);
      if (!old) {
        options.sendJson(res, 404, { error: 'That approved game no longer exists.' });
        return true;
      }
      if (options.store.state.guides.some(guide => guide.gameId === old.id && BUSY_STATUSES.has(guide.status))) {
        options.sendJson(res, 409, { error: 'Wait for this game’s guide work to finish before editing it.' });
        return true;
      }
      const game = updateApprovedGame(options.catalogPath, old.id, body.platform, body.name);
      refreshGameLabels([game]);
      options.audit.append('DAD_GAME_UPDATED', {
        game: game.name, client: normalizeAddress(req.socket.remoteAddress),
        reason: `${old.platform}: ${old.name} -> ${game.platform}: ${game.name}`
      });
      options.onChange?.('games');
      options.onChange?.('guides');
      options.sendJson(res, 200, { message: `Saved ${game.name}.`, game, ...state() });
      return true;
    }

    if (req.method === 'DELETE' && gameMatch) {
      if (rejectMutation(req, res, 'Game removal')) return true;
      const game = loadCatalog(options.catalogPath).find(item => item.id === gameMatch[1]);
      if (!game) {
        options.sendJson(res, 404, { error: 'That approved game no longer exists.' });
        return true;
      }
      const related = options.store.state.guides.filter(guide => guide.gameId === game.id);
      if (related.length > 0) {
        options.sendJson(res, 409, {
          error: `Remove the ${related.length} related guide ${related.length === 1 ? 'entry' : 'entries'} first.`
        });
        return true;
      }
      removeApprovedGame(options.catalogPath, game.id);
      options.audit.append('DAD_GAME_REMOVED', {
        game: game.name, client: normalizeAddress(req.socket.remoteAddress),
        reason: `Removed ${game.platform} game and ${Object.keys(game.pinned).length} approved video(s)`
      });
      options.onChange?.('games');
      options.sendJson(res, 200, { message: `Removed ${game.name}.`, ...state() });
      return true;
    }

    const gameRequestMatch = pathname.match(/^\/dad\/api\/game-requests\/([0-9a-f-]{36})$/i);
    if (req.method === 'DELETE' && gameRequestMatch) {
      if (rejectMutation(req, res, 'Game request removal')) return true;
      const request = options.store.removeGameRequest(gameRequestMatch[1]);
      if (!request) {
        options.sendJson(res, 404, { error: 'That game request no longer exists.' });
        return true;
      }
      options.audit.append('DAD_GAME_REQUEST_REMOVED', {
        game: request.name, client: normalizeAddress(req.socket.remoteAddress),
        reason: `Removed ${request.status} ${request.platform} game request`
      });
      options.sendJson(res, 200, { message: `Removed the ${request.name} game request.`, ...state() });
      return true;
    }
    if (req.method === 'POST' && gameRequestMatch) {
      if (rejectMutation(req, res, 'Game request review')) return true;
      const body = await options.readJson(req);
      const request = options.store.state.gameRequests.find(item => item.id === gameRequestMatch[1]);
      if (!request || request.status !== 'pending') {
        options.sendJson(res, 409, { error: 'That game request is no longer waiting for review.' });
        return true;
      }
      if (!['approve', 'decline'].includes(body.decision)) {
        options.sendJson(res, 400, { error: 'Choose Approve or Decline.' });
        return true;
      }
      const resolvedAt = new Date().toISOString();
      if (body.decision === 'approve') {
        const existing = loadCatalog(options.catalogPath).find(
          game => gameKey(game.platform, game.name) === gameKey(request.platform, request.name)
        );
        const game = existing || addApprovedGame(options.catalogPath, request.platform, request.name);
        options.store.updateGameRequest(request.id, { status: 'approved', resolvedAt, gameId: game.id });
        options.audit.append('DAD_GAME_REQUEST_APPROVED', {
          game: request.name, client: normalizeAddress(req.socket.remoteAddress),
          reason: `Approved requested platform ${request.platform}`
        });
        options.onChange?.('games');
        options.sendJson(res, 200, { message: `Approved ${request.name}.`, ...state() });
        return true;
      }
      options.store.updateGameRequest(request.id, { status: 'declined', resolvedAt });
      options.audit.append('DAD_GAME_REQUEST_DECLINED', {
        game: request.name, client: normalizeAddress(req.socket.remoteAddress),
        reason: `Declined requested platform ${request.platform}`
      });
      options.sendJson(res, 200, { message: `Declined ${request.name}.`, ...state() });
      return true;
    }

    if (await handlePins(req, res, pathname)) return true;

    const requestMatch = pathname.match(/^\/dad\/api\/requests\/([0-9a-f-]{36})$/i);
    if (req.method === 'DELETE' && requestMatch) {
      if (rejectMutation(req, res, 'Guide removal')) return true;
      const guide = options.store.state.guides.find(item => item.id === requestMatch[1]);
      if (!guide) {
        options.sendJson(res, 404, { error: 'That guide entry no longer exists.' });
        return true;
      }
      if (BUSY_STATUSES.has(guide.status)) {
        options.sendJson(res, 409, { error: 'Wait for the current guide work to finish before removing it.' });
        return true;
      }
      const removedVideo = removeGuideFile(guide);
      options.store.remove(guide.id);
      options.audit.append('DAD_REQUEST_REMOVED', {
        game: guide.game, guide: guide.guide, client: normalizeAddress(req.socket.remoteAddress),
        video: guide.sourceTitle || guide.status,
        reason: removedVideo ? 'Removed library entry and managed video file' : 'Removed library entry'
      });
      options.onChange?.('guides');
      options.sendJson(res, 200, { message: `Removed ${guide.guide} from the library.`, ...state() });
      return true;
    }
    if (req.method === 'PATCH' && requestMatch) {
      return updateRequest(req, res, requestMatch[1]);
    }
    return false;
  }

  return {
    handle,
    state
  };
}
