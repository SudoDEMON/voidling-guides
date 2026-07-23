'use strict';

const loginPanel = document.querySelector('#loginPanel');
const loginForm = document.querySelector('#loginForm');
const loginHelp = document.querySelector('#loginHelp');
const loginMessage = document.querySelector('#loginMessage');
const passwordInput = document.querySelector('#password');
const loginButton = document.querySelector('#loginButton');
const dashboard = document.querySelector('#dashboard');
const logoutButton = document.querySelector('#logoutButton');
const pinForm = document.querySelector('#pinForm');
const gameSelect = document.querySelector('#gameId');
const badgeInput = document.querySelector('#badge');
const videoUrlInput = document.querySelector('#videoUrl');
const approveButton = document.querySelector('#approveButton');
const approvalMessage = document.querySelector('#approvalMessage');
const gameForm = document.querySelector('#gameForm');
const newPlatformInput = document.querySelector('#newPlatform');
const newGameNameInput = document.querySelector('#newGameName');
const addGameButton = document.querySelector('#addGameButton');
const gameMessage = document.querySelector('#gameMessage');
const editPanel = document.querySelector('#editPanel');
const editForm = document.querySelector('#editForm');
const editHelp = document.querySelector('#editHelp');
const editGameSelect = document.querySelector('#editGameId');
const editBadgeInput = document.querySelector('#editBadge');
const saveEditButton = document.querySelector('#saveEditButton');
const cancelEditButton = document.querySelector('#cancelEditButton');
const editMessage = document.querySelector('#editMessage');
const requestList = document.querySelector('#requestList');
const pinList = document.querySelector('#pinList');
const auditLog = document.querySelector('#auditLog');
let editingRequestId = '';

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function message(node, value, type = '') {
  node.textContent = value;
  node.className = `message ${type}`.trim();
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || 'The request failed.');
    error.status = response.status;
    throw error;
  }
  return body;
}

