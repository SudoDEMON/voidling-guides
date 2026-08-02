'use strict';

const fs = require('fs');
const path = require('path');
const { AdminSessions, dadPostAllowed, verifyPassword } = require('./admin-auth');
const {
  addApprovedGame, loadCatalog, removeApprovedGame, removePinnedGuide, upsertPinnedGuide
} = require('./catalog');
const { validatePinnedGuide } = require('./discovery');
const { normalizeAddress } = require('./network');
const { normalizeKey, stableId, validateGuideName } = require('./safety');

function createAdminController(options) {
  const sessions = new AdminSessions();
  let loginFailures = [];
  const busyStatuses = new Set(['queued', 'searching', 'checking', 'downloading']);

  function state() {
    const games = loadCatalog(options.catalogPath).map(game => ({
      id: game.id, platform: game.platform, name: game.name,
      pins: Object.values(game.pinned).sort((a, b) => a.badge.localeCompare(b.badge))
    }));
    const requests = options.store.state.guides.slice()
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 30)
      .map(guide => ({
        id: guide.id, gameId: guide.gameId, game: guide.game, platform: guide.platform,
        badge: guide.badge, suggestedBadge: guide.suggestedBadge || null,
        status: guide.status, message: guide.message, sourceTitle: guide.sourceTitle || '',
        requestClient: guide.requestClient || '', createdAt: guide.createdAt
      }));
    const gameRequests = options.store.state.gameRequests.slice()
      .sort((a, b) => (a.status === 'pending' ? -1 : 1) - (b.status === 'pending' ? -1 : 1)
        || Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 40)
      .map(request => ({
        id: request.id, platform: request.platform, name: request.name,
        status: request.status, createdAt: request.createdAt,
        resolvedAt: request.resolvedAt || null, requestClient: request.requestClient || ''
      }));
    return { games, requests, gameRequests, log: options.audit.recent(50) };
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
    const videosRoot = path.resolve(options.videosRoot);
    const target = path.resolve(guide.filePath);
    if (!target.startsWith(`${videosRoot}${path.sep}`)) {
      throw new Error('Refusing to remove a guide file outside the managed videos directory.');
    }
    fs.rmSync(target, { force: true });
    try { fs.rmdirSync(path.dirname(target)); } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    return true;
  }

  async function updateRequest(req, res, id) {
    if (rejectMutation(req, res, 'Request editing')) return;
    const guide = options.store.state.guides.find(item => item.id === id);
    if (!guide) return options.sendJson(res, 404, { error: 'That request no longer exists.' });
    if (['queued', 'searching', 'checking', 'downloading'].includes(guide.status)) {
      return options.sendJson(res, 409, { error: 'Wait for the current guide work to finish before editing it.' });
    }
    const body = await options.readJson(req);
    const game = loadCatalog(options.catalogPath).find(item => item.id === String(body.gameId || ''));
    if (!game) return options.sendJson(res, 400, { error: 'Please choose an approved game.' });
    const badge = validateGuideName(body.guide ?? body.badge);
    const key = `${game.id}:${normalizeKey(badge)}`;
    const duplicate = options.store.findDuplicate(key);
    if (duplicate && duplicate.id !== guide.id) {
      return options.sendJson(res, 409, { error: 'That corrected request already exists in the library.' });
    }

    const oldLabel = `${guide.platform}: ${guide.game} / ${guide.badge}`;
    const changes = { gameId: game.id, game: game.name, platform: game.platform, badge, key };
    let requeued = false;
    if (guide.status === 'failed' || guide.status === 'needs_confirmation') {
      const acceptedSuggestion = guide.status === 'needs_confirmation'
        && normalizeKey(guide.suggestedBadge) === normalizeKey(badge)
        && guide.pendingSelection;
      Object.assign(changes, {
        status: 'queued', message: 'Dad corrected this request. Waiting to download...',
        filePath: options.outputPathFor(game, badge), finishedAt: null, internalError: null,
        approvedSelection: acceptedSuggestion || null, pendingSelection: null, suggestedBadge: null
      });
      if (!acceptedSuggestion) Object.assign(changes, { sourceTitle: '', channel: '' });
      requeued = true;
    }
    const updated = options.store.update(guide.id, changes);
    options.audit.append('DAD_REQUEST_UPDATED', {
      game: game.name, badge, client: normalizeAddress(req.socket.remoteAddress),
      video: updated.sourceTitle || updated.status, reason: `${oldLabel} -> ${game.platform}: ${game.name} / ${badge}`
    });
    if (requeued) options.enqueue(guide.id);
    return options.sendJson(res, 200, {
      message: requeued ? `Updated ${badge} and queued it again.` : `Renamed the library entry to ${badge}.`,
      ...state()
    });
  }

  async function handle(req, res, pathname) {
    if (req.method === 'GET' && pathname === '/dad/api/state') {
      const authenticated = sessions.authenticated(req);
      const configured = fs.existsSync(options.authPath);
      options.sendJson(res, 200, authenticated ? { configured, authenticated, ...state() } : { configured, authenticated });
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
      const now = Date.now();
      loginFailures = loginFailures.filter(time => now - time < 15 * 60 * 1000);
      if (loginFailures.length >= 10) {
        options.sendJson(res, 429, { error: 'Too many login attempts. Try again later.' });
        return true;
      }
      const body = await options.readJson(req);
      if (!verifyPassword(options.authPath, body.password)) {
        loginFailures.push(now);
        options.audit.append('DAD_LOGIN_FAILED', { client: normalizeAddress(req.socket.remoteAddress), reason: 'Incorrect password' });
        options.sendJson(res, 401, { error: 'Incorrect password.' });
        return true;
      }
      loginFailures = [];
      const token = sessions.create();
      options.audit.append('DAD_LOGIN', { client: normalizeAddress(req.socket.remoteAddress), reason: 'Password-protected Dad portal login' });
      options.sendJson(res, 200, { authenticated: true }, { 'set-cookie': sessions.cookie(token) });
      return true;
    }
    if (req.method === 'POST' && pathname === '/dad/api/logout') {
      if (!dadPostAllowed(req)) {
        options.sendJson(res, 403, { error: 'Logout must come from the Dad portal.' });
        return true;
      }
      sessions.destroy(req);
      options.sendJson(res, 200, { authenticated: false }, { 'set-cookie': sessions.cookie('', 0) });
      return true;
    }
    if (req.method === 'POST' && pathname === '/dad/api/games') {
      if (rejectMutation(req, res, 'Game approval')) return true;
      const body = await options.readJson(req);
      const game = addApprovedGame(options.catalogPath, body.platform, body.name);
      options.audit.append('DAD_GAME_ADDED', {
        game: game.name, client: normalizeAddress(req.socket.remoteAddress), reason: `Approved platform ${game.platform}`
      });
      options.sendJson(res, 201, { message: `Added ${game.name}.`, game, ...state() });
      return true;
    }
    const gameMatch = pathname.match(/^\/dad\/api\/games\/([a-z0-9-]{3,160})$/i);
    if (req.method === 'DELETE' && gameMatch) {
      if (rejectMutation(req, res, 'Game removal')) return true;
      const game = loadCatalog(options.catalogPath).find(item => item.id === gameMatch[1]);
      if (!game) return options.sendJson(res, 404, { error: 'That approved game no longer exists.' });
      const related = options.store.state.guides.filter(guide => guide.gameId === game.id);
      if (related.length > 0) {
        return options.sendJson(res, 409, {
          error: `Remove the ${related.length} related guide ${related.length === 1 ? 'entry' : 'entries'} first.`
        });
      }
      removeApprovedGame(options.catalogPath, game.id);
      options.audit.append('DAD_GAME_REMOVED', {
        game: game.name, client: normalizeAddress(req.socket.remoteAddress),
        reason: `Removed ${game.platform} game and ${Object.keys(game.pinned).length} approved video(s)`
      });
      options.sendJson(res, 200, { message: `Removed ${game.name}.`, ...state() });
      return true;
    }
    const gameRequestMatch = pathname.match(/^\/dad\/api\/game-requests\/([0-9a-f-]{36})$/i);
    if (req.method === 'DELETE' && gameRequestMatch) {
      if (rejectMutation(req, res, 'Game request removal')) return true;
      const request = options.store.removeGameRequest(gameRequestMatch[1]);
      if (!request) return options.sendJson(res, 404, { error: 'That game request no longer exists.' });
      options.audit.append('DAD_GAME_REQUEST_REMOVED', {
        game: request.name, client: normalizeAddress(req.socket.remoteAddress),
        reason: `Removed ${request.status} ${request.platform} game request`
      });
      options.sendJson(res, 200, { message: `Removed the ${request.name} game request.`, ...state() });
      return true;
    }
    if (req.method === 'POST' && gameRequestMatch) {
      if (rejectMutation(req, res, 'Game request review')) return true;
      const request = options.store.state.gameRequests.find(item => item.id === gameRequestMatch[1]);
      if (!request || request.status !== 'pending') {
        options.sendJson(res, 409, { error: 'That game request is no longer waiting for review.' });
        return true;
      }
      const body = await options.readJson(req);
      if (!['approve', 'decline'].includes(body.decision)) {
        options.sendJson(res, 400, { error: 'Choose Approve or Decline.' });
        return true;
      }
      const resolvedAt = new Date().toISOString();
      if (body.decision === 'approve') {
        const gameId = stableId(`${request.platform}:${request.name}`);
        const existing = loadCatalog(options.catalogPath).find(game => game.id === gameId);
        const game = existing || addApprovedGame(options.catalogPath, request.platform, request.name);
        options.store.updateGameRequest(request.id, { status: 'approved', resolvedAt, gameId: game.id });
        options.audit.append('DAD_GAME_REQUEST_APPROVED', {
          game: request.name, client: normalizeAddress(req.socket.remoteAddress),
          reason: `Approved requested platform ${request.platform}`
        });
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
    if (req.method === 'POST' && pathname === '/dad/api/pins') {
      if (rejectMutation(req, res, 'Approval')) return true;
      const body = await options.readJson(req);
      const game = loadCatalog(options.catalogPath).find(item => item.id === String(body.gameId || ''));
      if (!game) {
        options.sendJson(res, 400, { error: 'Please choose an approved game.' });
        return true;
      }
      const badge = validateGuideName(body.guide ?? body.badge);
      const selected = await validatePinnedGuide(body.url);
      const result = upsertPinnedGuide(options.catalogPath, game.id, badge, selected.webpageUrl);
      options.audit.append(result.replaced ? 'DAD_PIN_REPLACED' : 'DAD_PIN_ADDED', {
        game: game.name, badge, client: normalizeAddress(req.socket.remoteAddress),
        video: selected.title, url: selected.webpageUrl, reason: 'Password-protected Dad portal'
      });
      options.sendJson(res, result.replaced ? 200 : 201, {
        message: result.replaced ? `Updated the approved video for ${badge}.` : `Approved ${badge}.`,
        pin: { gameId: game.id, badge, url: selected.webpageUrl, title: selected.title }, ...state()
      });
      return true;
    }
    if (req.method === 'DELETE' && pathname === '/dad/api/pins') {
      if (rejectMutation(req, res, 'Approved video removal')) return true;
      const body = await options.readJson(req);
      const game = loadCatalog(options.catalogPath).find(item => item.id === String(body.gameId || ''));
      if (!game) return options.sendJson(res, 404, { error: 'That approved game no longer exists.' });
      const badge = validateGuideName(body.guide ?? body.badge);
      const busy = options.store.state.guides.find(guide => guide.gameId === game.id
        && normalizeKey(guide.badge) === normalizeKey(badge) && busyStatuses.has(guide.status));
      if (busy) return options.sendJson(res, 409, { error: 'Wait for this guide to finish before removing its approved video.' });
      const result = removePinnedGuide(options.catalogPath, game.id, badge);
      options.audit.append('DAD_PIN_REMOVED', {
        game: game.name, badge: result.pin.badge, client: normalizeAddress(req.socket.remoteAddress),
        url: result.pin.url, reason: 'Removed manually approved video'
      });
      options.sendJson(res, 200, {
        message: `Removed the approved video for ${result.pin.badge}.`, ...state()
      });
      return true;
    }
    const requestMatch = pathname.match(/^\/dad\/api\/requests\/([0-9a-f-]{36})$/i);
    if (req.method === 'DELETE' && requestMatch) {
      if (rejectMutation(req, res, 'Guide removal')) return true;
      const guide = options.store.state.guides.find(item => item.id === requestMatch[1]);
      if (!guide) return options.sendJson(res, 404, { error: 'That guide entry no longer exists.' });
      if (busyStatuses.has(guide.status)) {
        return options.sendJson(res, 409, { error: 'Wait for the current guide work to finish before removing it.' });
      }
      const removedVideo = removeGuideFile(guide);
      options.store.remove(guide.id);
      options.audit.append('DAD_REQUEST_REMOVED', {
        game: guide.game, badge: guide.badge, client: normalizeAddress(req.socket.remoteAddress),
        video: guide.sourceTitle || guide.status,
        reason: removedVideo ? 'Removed library entry and managed video file' : 'Removed library entry'
      });
      options.sendJson(res, 200, { message: `Removed ${guide.badge} from the library.`, ...state() });
      return true;
    }
    if (req.method === 'POST' && requestMatch) {
      await updateRequest(req, res, requestMatch[1]);
      return true;
    }
    return false;
  }

  return { handle, state };
}

module.exports = { createAdminController };
