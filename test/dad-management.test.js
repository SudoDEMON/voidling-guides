'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { dadFixture } = require('../test-support/dad-fixture');
const { loadCatalog, loadPlatforms, addApprovedGame, updateApprovedGame, updatePlatform } = require('../src/catalog');
const { LibraryStore } = require('../src/store');

async function fixture(t, options) {
  const context = await dadFixture(options);
  t.after(() => context.close());
  return context;
}

const validUrl = 'https://youtu.be/SaPy5eZrv34';

test('game/platform edits retain legacy identities, pins, media, and persisted related labels', async t => {
  const f = await fixture(t);
  const pinId = f.game.pinned['old guide'].id;
  const platform = loadPlatforms(f.catalogPath)[0];
  let result = await f.api(`/dad/api/games/${f.game.id}`, 'PATCH', { platform: 'Roblox', name: 'Test Game' });
  assert.equal(result.status, 200);
  assert.equal(result.body.games[0].id, f.game.id);
  assert.equal(result.body.requests[0].game, 'Test Game');
  assert.equal(f.guide.filePath.endsWith('original.webm'), true);
  assert.equal(fs.readFileSync(f.guide.filePath, 'utf8'), 'fixture webm');
  result = await f.api(`/dad/api/platforms/${platform.id}`, 'PATCH', { name: 'ROBLOX Studio' });
  assert.equal(result.status, 200);
  assert.equal(result.body.platforms[0].id, platform.id);
  assert.equal(result.body.games[0].id, f.game.id);
  assert.equal(result.body.games[0].pins[0].id, pinId);
  assert.equal(result.body.requests[0].platform, 'ROBLOX Studio');
  const reloaded = new LibraryStore(f.store.filePath);
  reloaded.load();
  assert.equal(reloaded.state.guides[0].id, f.guide.id);
  assert.equal(reloaded.state.guides[0].gameId, f.game.id);
  assert.equal(reloaded.state.guides[0].platform, 'ROBLOX Studio');
  assert.equal(loadCatalog(f.catalogPath)[0].id, f.game.id);
  assert.match(fs.readFileSync(f.catalogPath, 'utf8'), /Keep this catalog note/);
  assert.match(f.audit.guideHistory().entries.join('\n'), /Test Gmae - Old Guide/);
  assert.deepEqual(f.errors, []);
});

test('new names do not recycle renamed game IDs and duplicates/invalid labels are rejected atomically', async t => {
  const f = await fixture(t);
  updateApprovedGame(f.catalogPath, f.game.id, 'Roblox', 'Corrected Game');
  const other = addApprovedGame(f.catalogPath, 'Roblox', 'Test Gmae');
  assert.notEqual(other.id, f.game.id);
  const before = fs.readFileSync(f.catalogPath, 'utf8');
  for (const body of [
    { platform: 'Roblox', name: 'TEST GMAE' }, { platform: 'Missing', name: 'Valid Name' },
    { platform: 'Roblox', name: '<script>' }, { platform: 'Roblox', name: 'x' }
  ]) {
    assert.equal((await f.api(`/dad/api/games/${f.game.id}`, 'PATCH', body)).status, 400);
    assert.equal(fs.readFileSync(f.catalogPath, 'utf8'), before);
  }
  assert.equal((await f.api('/dad/api/platforms', 'POST', { name: 'rObLoX' })).status, 400);
  assert.equal((await f.api('/dad/api/platforms', 'POST', { name: 'Bad: Platform' })).status, 400);
});

test('platform CRUD supports empty platforms, blocks dependencies, and permits moving games', async t => {
  const f = await fixture(t);
  const old = loadPlatforms(f.catalogPath)[0];
  assert.equal((await f.api(`/dad/api/platforms/${old.id}`, 'DELETE', {})).status, 409);
  assert.equal(loadCatalog(f.catalogPath).length, 1);
  let result = await f.api('/dad/api/platforms', 'POST', { name: 'Desktop' });
  assert.equal(result.status, 201);
  const platform = result.body.platforms.find(item => item.name === 'Desktop');
  assert.equal((await f.api(`/dad/api/platforms/${platform.id}`, 'PATCH', { name: 'Roblox' })).status, 400);
  result = await f.api(`/dad/api/games/${f.game.id}`, 'PATCH', { platform: 'Desktop', name: 'Test Game' });
  assert.equal(result.status, 200);
  assert.equal(result.body.requests[0].platform, 'Desktop');
  assert.equal((await f.api(`/dad/api/platforms/${old.id}`, 'DELETE', {})).status, 200);
  assert.deepEqual(loadPlatforms(f.catalogPath), [platform]);
  assert.equal((await f.api(`/dad/api/games/${f.game.id}`, 'DELETE', {})).status, 409);
});

