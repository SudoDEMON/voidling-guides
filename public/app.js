'use strict';

const form = document.querySelector('#requestForm');
const gameSelect = document.querySelector('#gameId');
const badgeInput = document.querySelector('#badge');
const requestButton = document.querySelector('#requestButton');
const formMessage = document.querySelector('#formMessage');
const gameRequestForm = document.querySelector('#gameRequestForm');
const requestedPlatform = document.querySelector('#requestedPlatform');
const requestedGame = document.querySelector('#requestedGame');
const gameRequestButton = document.querySelector('#gameRequestButton');
const gameRequestMessage = document.querySelector('#gameRequestMessage');
const guideGrid = document.querySelector('#guideGrid');
const refreshButton = document.querySelector('#refreshButton');
const serverPill = document.querySelector('#serverPill');
const serverStatus = document.querySelector('#serverStatus');
const mascot = document.querySelector('#mascot');
const mascotCanvas = document.querySelector('#mascotCanvas');
let lastGuideJson = '';
let mascotStarted = false;

function startMascot(url) {
  if (!url || mascotStarted || !mascotCanvas) return;
  mascotStarted = true;
  const context = mascotCanvas.getContext('2d');
  const sheet = new Image();
  const frames = [0, 1, 2, 3, 2, 1, 0, 0, 4, 5, 4, 0];
  let index = 0;
  let previous = 0;
  sheet.onload = () => {
    mascot.hidden = false;
    const draw = timestamp => {
      if (timestamp - previous >= 230) {
        previous = timestamp;
        context.clearRect(0, 0, 192, 208);
        context.drawImage(sheet, frames[index] * 192, 6 * 208, 192, 208, 0, 0, 192, 208);
        index = (index + 1) % frames.length;
      }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  };
  sheet.src = url;
}

function setMessage(message, type = '') {
  formMessage.textContent = message;
  formMessage.className = `form-message ${type}`.trim();
}

function setGameRequestMessage(message, type = '') {
  gameRequestMessage.textContent = message;
  gameRequestMessage.className = `form-message ${type}`.trim();
}

function formatDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(value / 60);
  const remainder = String(value % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

function formatSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function makeText(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

async function answerClarification(guide, accept, buttons) {
  for (const button of buttons) button.disabled = true;
  setMessage(accept ? `Okay—getting the ${guide.suggestedBadge} guide...` : 'Okay—nothing will be downloaded.');
  try {
    const response = await fetch(`/api/guides/${encodeURIComponent(guide.id)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not save that answer.');
    setMessage(
      accept ? `${guide.suggestedBadge} confirmed! The guide is on its way.` : 'Thanks! Ask Dad to approve a video if you still need this guide.',
      'success'
    );
    await loadGuides();
  } catch (error) {
    setMessage(error.message, 'error');
    for (const button of buttons) button.disabled = false;
  }
}

function renderGuide(guide) {
  const card = document.createElement('article');
  card.className = `guide-card status-${guide.status}`;
  if (guide.status === 'complete' && guide.mediaUrl) {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = guide.mediaUrl;
    card.append(video);
  }
  const body = document.createElement('div');
  body.className = 'guide-body';
  body.append(makeText('p', 'guide-game', `${guide.platform} · ${guide.game}`));
  body.append(makeText('h3', '', guide.badge));
  if (guide.sourceTitle) {
    const detail = guide.status === 'complete'
      ? `${guide.sourceTitle} · ${guide.channel || 'YouTube'} · ${formatDuration(guide.duration)} · ${formatSize(guide.size)}`
      : `${guide.sourceTitle}${guide.channel ? ` · ${guide.channel}` : ''}`;
    body.append(makeText('p', 'guide-source', detail));
  }
  const status = document.createElement('div');
  status.className = 'status-line';
  status.append(makeText('span', 'status-dot', ''));
  status.append(makeText('span', '', guide.message || guide.status));
  body.append(status);
  if (guide.status === 'needs_confirmation' && guide.suggestedBadge) {
    const actions = document.createElement('div');
    actions.className = 'confirmation-actions';
    const yes = makeText('button', 'confirm-button', `Yes, ${guide.suggestedBadge}`);
    const no = makeText('button', 'decline-button', 'No, that is different');
    yes.type = 'button';
    no.type = 'button';
    const buttons = [yes, no];
    yes.addEventListener('click', () => answerClarification(guide, true, buttons));
    no.addEventListener('click', () => answerClarification(guide, false, buttons));
    actions.append(yes, no);
    body.append(actions);
  }
  card.append(body);
  return card;
}

function renderGuides(guides) {
  const signature = JSON.stringify(guides);
  if (signature === lastGuideJson) return;
  lastGuideJson = signature;
  guideGrid.replaceChildren();
  if (guides.length === 0) {
    guideGrid.append(makeText('div', 'empty-card', 'No guides yet. Request one above!'));
    return;
  }
  for (const guide of guides) guideGrid.append(renderGuide(guide));
}

async function loadGames() {
  const response = await fetch('/api/games', { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not load approved games.');
  const selected = gameSelect.value;
  gameSelect.replaceChildren();
  if (body.games.length === 0) {
    const option = document.createElement('option');
    option.textContent = 'No approved games yet';
    option.disabled = true;
    option.selected = true;
    gameSelect.append(option);
    requestButton.disabled = true;
    return;
  }
  for (const game of body.games) {
    const option = document.createElement('option');
    option.value = game.id;
    option.textContent = `${game.platform}: ${game.name}`;
    gameSelect.append(option);
  }
  if ([...gameSelect.options].some(option => option.value === selected)) gameSelect.value = selected;
  requestButton.disabled = false;
}

async function loadGuides() {
  const response = await fetch('/api/guides', { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not load guides.');
  renderGuides(body.guides);
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error('A guide tool is missing');
    serverPill.className = 'server-pill ready';
    serverStatus.textContent = 'Guide server ready';
    startMascot(body.mascotUrl);
  } catch (error) {
    serverPill.className = 'server-pill error';
    serverStatus.textContent = error.message;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  requestButton.disabled = true;
  setMessage('Sending your request...');
  try {
    const response = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: gameSelect.value, badge: badgeInput.value })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not request that guide.');
    badgeInput.value = '';
    setMessage(body.duplicate ? 'That guide is already in the library or on the way.' : 'Request added! You can watch it here when it is ready.', 'success');
    await loadGuides();
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    requestButton.disabled = false;
  }
});

gameRequestForm.addEventListener('submit', async event => {
  event.preventDefault();
  gameRequestButton.disabled = true;
  setGameRequestMessage('Sending the game request to Dad...');
  try {
    const response = await fetch('/api/game-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: requestedPlatform.value, name: requestedGame.value })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not request that game.');
    requestedGame.value = '';
    setGameRequestMessage(
      body.duplicate ? 'Dad already has this game request.' : 'Request sent! Dad can approve it from his page.',
      'success'
    );
  } catch (error) {
    setGameRequestMessage(error.message, 'error');
  } finally {
    gameRequestButton.disabled = false;
  }
});

refreshButton.addEventListener('click', () => loadGuides().catch(error => setMessage(error.message, 'error')));

Promise.all([checkHealth(), loadGames(), loadGuides()]).catch(error => setMessage(error.message, 'error'));
setInterval(() => loadGuides().catch(() => {}), 2500);
setInterval(() => loadGames().catch(() => {}), 10_000);
