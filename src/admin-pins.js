'use strict';

const fs = require('fs');
const { loadCatalog, removePinnedGuide, upsertPinnedGuide } = require('./catalog');
const { validatePinnedGuide } = require('./discovery');
const { normalizeAddress } = require('./network');
const { normalizeKey, validateGuideName } = require('./safety');

function createPinHandler(options, { rejectMutation, state, busyStatuses, queueApprovedGuide }) {
  return async function handlePins(req, res, pathname) {
    if (pathname !== '/dad/api/pins' || !['POST', 'PATCH', 'DELETE'].includes(req.method)) return false;
    if (rejectMutation(req, res, 'Guide approval')) return true;
    const body = await options.readJson(req);
    const before = fs.readFileSync(options.catalogPath, 'utf8');
    const games = loadCatalog(options.catalogPath);
    const game = games.find(item => item.id === String(body.gameId || ''));
    if (!game) return options.sendJson(res, 400, { error: 'Please choose an approved game.' });
    const badge = validateGuideName(body.guide ?? body.badge);
    const key = `${game.id}:${normalizeKey(badge)}`;
    const previousGame = req.method === 'PATCH' ? games.find(item => item.id === body.previousGameId) : game;
    const previousPin = req.method === 'PATCH'
      ? Object.values(previousGame?.pinned || {}).find(pin => pin.id === body.pinId)
      : game.pinned[normalizeKey(badge)];
    if (req.method === 'PATCH' && !previousPin) return options.sendJson(res, 404, { error: 'That pre-approved guide no longer exists.' });
    const previousKey = previousPin ? `${previousGame.id}:${normalizeKey(previousPin.badge)}` : key;
    const request = body.requestId ? options.store.state.guides.find(item => item.id === body.requestId) : null;
    if (body.requestId && (!request || request.gameId !== game.id)) {
      return options.sendJson(res, 409, { error: 'That guide request changed. Refresh the page and try again.' });
    }
    const related = options.store.state.guides.filter(guide => guide.key === previousKey || guide.id === request?.id);
    const affected = options.store.state.guides.filter(guide => guide.key === key || related.includes(guide));
    if (affected.some(guide => busyStatuses.has(guide.status))) {
      return options.sendJson(res, 409, { error: 'Wait for the current guide work to finish before changing its approval.' });
    }
    if (req.method === 'DELETE') {
      const result = removePinnedGuide(options.catalogPath, game.id, badge);
      options.audit.append('DAD_PIN_REMOVED', {
        game: game.name, badge: result.pin.badge, client: normalizeAddress(req.socket.remoteAddress),
        url: result.pin.url, reason: 'Removed manually approved video'
      });
      options.sendJson(res, 200, { message: `Removed ${badge} from the pre-approved list.`, ...state() });
      return true;
    }
    if (body.download !== undefined && typeof body.download !== 'boolean') throw new Error('Choose whether to download the approved guide.');
    if ((req.method === 'PATCH' || request) && affected.some(guide => guide.key === key && !related.includes(guide))) {
      return options.sendJson(res, 409, { error: 'That guide already has a library entry. Edit that entry instead.' });
    }
    const snapshot = JSON.stringify(affected);
    const selected = await (options.validatePinnedGuide || validatePinnedGuide)(body.url);
    // Metadata checks await external tools. Reject stale edits instead of resurrecting
    // removed games, overwriting another edit, or changing a job that started meanwhile.
    const current = options.store.state.guides.filter(guide => guide.key === key || guide.key === previousKey || guide.id === request?.id);
    if (fs.readFileSync(options.catalogPath, 'utf8') !== before || JSON.stringify(current) !== snapshot) {
      return options.sendJson(res, 409, { error: 'This guide changed while the video was checked. Refresh and try again.' });
    }
    const result = upsertPinnedGuide(options.catalogPath, game.id, badge, selected.webpageUrl,
      req.method === 'PATCH' ? { gameId: previousGame.id, id: previousPin.id } : null);
    // Keep the IDs and playable files of related library entries when correcting a pin.
    for (const guide of related) {
      Object.assign(guide, { gameId: game.id, game: game.name, platform: game.platform, badge, key });
      if (guide.approvedSelection) guide.approvedSelection.canonicalBadge = badge;
    }
    if (related.length) options.store.save();
    const download = body.download !== false;
    const client = normalizeAddress(req.socket.remoteAddress);
    if (download) queueApprovedGuide(options, game, badge, selected, client);
    options.audit.append(result.replaced ? 'DAD_PIN_REPLACED' : 'DAD_PIN_ADDED', {
      game: game.name, badge, client, video: selected.title, url: selected.webpageUrl,
      reason: download ? 'Approved URL and queued library download' : 'Added to the pre-approved guide list'
    });
    options.sendJson(res, result.replaced ? 200 : 201, {
      message: download ? `Approved ${badge}. The video is downloading now.` : `Saved ${badge} to the pre-approved list.`,
      pin: { gameId: game.id, id: result.id, badge, url: selected.webpageUrl, title: selected.title }, ...state()
    });
    return true;
  };
}

module.exports = { createPinHandler };