test('new mutations and history remain password protected and mutations enforce same-origin JSON', async t => {
  const f = await fixture(t);
  const platform = loadPlatforms(f.catalogPath)[0];
  const cases = [
    ['/dad/api/platforms', 'POST', { name: 'Desktop' }],
    [`/dad/api/platforms/${platform.id}`, 'PATCH', { name: 'Desktop' }],
    [`/dad/api/platforms/${platform.id}`, 'DELETE', {}],
    [`/dad/api/games/${f.game.id}`, 'PATCH', { name: 'Corrected', platform: 'Roblox' }],
    ['/dad/api/pins', 'PATCH', { gameId: f.game.id, guide: 'Guide', url: validUrl }]
  ];
  for (const [url, method, body] of cases) {
    assert.equal((await f.api(url, method, body, { cookie: '' })).status, 401);
    assert.equal((await f.api(url, method, body, { origin: 'https://example.com' })).status, 403);
    assert.equal((await f.api(url, method, body, { 'content-type': 'text/plain' })).status, 403);
  }
  assert.equal((await f.api('/dad/api/history', 'GET', undefined, { cookie: '' })).status, 401);
  assert.deepEqual((await f.api('/dad/api/state', 'GET', undefined, { cookie: '' })).body, { configured: true, authenticated: false });
});

test('game approval resolves pending state, keeps historical names and dates, and survives restart/cleanup', async t => {
  const f = await fixture(t);
  let result = await f.api(`/dad/api/game-requests/${f.request.id}`, 'POST', { decision: 'approve' });
  assert.equal(result.status, 200);
  assert.equal(result.body.gameRequests.filter(item => item.status === 'pending').length, 0);
  const record = result.body.gameRequests.find(item => item.id === f.request.id);
  assert.equal(record.status, 'approved');
  assert.equal(record.createdAt, '2026-01-01T00:00:00.000Z');
  const approved = result.body.games.find(item => item.name === 'Kid Game');
  await f.api(`/dad/api/games/${approved.id}`, 'PATCH', { name: 'Kid GAME', platform: 'Roblox' });
  result = await f.api(`/dad/api/game-requests/${f.request.id}`, 'POST', { decision: 'approve' });
  assert.equal(result.status, 409);
  const store = new LibraryStore(f.store.filePath, { now: () => Date.now() + 400 * 86400000 });
  store.load();
  store.cleanup();
  assert.equal(store.state.gameRequests[0].name, 'Kid Game');
  assert.equal(store.state.gameRequests[0].gameId, approved.id);
  assert.equal(store.state.gameRequests[0].status, 'approved');
  assert.match(f.audit.guideHistory().entries.join('\n'), /Old Guide/);
});

test('Pre-Approve adds a guide without downloading; editing preserves pin/library IDs and prevents duplicates', async t => {
  const f = await fixture(t);
  let result = await f.api('/dad/api/pins', 'POST', { gameId: f.game.id, guide: 'New Guide', url: validUrl, download: false });
  assert.equal(result.status, 201);
  assert.equal(result.body.games[0].pins.length, 2);
  assert.equal(f.store.state.guides.length, 1);
  assert.deepEqual(f.enqueued, []);
  const originalId = f.game.pinned['old guide'].id;
  const edit = { previousGameId: f.game.id, pinId: originalId, gameId: f.game.id, guide: 'Correct Guide', url: validUrl, download: false };
  result = await f.api('/dad/api/pins', 'PATCH', edit);
  assert.equal(result.status, 200);
  assert.equal(result.body.games[0].pins.find(pin => pin.badge === 'Correct Guide').id, originalId);
  assert.equal(result.body.games[0].pins.some(pin => pin.badge === 'Old Guide'), false);
  assert.equal(result.body.requests[0].id, f.guide.id);
  assert.equal(result.body.requests[0].badge, 'Correct Guide');
  assert.equal(fs.readFileSync(f.guide.filePath, 'utf8'), 'fixture webm');
  const before = fs.readFileSync(f.catalogPath, 'utf8');
  assert.equal((await f.api('/dad/api/pins', 'PATCH', { ...edit, guide: 'NEW GUIDE' })).status, 400);
  assert.equal((await f.api('/dad/api/pins', 'PATCH', { ...edit, url: 'javascript:alert(1)' })).status, 400);
  assert.equal(fs.readFileSync(f.catalogPath, 'utf8'), before);
  result = await f.api('/dad/api/pins', 'POST', { gameId: f.game.id, guide: 'Correct Guide', url: validUrl });
  assert.equal(result.status, 200);
  assert.deepEqual(f.enqueued, [f.guide.id]);
  assert.equal(f.guide.createdAt, '2026-01-01T00:00:00.000Z');
  assert.match(result.body.history.entries.join('\n'), /REQUESTED - Test Gmae - Old Guide/);
});

