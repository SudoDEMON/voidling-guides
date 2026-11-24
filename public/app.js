import { el, jsonFetch, setMessage } from '/client-utils.js';

const form = document.querySelector('#requestForm');
const gameSelect = document.querySelector('#gameId');
const guideInput = document.querySelector('#guide');
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

const cardState = new Map();
let mascotStarted = false;
let guidesInFlight = false;
let gamesInFlight = false;
let sseOpen = false;

const MASCOT_FRAMES = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1];
const MASCOT_FRAME_WIDTH = 192;
const MASCOT_FRAME_HEIGHT = 208;
const MASCOT_ROW = 7;

function startMascot(url) {
  if (!url || mascotStarted || !mascotCanvas) return;
  mascotStarted = true;
  const context = mascotCanvas.getContext('2d');
  if (!context) return;
  const sheet = new Image();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let index = 0;
  let previous = 0;
  let rafId = 0;

  const paintFrame = frameIndex => {
    context.clearRect(0, 0, mascotCanvas.width, mascotCanvas.height);
    context.drawImage(
      sheet,
      MASCOT_FRAMES[frameIndex] * MASCOT_FRAME_WIDTH,
      MASCOT_ROW * MASCOT_FRAME_HEIGHT,
      MASCOT_FRAME_WIDTH,
      MASCOT_FRAME_HEIGHT,
      0,
      0,
      mascotCanvas.width,
      mascotCanvas.height
    );
  };

  const step = timestamp => {
    if (reducedMotion.matches) {
      rafId = 0;
      paintFrame(0);
      return;
    }
    if (timestamp - previous >= 180) {
      previous = timestamp;
      paintFrame(index);
      index = (index + 1) % MASCOT_FRAMES.length;
    }
    rafId = requestAnimationFrame(step);
  };

  sheet.onload = () => {
    mascotCanvas.width = MASCOT_FRAME_WIDTH;
    mascotCanvas.height = MASCOT_FRAME_HEIGHT;
    mascot.hidden = false;
    paintFrame(0);
    if (!reducedMotion.matches) rafId = requestAnimationFrame(step);
    reducedMotion.addEventListener('change', () => {
      if (reducedMotion.matches) {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        paintFrame(0);
      } else if (!rafId) {
        rafId = requestAnimationFrame(step);
      }
    });
  };
  sheet.onerror = () => {
    mascot.hidden = true;
  };
  sheet.src = url;
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

async function answerClarification(guide, accept, buttons) {
  for (const button of buttons) button.disabled = true;
  setMessage(
    formMessage,
    accept ? `Okay—getting the ${guide.suggestedGuide} guide...` : 'Okay—nothing will be downloaded.',
    'form-message'
  );
  try {
    await jsonFetch(`/api/guides/${encodeURIComponent(guide.id)}/confirmation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept })
    });
    setMessage(
      formMessage,
      accept ? `${guide.suggestedGuide} confirmed! The guide is on its way.` : 'Thanks! Ask Dad to approve a video if you still need this guide.',
      'form-message',
      'success'
    );
    await loadGuides();
  } catch (error) {
    setMessage(formMessage, error.message, 'form-message', 'error');
    for (const button of buttons) button.disabled = false;
  }
}

function populateCardBody(body, guide) {
  body.replaceChildren();
  body.append(el('p', 'guide-game', `${guide.platform} · ${guide.game}`));
  body.append(el('h3', '', guide.guide));
  if (guide.sourceTitle) {
    const detail = guide.status === 'complete'
      ? `${guide.sourceTitle} · ${guide.channel || 'YouTube'} · ${formatDuration(guide.duration)} · ${formatSize(guide.size)}`
      : `${guide.sourceTitle}${guide.channel ? ` · ${guide.channel}` : ''}`;
    body.append(el('p', 'guide-source', detail));
  }
  const status = el('div', 'status-line');
  status.append(el('span', 'status-dot'), el('span', '', guide.message || guide.status));
  body.append(status);
  if (guide.status === 'needs_confirmation' && guide.suggestedGuide) {
    const actions = el('div', 'confirmation-actions');
    const yes = el('button', '', `Yes, ${guide.suggestedGuide}`);
    const no = el('button', 'decline-button', 'No, that is different');
    yes.type = 'button';
    no.type = 'button';
    const buttons = [yes, no];
    yes.addEventListener('click', () => answerClarification(guide, true, buttons));
    no.addEventListener('click', () => answerClarification(guide, false, buttons));
    actions.append(yes, no);
    body.append(actions);
  }
}

function createGuideEntry(guide) {
  const card = document.createElement('article');
  card.className = `guide-card status-${guide.status}`;
  const body = el('div', 'guide-body');
  let video = null;
  if (guide.status === 'complete' && guide.mediaUrl) {
    video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = guide.mediaUrl;
    card.append(video);
  }
  populateCardBody(body, guide);
  card.append(body);
  return { card, body, video, mediaUrl: guide.mediaUrl || null, signature: JSON.stringify(guide) };
}

function updateGuideEntry(entry, guide) {
  const nextSignature = JSON.stringify(guide);
  if (entry.signature === nextSignature) return;
  entry.signature = nextSignature;
  entry.card.className = `guide-card status-${guide.status}`;
  const nextMediaUrl = guide.status === 'complete' ? (guide.mediaUrl || null) : null;
  if (nextMediaUrl !== entry.mediaUrl) {
    if (entry.video) {
      entry.video.remove();
      entry.video = null;
    }
    if (nextMediaUrl) {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.src = nextMediaUrl;
      entry.card.prepend(video);
      entry.video = video;
    }
    entry.mediaUrl = nextMediaUrl;
  }
  populateCardBody(entry.body, guide);
}

function renderGuides(guides) {
  if (guides.length === 0) {
    cardState.clear();
    guideGrid.replaceChildren(el('div', 'empty-card', 'No guides yet. Request one above!'));
    return;
  }
  const emptyCard = guideGrid.querySelector('.empty-card');
  if (emptyCard) emptyCard.remove();

  const seen = new Set();
  for (const guide of guides) {
    seen.add(guide.id);
    let entry = cardState.get(guide.id);
    if (!entry) {
      entry = createGuideEntry(guide);
      cardState.set(guide.id, entry);
    } else {
      updateGuideEntry(entry, guide);
    }
  }
  for (const [id, entry] of cardState) {
    if (!seen.has(id)) {
      entry.card.remove();
      cardState.delete(id);
    }
  }
  for (let index = 0; index < guides.length; index += 1) {
    const targetCard = cardState.get(guides[index].id).card;
    const currentAtSlot = guideGrid.children[index];
    if (currentAtSlot !== targetCard) {
      guideGrid.insertBefore(targetCard, currentAtSlot || null);
    }
  }
}

async function loadGames() {
  if (gamesInFlight) return;
  gamesInFlight = true;
  try {
    const body = await jsonFetch('/api/games');
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
  } finally {
    gamesInFlight = false;
  }
}

async function loadGuides() {
  if (guidesInFlight) return;
  guidesInFlight = true;
  try {
    const body = await jsonFetch('/api/guides');
    renderGuides(body.guides);
  } finally {
    guidesInFlight = false;
  }
}

async function checkHealth() {
  try {
    const body = await jsonFetch('/api/health');
    if (!body.ok) throw new Error('A guide tool is missing');
    serverPill.className = 'server-pill ready';
    serverStatus.textContent = 'Guide server ready';
    startMascot(body.mascotUrl);
  } catch (error) {
    serverPill.className = 'server-pill error';
    serverStatus.textContent = error.message;
  }
}

function connectEvents() {
  if (typeof EventSource !== 'function') return;
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => { sseOpen = true; });
  source.addEventListener('error', () => { sseOpen = false; });
  source.addEventListener('guides', () => { loadGuides().catch(() => {}); });
  source.addEventListener('games', () => { loadGames().catch(() => {}); });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  requestButton.disabled = true;
  setMessage(formMessage, 'Sending your request...', 'form-message');
  try {
    const body = await jsonFetch('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: gameSelect.value, guide: guideInput.value })
    });
    guideInput.value = '';
    setMessage(
      formMessage,
      body.duplicate ? 'That guide is already in the library or on the way.' : 'Request added! You can watch it here when it is ready.',
      'form-message',
      'success'
    );
    await loadGuides();
  } catch (error) {
    setMessage(formMessage, error.message, 'form-message', 'error');
  } finally {
    requestButton.disabled = gameSelect.options.length === 0 || gameSelect.options[0]?.disabled;
  }
});

gameRequestForm.addEventListener('submit', async event => {
  event.preventDefault();
  gameRequestButton.disabled = true;
  setMessage(gameRequestMessage, 'Sending the game request to Dad...', 'form-message');
  try {
    const body = await jsonFetch('/api/game-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: requestedPlatform.value, name: requestedGame.value })
    });
    requestedGame.value = '';
    setMessage(
      gameRequestMessage,
      body.duplicate ? 'Dad already has this game request.' : 'Request sent! Dad can approve it from his page.',
      'form-message',
      'success'
    );
  } catch (error) {
    setMessage(gameRequestMessage, error.message, 'form-message', 'error');
  } finally {
    gameRequestButton.disabled = false;
  }
});

refreshButton.addEventListener('click', () => loadGuides().catch(error => setMessage(formMessage, error.message, 'form-message', 'error')));

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    loadGuides().catch(() => {});
    loadGames().catch(() => {});
  }
});

Promise.all([checkHealth(), loadGames(), loadGuides()]).catch(error => setMessage(formMessage, error.message, 'form-message', 'error'));
connectEvents();
setInterval(() => {
  if (document.hidden || sseOpen) return;
  loadGuides().catch(() => {});
  loadGames().catch(() => {});
}, 15_000);