function renderGames(games) {
  for (const select of [gameSelect, editGameSelect]) {
    const selected = select.value;
    select.replaceChildren();
    for (const game of games) {
      const option = document.createElement('option');
      option.value = game.id;
      option.textContent = `${game.platform}: ${game.name}`;
      select.append(option);
    }
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }

  pinList.replaceChildren();
  const pins = games.flatMap(game => game.pins.map(pin => ({ ...pin, game })));
  if (pins.length === 0) pinList.append(text('p', 'empty', 'No manually approved videos yet.'));
  for (const pin of pins) {
    const item = document.createElement('article');
    item.className = 'pin-item';
    item.append(text('h3', '', pin.badge));
    item.append(text('p', 'meta', `${pin.game.platform} · ${pin.game.name}`));
    const link = text('a', '', pin.url);
    link.href = pin.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    item.append(link);
    const edit = text('button', 'use-button', 'Edit approved video');
    edit.type = 'button';
    edit.addEventListener('click', () => {
      gameSelect.value = pin.game.id;
      badgeInput.value = pin.badge;
      videoUrlInput.value = pin.url;
      badgeInput.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    item.append(edit);
    pinList.append(item);
  }
}

function renderRequests(requests) {
  requestList.replaceChildren();
  if (requests.length === 0) requestList.append(text('p', 'empty', 'No requests yet.'));
  for (const request of requests) {
    const item = document.createElement('article');
    item.className = 'request-item';
    const top = document.createElement('div');
    top.className = 'request-top';
    top.append(text('h3', '', request.suggestedBadge || request.badge));
    top.append(text('span', 'status', request.status.replaceAll('_', ' ')));
    item.append(top);
    item.append(text('p', 'meta', `${request.platform} · ${request.game}`));
    item.append(text('p', 'meta', `${new Date(request.createdAt).toLocaleString()} · ${request.requestClient || 'unknown client'}`));
    if (request.sourceTitle) item.append(text('p', 'meta', request.sourceTitle));
    const actions = document.createElement('div');
    actions.className = 'request-actions';
    const use = text('button', 'use-button', 'Use in approval form');
    use.type = 'button';
    use.addEventListener('click', () => {
      gameSelect.value = request.gameId;
      badgeInput.value = request.suggestedBadge || request.badge;
      videoUrlInput.focus();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    const edit = text('button', 'use-button', 'Edit request');
    edit.type = 'button';
    const busy = ['queued', 'searching', 'checking', 'downloading'].includes(request.status);
    edit.disabled = busy;
    if (busy) edit.title = 'Wait for the current guide work to finish.';
    edit.addEventListener('click', () => {
      editingRequestId = request.id;
      editGameSelect.value = request.gameId;
      editBadgeInput.value = request.suggestedBadge || request.badge;
      editHelp.textContent = request.status === 'complete'
        ? 'This renames the existing playable library card.'
        : 'Saving retries this request under the corrected game and badge name.';
      message(editMessage, '');
      editPanel.hidden = false;
      editPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    actions.append(use, edit);
    item.append(actions);
    requestList.append(item);
  }
}

function renderLog(entries) {
  auditLog.replaceChildren();
  if (entries.length === 0) auditLog.append(text('p', 'empty', 'The audit log is empty.'));
  for (const entry of entries) auditLog.append(text('div', 'audit-entry', entry));
}

function renderState(state) {
  if (!state.authenticated) {
    dashboard.hidden = true;
    loginPanel.hidden = false;
    loginHelp.textContent = state.configured
      ? 'Sign in to view requests and approve videos.'
      : 'No password is configured. Run “npm run set-password” in the project terminal first.';
    loginButton.disabled = !state.configured;
    return;
  }
  loginPanel.hidden = true;
  dashboard.hidden = false;
  renderGames(state.games || []);
  renderRequests(state.requests || []);
  renderLog(state.log || []);
}

async function loadState() {
  const state = await jsonFetch('/dad/api/state');
  renderState(state);
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  loginButton.disabled = true;
  message(loginMessage, 'Checking password...');
  try {
    await jsonFetch('/dad/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: passwordInput.value })
    });
    passwordInput.value = '';
    message(loginMessage, 'Unlocked.', 'success');
    await loadState();
  } catch (error) {
    message(loginMessage, error.message, 'error');
  } finally {
    loginButton.disabled = false;
  }
});

pinForm.addEventListener('submit', async event => {
  event.preventDefault();
  approveButton.disabled = true;
  message(approvalMessage, 'Checking the video before approval...');
  try {
    const state = await jsonFetch('/dad/api/pins', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: gameSelect.value, badge: badgeInput.value, url: videoUrlInput.value })
    });
    badgeInput.value = '';
    videoUrlInput.value = '';
    message(approvalMessage, `${state.message} The child can request that badge now.`, 'success');
    renderGames(state.games || []);
    renderRequests(state.requests || []);
    renderLog(state.log || []);
  } catch (error) {
    if (error.status === 401) await loadState();
    message(approvalMessage, error.message, 'error');
  } finally {
    approveButton.disabled = false;
  }
});

gameForm.addEventListener('submit', async event => {
  event.preventDefault();
  addGameButton.disabled = true;
  message(gameMessage, 'Adding the approved game...');
  try {
    const state = await jsonFetch('/dad/api/games', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: newPlatformInput.value, name: newGameNameInput.value })
    });
    newGameNameInput.value = '';
    message(gameMessage, state.message, 'success');
    renderGames(state.games || []);
    gameSelect.value = state.game.id;
    renderRequests(state.requests || []);
    renderLog(state.log || []);
  } catch (error) {
    if (error.status === 401) await loadState();
    message(gameMessage, error.message, 'error');
  } finally {
    addGameButton.disabled = false;
  }
});

editForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!editingRequestId) return;
  saveEditButton.disabled = true;
  message(editMessage, 'Saving the correction...');
  try {
    const state = await jsonFetch(`/dad/api/requests/${encodeURIComponent(editingRequestId)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gameId: editGameSelect.value, badge: editBadgeInput.value })
    });
    message(approvalMessage, state.message, 'success');
    editingRequestId = '';
    editPanel.hidden = true;
    renderGames(state.games || []);
    renderRequests(state.requests || []);
    renderLog(state.log || []);
  } catch (error) {
    if (error.status === 401) await loadState();
    message(editMessage, error.message, 'error');
  } finally {
    saveEditButton.disabled = false;
  }
});

cancelEditButton.addEventListener('click', () => {
  editingRequestId = '';
  editPanel.hidden = true;
  message(editMessage, '');
});

logoutButton.addEventListener('click', async () => {
  await jsonFetch('/dad/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await loadState();
});

loadState().catch(error => {
  loginPanel.hidden = false;
  message(loginMessage, error.message, 'error');
});