test('guide edits synchronize matching pre-approvals, keep stable IDs, and retain history after removal', async t => {
  const f = await fixture(t);
  const originalId = f.game.pinned['old guide'].id;
  let result = await f.api(`/dad/api/requests/${f.guide.id}`, 'POST', { gameId: f.game.id, guide: 'Correct Guide' });
  assert.equal(result.status, 200);
  assert.equal(result.body.requests[0].id, f.guide.id);
  assert.equal(result.body.games[0].pins[0].id, originalId);
  assert.equal(result.body.games[0].pins[0].badge, 'Correct Guide');
  const filePath = f.guide.filePath;
  result = await f.api(`/dad/api/requests/${f.guide.id}`, 'DELETE', {});
  assert.equal(result.status, 200);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(result.body.requests.length, 0);
  assert.match(result.body.history.entries.join('\n'), /REQUESTED - Test Gmae - Old Guide/);
  assert.match(result.body.history.entries.join('\n'), /DAD_REQUEST_REMOVED/);
  for (let i = 0; i < 40; i += 1) f.audit.append('REQUESTED', { game: 'Fixture', badge: `Guide ${i}` });
  for (let i = 0; i < 120; i += 1) f.audit.append('DAD_LOGIN', {});
  const page = (await f.api('/dad/api/history')).body;
  assert.equal(page.entries.length, 30);
  assert.equal(page.nextOffset, 30);
  const older = (await f.api('/dad/api/history?offset=30')).body;
  assert.match(older.entries.join('\n'), /Old Guide/);
  assert.equal(older.nextOffset, null);
});

test('approval can reuse a corrected pending guide without losing its request identity or log', async t => {
  const f = await fixture(t);
  f.store.update(f.guide.id, { status: 'needs_confirmation', suggestedBadge: 'Old Guide Extended' });
  const result = await f.api('/dad/api/pins', 'POST', {
    gameId: f.game.id, requestId: f.guide.id, guide: 'Old Guide Extended', url: validUrl, download: true
  });
  assert.equal(result.status, 201);
  assert.deepEqual(f.enqueued, [f.guide.id]);
  assert.equal(f.store.state.guides.length, 1);
  assert.equal(f.guide.badge, 'Old Guide Extended');
  assert.match(result.body.history.entries.join('\n'), /REQUESTED - Test Gmae - Old Guide/);
});

test('busy guide mutations fail without changing catalog or files', async t => {
  const f = await fixture(t);
  f.store.update(f.guide.id, { status: 'downloading' });
  const platform = loadPlatforms(f.catalogPath)[0];
  const before = fs.readFileSync(f.catalogPath, 'utf8');
  const cases = [
    [`/dad/api/games/${f.game.id}`, 'PATCH', { platform: 'Roblox', name: 'Changed Game' }],
    [`/dad/api/platforms/${platform.id}`, 'PATCH', { name: 'Changed Platform' }],
    ['/dad/api/pins', 'POST', { gameId: f.game.id, guide: 'Old Guide', url: validUrl, download: false }],
    [`/dad/api/requests/${f.guide.id}`, 'POST', { gameId: f.game.id, guide: 'Changed Guide' }]
  ];
  for (const [url, method, body] of cases) assert.equal((await f.api(url, method, body)).status, 409);
  assert.equal(fs.readFileSync(f.catalogPath, 'utf8'), before);
  assert.equal(fs.existsSync(f.guide.filePath), true);
});

test('asynchronous URL validation rejects a stale catalog edit', async t => {
  let release;
  let started;
  const validating = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { validatePinnedGuide: async () => {
    started();
    await new Promise(resolve => { release = resolve; });
    return { id: 'SaPy5eZrv34', title: 'Fixture', webpageUrl: 'https://www.youtube.com/watch?v=SaPy5eZrv34' };
  } });
  const pending = f.api('/dad/api/pins', 'POST', { gameId: f.game.id, guide: 'New Guide', url: validUrl, download: false });
  await validating;
  updatePlatform(f.catalogPath, loadPlatforms(f.catalogPath)[0].id, 'Roblox Studio');
  release();
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(loadCatalog(f.catalogPath)[0].pinned['new guide'], undefined);
  assert.deepEqual(f.enqueued, []);
  assert.equal(fs.existsSync(path.join(f.directory, 'request-log.md')), true);
});
