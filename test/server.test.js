'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const { writePassword } = require('../src/admin-auth');
const { parseCatalog } = require('../src/catalog');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* server is starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start: ${url}`);
}

function lanIpv4Address() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    const address = (addresses || []).find(item => item.family === 'IPv4' && !item.internal);
    if (address) return address.address;
  }
  throw new Error('The LAN Dad portal integration test requires a non-loopback IPv4 address.');
}

test('LAN server exposes only narrow static and API routes', async t => {
  const root = path.resolve(__dirname, '..');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'voidling-server-test-'));
  const dataRoot = path.join(scratch, 'data');
  const catalogPath = path.join(scratch, 'approved-guides.md');
  const catalogText = '# Approved\n\n## Roblox: Become Tiky and Everything Else Again\n\n- [Verity](https://youtu.be/SaPy5eZrv34)\n';
  fs.writeFileSync(catalogPath, catalogText);
  const approvedGame = parseCatalog(catalogText)[0];
  const confirmationId = '11111111-1111-4111-8111-111111111111';
  const completeId = '22222222-2222-4222-8222-222222222222';
  const declineGameRequestId = '33333333-3333-4333-8333-333333333333';
  const recentCompletedAt = new Date().toISOString();
  const recentCreatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const completeFile = path.join(dataRoot, 'videos', 'sans.webm');
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(path.dirname(completeFile), { recursive: true });
  fs.writeFileSync(completeFile, 'test video');
  fs.writeFileSync(path.join(dataRoot, 'library.json'), `${JSON.stringify({
    version: 1,
    gameRequests: [{
      id: declineGameRequestId, key: 'roblox:decline-me', platform: 'Roblox',
      name: 'Decline Me', status: 'pending', createdAt: '2026-07-22T00:30:00.000Z',
      requestClient: '127.0.0.1'
    }],
    guides: [{
      id: confirmationId,
      key: `${approvedGame.id}:sans-pending`,
      gameId: approvedGame.id, game: approvedGame.name, platform: approvedGame.platform,
      badge: 'Sans', status: 'needs_confirmation', message: 'Did you mean “Sans Skeleton”?',
      suggestedBadge: 'Sans Skeleton', sourceTitle: 'A Sans Skeleton guide', channel: 'Guide Maker',
      createdAt: '2026-07-22T02:00:00.000Z', requestClient: '127.0.0.1',
      pendingSelection: {
        id: '-Uvo203Bd2I', title: 'A Sans Skeleton guide', channel: 'Guide Maker',
        webpageUrl: 'https://www.youtube.com/watch?v=-Uvo203Bd2I', canonicalBadge: 'Sans Skeleton',
        antigravityResponse: 'SELECT|SAFE|EXACT|-Uvo203Bd2I|Sans Skeleton|Exact guide.'
      }
    }, {
      id: completeId, key: `${approvedGame.id}:sans`, gameId: approvedGame.id,
      game: approvedGame.name, platform: approvedGame.platform, badge: 'Sans',
      status: 'complete', message: 'Ready to watch!', sourceTitle: 'Existing Sans guide',
      channel: 'Guide Maker', createdAt: recentCreatedAt,
      completedAt: recentCompletedAt, filePath: completeFile, requestClient: '127.0.0.1'
    }]
  }, null, 2)}\n`);
  writePassword(path.join(dataRoot, 'admin-auth.json'), 'correct horse battery staple');
  const port = await freePort();
  const lanAddress = lanIpv4Address();
  const dadOrigin = `http://${lanAddress}:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      VOIDLING_HOST: '0.0.0.0',
      VOIDLING_PORT: String(port),
      VOIDLING_ALLOWED_CLIENTS: `127.0.0.1,${lanAddress}`,
      VOIDLING_DATA_ROOT: dataRoot,
      VOIDLING_CATALOG_PATH: catalogPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  await waitFor(`http://127.0.0.1:${port}/api/games`);

  const gamesResponse = await fetch(`http://127.0.0.1:${port}/api/games`);
  const games = await gamesResponse.json();
  assert.equal(games.games[0].name, 'Become Tiky and Everything Else Again');

  const kidGameRequest = await fetch(`http://127.0.0.1:${port}/api/game-requests`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'Roblox', name: 'Kid Requested Game' })
  });
  const kidGameRequestBody = await kidGameRequest.json();
  assert.equal(kidGameRequest.status, 201);
  assert.equal(kidGameRequestBody.request.name, 'Kid Requested Game');
  assert.equal(Object.hasOwn(kidGameRequestBody.request, 'requestClient'), false);
  assert.equal(Object.hasOwn(kidGameRequestBody.request, 'key'), false);

  const duplicateGameRequest = await fetch(`http://127.0.0.1:${port}/api/game-requests`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'Roblox', name: 'Kid Requested Game' })
  }).then(response => response.json());
  assert.equal(duplicateGameRequest.duplicate, true);

  const index = await fetch(`http://127.0.0.1:${port}/`);
  const indexBody = await index.text();
  assert.match(indexBody, /Voidling Guides/);
  assert.match(indexBody, /What guide are you looking for/);
  assert.match(indexBody, /id="guide"/);
  assert.match(indexBody, /href="\/"/);
  assert.doesNotMatch(indexBody, /(?:127\.0\.0\.1|localhost):\d+/);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);

  const browserScript = await fetch(`http://127.0.0.1:${port}/app.js`).then(response => response.text());
  assert.doesNotMatch(browserScript, /(?:127\.0\.0\.1|localhost):\d+/);
  assert.match(browserScript, /fetch\('\/api\/games'/);
  assert.match(browserScript, /guide: guideInput\.value/);

  const dadPage = await fetch(`${dadOrigin}/dad`);
  assert.equal(dadPage.status, 200);
  const dadPageBody = await dadPage.text();
  assert.match(dadPageBody, /Dad Approval/);
  assert.match(dadPageBody, /id="approvedGameList"/);
  assert.match(dadPageBody, /permanently deletes its downloaded WebM file/);
  const dadScript = await fetch(`${dadOrigin}/dad/app.js`).then(response => response.text());
  assert.match(dadScript, /method: 'DELETE'/);
  assert.match(dadScript, /Remove entry & video/);
  const dadState = await fetch(`${dadOrigin}/dad/api/state`).then(response => response.json());
  assert.deepEqual(dadState, { configured: true, authenticated: false });

  const badOrigin = await fetch(`${dadOrigin}/dad/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://example.com' },
    body: JSON.stringify({ password: 'correct horse battery staple' })
  });
  assert.equal(badOrigin.status, 403);

  const origin = dadOrigin;
  const login = await fetch(`${origin}/dad/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ password: 'correct horse battery staple' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly.*SameSite=Strict.*Path=\/dad/);
  const unlocked = await fetch(`${origin}/dad/api/state`, { headers: { cookie } }).then(response => response.json());
  assert.equal(unlocked.authenticated, true);
  assert.equal(unlocked.games[0].name, 'Become Tiky and Everything Else Again');
  assert.equal(unlocked.requests.find(request => request.id === confirmationId).suggestedBadge, 'Sans Skeleton');
  assert.equal(unlocked.gameRequests.some(request => request.name === 'Kid Requested Game'), true);
  assert.equal(Array.isArray(unlocked.log), true);

  const unauthenticatedDelete = await fetch(`${origin}/dad/api/pins`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ gameId: approvedGame.id, guide: 'Verity' })
  });
  assert.equal(unauthenticatedDelete.status, 401);

  const pendingKidRequest = unlocked.gameRequests.find(request => request.name === 'Kid Requested Game');
  const approveGameRequest = await fetch(`${origin}/dad/api/game-requests/${pendingKidRequest.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ decision: 'approve' })
  });
  const approvedGameState = await approveGameRequest.json();
  assert.equal(approveGameRequest.status, 200);
  assert.equal(approvedGameState.games.some(game => game.name === 'Kid Requested Game'), true);
  assert.equal(approvedGameState.gameRequests.find(request => request.id === pendingKidRequest.id).status, 'approved');

  const declineGameRequest = await fetch(`${origin}/dad/api/game-requests/${declineGameRequestId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ decision: 'decline' })
  });
  const declinedGameState = await declineGameRequest.json();
  assert.equal(declineGameRequest.status, 200);
  assert.equal(declinedGameState.gameRequests.find(request => request.id === declineGameRequestId).status, 'declined');

  const addGame = await fetch(`${origin}/dad/api/games`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ platform: 'Roblox', name: 'A Newly Approved Game' })
  });
  const addedState = await addGame.json();
  assert.equal(addGame.status, 201);
  assert.equal(addedState.games.some(game => game.name === 'A Newly Approved Game'), true);
  assert.match(fs.readFileSync(catalogPath, 'utf8'), /## Roblox: A Newly Approved Game/);

  const blockedGameRemoval = await fetch(`${origin}/dad/api/games/${encodeURIComponent(approvedGame.id)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin, cookie }, body: '{}'
  });
  assert.equal(blockedGameRemoval.status, 409);

  const removeAddedGame = await fetch(`${origin}/dad/api/games/${encodeURIComponent(addedState.game.id)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin, cookie }, body: '{}'
  });
  const removedGameState = await removeAddedGame.json();
  assert.equal(removeAddedGame.status, 200);
  assert.equal(removedGameState.games.some(game => game.name === 'A Newly Approved Game'), false);

  const removePin = await fetch(`${origin}/dad/api/pins`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ gameId: approvedGame.id, guide: 'Verity' })
  });
  const removedPinState = await removePin.json();
  assert.equal(removePin.status, 200);
  assert.equal(removedPinState.games[0].pins.length, 0);

  const editRequest = await fetch(`${origin}/dad/api/requests/${completeId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ gameId: approvedGame.id, guide: 'Sans Skeleton' })
  });
  const editedState = await editRequest.json();
  assert.equal(editRequest.status, 200, JSON.stringify(editedState));
  assert.equal(editedState.requests.find(request => request.id === completeId).badge, 'Sans Skeleton');

  const removeGuide = await fetch(`${origin}/dad/api/requests/${completeId}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin, cookie }, body: '{}'
  });
  const removedGuideState = await removeGuide.json();
  assert.equal(removeGuide.status, 200);
  assert.equal(removedGuideState.requests.some(request => request.id === completeId), false);
  assert.equal(fs.existsSync(completeFile), false);

  const removeApprovedGameRequest = await fetch(`${origin}/dad/api/game-requests/${pendingKidRequest.id}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin, cookie }, body: '{}'
  });
  assert.equal(removeApprovedGameRequest.status, 200);

  const invalidPin = await fetch(`${origin}/dad/api/pins`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie },
    body: JSON.stringify({ gameId: unlocked.games[0].id, guide: 'Test Guide', url: 'https://example.com/video' })
  });
  assert.equal(invalidPin.status, 400);

  const traversal = await fetch(`http://127.0.0.1:${port}/server.js`);
  assert.equal(traversal.status, 404);
  const arbitrary = await fetch(`http://127.0.0.1:${port}/media/00000000-0000-0000-0000-000000000000`);
  assert.equal(arbitrary.status, 404);

  const listed = await fetch(`http://127.0.0.1:${port}/api/guides`).then(response => response.json());
  const pendingGuide = listed.guides.find(guide => guide.id === confirmationId);
  assert.equal(pendingGuide.suggestedBadge, 'Sans Skeleton');
  assert.equal(Object.hasOwn(pendingGuide, 'pendingSelection'), false);

  const declinedResponse = await fetch(`http://127.0.0.1:${port}/api/guides/${confirmationId}/confirmation`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept: false })
  });
  const declined = await declinedResponse.json();
  assert.equal(declinedResponse.status, 200);
  assert.equal(declined.guide.status, 'failed');
  assert.equal(declined.guide.suggestedBadge, null);

  const removeFailedGuide = await fetch(`${origin}/dad/api/requests/${confirmationId}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin, cookie }, body: '{}'
  });
  assert.equal(removeFailedGuide.status, 200);

  const removeOriginalGame = await fetch(`${origin}/dad/api/games/${encodeURIComponent(approvedGame.id)}`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', origin, cookie }, body: '{}'
  });
  const finalState = await removeOriginalGame.json();
  assert.equal(removeOriginalGame.status, 200);
  assert.equal(finalState.games.some(game => game.id === approvedGame.id), false);

  const requestLog = fs.readFileSync(path.join(dataRoot, 'request-log.md'), 'utf8');
  assert.match(requestLog, /DECLINED.*Sans Skeleton/);
  assert.match(requestLog, /DAD_PIN_REMOVED/);
  assert.match(requestLog, /DAD_REQUEST_REMOVED/);
  assert.match(requestLog, /DAD_GAME_REMOVED/);
});
