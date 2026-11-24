import { el, jsonFetch, setMessage } from '/client-utils.js';

const $ = selector => document.querySelector(selector);
const busyStatuses = new Set(['queued', 'searching', 'checking', 'downloading']);
let editingGameId = '';
let editingPlatformId = '';
let editingPin = null;
let approvalRequestId = '';
let editingRequestId = '';
let historyOffset = null;

function message(node, value, type = '') {
  setMessage(node, value, 'message', type);
}

function button(label, action, destructive = false) {
  const node = el('button', `use-button${destructive ? ' destructive-button' : ''}`, label);
  node.type = 'button';
  node.addEventListener('click', () => action(node));
  return node;
}

function actions(...buttons) {
  const node = el('div', 'request-actions');
  node.append(...buttons);
  return node;
}

function card(name, meta, status = '') {
  const node = el('article', 'request-item');
  const top = el('div', 'request-top');
  top.append(el('h4', '', name));
  if (status) top.append(el('span', 'status', status.replaceAll('_', ' ')));
  node.append(top, el('p', 'meta', meta));
  return node;
}

function focusForm(form, field) {
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  field.focus({ preventScroll: true });
}

function fillSelect(select, records, label) {
  const selected = select.value;
  select.replaceChildren(...records.map(record => {
    const option = el('option', '', label(record));
    option.value = record.id;
    return option;
  }));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

function guideLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && ['www.youtube.com', 'youtube.com', 'youtu.be'].includes(parsed.hostname)
      && !parsed.username && !parsed.password && !parsed.port) {
      const link = el('a', 'guide-url', url);
      link.href = parsed.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }
  } catch { /* A request may not have a video yet. */ }
  return el('p', 'meta', 'URL: No video selected yet.');
}

function confirmAction(promptText) {
  const dialog = $('#confirmDialog');
  if (!dialog || typeof dialog.showModal !== 'function') {
    return Promise.resolve(window.confirm(promptText));
  }
  $('#confirmDialogBody').textContent = promptText;
  return new Promise(resolve => {
    const accept = $('#confirmDialogAccept');
    const cancel = $('#confirmDialogCancel');
    const finish = confirmed => {
      accept.removeEventListener('click', onAccept);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      resolve(confirmed);
    };
    const onAccept = () => finish(true);
    const onCancel = event => {
      event?.preventDefault();
      finish(false);
    };
    accept.addEventListener('click', onAccept);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('cancel', onCancel);
    dialog.showModal();
  });
}

async function mutate(url, method, body, messageNode, buttons, after = () => {}) {
  const previousStates = buttons.map(node => ({ node, disabled: node.disabled }));
  buttons.forEach(node => { node.disabled = true; });
  message(messageNode, 'Saving…');
  let succeeded = false;
  try {
    const state = await jsonFetch(url, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    succeeded = true;
    after(state);
    renderDashboard(state);
    message(messageNode, state.message, 'success');
  } catch (error) {
    if (error.status === 401) await loadState();
    message(messageNode, error.message, 'error');
  } finally {
    if (!succeeded) {
      for (const item of previousStates) item.node.disabled = item.disabled;
    } else {
      for (const node of buttons) {
        if (!['addGameButton', 'approveButton', 'preapproveButton'].includes(node.id)) {
          node.disabled = false;
        }
      }
    }
  }
}

async function removeThing({ button: trigger, prompt, url, body = {}, messageNode }) {
  if (!await confirmAction(prompt)) return;
  await mutate(url, 'DELETE', body, messageNode, [trigger]);
}

function resetGame() {
  editingGameId = '';
  $('#newGameName').value = '';
  $('#gameFormHeading').textContent = 'Add a game';
  $('#addGameButton').textContent = 'Add approved game';
  $('#cancelGameButton').hidden = true;
}

function resetPlatform() {
  editingPlatformId = '';
  $('#platformForm').reset();
  $('#platformFormHeading').textContent = 'Add a platform';
  $('#savePlatformButton').textContent = 'Add platform';
  $('#cancelPlatformButton').hidden = true;
}

function resetPin() {
  editingPin = null;
  approvalRequestId = '';
  $('#guide').value = '';
  $('#videoUrl').value = '';
  $('#pinFormHeading').textContent = 'Add a pre-approved guide';
  $('#preapproveButton').textContent = 'Pre-Approve';
  $('#cancelPinButton').hidden = true;
}

function renderGames(games) {
  for (const select of [$('#gameId'), $('#editGameId')]) {
    fillSelect(select, games, game => `${game.platform}: ${game.name}`);
  }
  $('#approveButton').disabled = $('#preapproveButton').disabled = games.length === 0;
  const list = $('#approvedGameList');
  list.replaceChildren();
  if (!games.length) list.append(el('p', 'empty', 'No approved games yet. Add a platform, then a game.'));
  for (const game of games) {
    const item = card(game.name, `${game.platform} · ${game.pins.length} pre-approved guides`);
    item.append(actions(button('Edit', () => {
      editingGameId = game.id;
      $('#newGameName').value = game.name;
      $('#newPlatform').value = game.platform;
      $('#gameFormHeading').textContent = 'Edit game';
      $('#addGameButton').textContent = 'Save changes';
      $('#cancelGameButton').hidden = false;
      message($('#gameMessage'), '');
      focusForm($('#gameForm'), $('#newGameName'));
    }), button('Remove', remove => removeThing({
      button: remove, url: `/dad/api/games/${encodeURIComponent(game.id)}`, messageNode: $('#gameMessage'),
      prompt: `Remove ${game.name} and its pre-approved guide links? Related library entries must be removed first.`
    }), true)));
    list.append(item);
  }
  const pins = $('#pinList');
  pins.replaceChildren();
  if (!games.some(game => game.pins.length)) pins.append(el('p', 'empty', 'No pre-approved guides yet.'));
  for (const game of games) for (const pin of game.pins) {
    const item = card(pin.guide, `${game.platform} · ${game.name}`);
    item.append(guideLink(pin.url));
    item.append(actions(button('Edit', () => {
      resetPin();
      editingPin = { id: pin.id, gameId: game.id };
      $('#gameId').value = game.id;
      $('#guide').value = pin.guide;
      $('#videoUrl').value = pin.url;
      $('#pinFormHeading').textContent = 'Edit pre-approved guide';
      $('#preapproveButton').textContent = 'Save changes';
      $('#cancelPinButton').hidden = false;
      message($('#approvalMessage'), '');
      focusForm($('#pinForm'), $('#guide'));
    }), button('Remove', remove => removeThing({
      button: remove, url: '/dad/api/pins', body: { gameId: game.id, guide: pin.guide },
      prompt: `Remove ${pin.guide} from the pre-approved list? Downloaded library copies stay available.`,
      messageNode: $('#approvalMessage')
    }), true)));
    pins.append(item);
  }
}

function renderPlatforms(platforms) {
  const select = $('#newPlatform');
  fillSelect(select, platforms.map(platform => ({ id: platform.name, name: platform.name })), platform => platform.name);
  $('#addGameButton').disabled = !platforms.length;
  const list = $('#platformList');
  list.replaceChildren();
  if (!platforms.length) list.append(el('p', 'empty', 'No platforms yet. Add one to get started.'));
  for (const platform of platforms) {
    const item = card(platform.name, 'Platform');
    item.append(actions(button('Edit', () => {
      editingPlatformId = platform.id;
      $('#platformName').value = platform.name;
      $('#platformFormHeading').textContent = 'Edit platform';
      $('#savePlatformButton').textContent = 'Save changes';
      $('#cancelPlatformButton').hidden = false;
      message($('#platformMessage'), '');
      focusForm($('#platformForm'), $('#platformName'));
    }), button('Remove', remove => removeThing({
      button: remove, url: `/dad/api/platforms/${encodeURIComponent(platform.id)}`,
      prompt: `Remove ${platform.name}? Platforms in use cannot be removed.`, messageNode: $('#platformMessage')
    }), true)));
    list.append(item);
  }
}

function renderRequests(requests) {
  const list = $('#requestList');
  list.replaceChildren();
  if (!requests.length) list.append(el('p', 'empty', 'No current library entries. Previous requests remain in the log below.'));
  for (const request of requests) {
    const item = card(request.guide, `${request.platform} · ${request.game}`, request.status);
    item.append(el('p', 'meta', new Date(request.createdAt).toLocaleString()), guideLink(request.url));
    if (request.suggestedGuide) item.append(el('p', 'meta', `Suggested name: ${request.suggestedGuide}`));
    if (request.sourceTitle) item.append(el('p', 'meta', request.sourceTitle));
    const preapprove = button('Pre-Approve', () => {
      resetPin();
      approvalRequestId = request.id;
      $('#gameId').value = request.gameId;
      $('#guide').value = request.suggestedGuide || request.guide;
      $('#videoUrl').value = request.url;
      $('#cancelPinButton').hidden = false;
      message($('#approvalMessage'), 'Review the name and URL, then choose Pre-Approve to save this guide.');
      focusForm($('#pinForm'), $('#videoUrl'));
    });
    const edit = button('Edit', () => {
      editingRequestId = request.id;
      $('#editGameId').value = request.gameId;
      $('#editGuide').value = request.suggestedGuide || request.guide;
      $('#editHelp').textContent = request.status === 'complete'
        ? 'Save changes to rename this playable library entry.'
        : 'Save changes to retry this request with the corrected game and guide name.';
      $('#editPanel').hidden = false;
      message($('#editMessage'), '');
      focusForm($('#editForm'), $('#editGuide'));
    });
    const remove = button('Remove', node => removeThing({
      button: node, url: `/dad/api/requests/${encodeURIComponent(request.id)}`, messageNode: $('#approvalMessage'),
      prompt: request.status === 'complete' ? `Remove ${request.guide} and permanently delete its downloaded WebM? The request log stays.`
        : `Remove ${request.guide} from the library? The request log stays.`
    }), true);
    for (const action of [preapprove, edit, remove]) {
      action.disabled = busyStatuses.has(request.status);
      if (action.disabled) action.title = 'Wait for the current guide work to finish.';
    }
    item.append(actions(preapprove, edit, remove));
    list.append(item);
  }
}

function renderGameRequests(requests) {
  const pending = $('#gameRequestList');
  const history = $('#gameHistoryList');
  pending.replaceChildren();
  history.replaceChildren();
  if (!requests.some(request => request.status === 'pending')) pending.append(el('p', 'empty', 'No games waiting for approval.'));
  if (!requests.some(request => request.status !== 'pending')) history.append(el('p', 'empty', 'No reviewed game requests yet.'));
  for (const request of requests) {
    const item = card(request.name, `${request.platform} · ${new Date(request.createdAt).toLocaleString()}`, request.status);
    if (request.status === 'pending') {
      const approve = button('Approve game', () => decide('approve'));
      const decline = button('Decline', () => decide('decline'));
      const decide = decision => mutate(`/dad/api/game-requests/${encodeURIComponent(request.id)}`, 'POST',
        { decision }, $('#gameMessage'), [approve, decline]);
      item.append(actions(approve, decline));
    } else if (request.resolvedAt) item.append(el('p', 'meta', `Reviewed ${new Date(request.resolvedAt).toLocaleString()}`));
    item.append(button('Remove request', remove => removeThing({
      button: remove, url: `/dad/api/game-requests/${encodeURIComponent(request.id)}`,
      prompt: `Remove the ${request.name} game request from review history? Its audit record stays.`, messageNode: $('#gameMessage')
    }), true));
    (request.status === 'pending' ? pending : history).append(item);
  }
}

function renderLog(entries, list) {
  list.replaceChildren();
  if (!entries.length) list.append(el('p', 'empty', 'No recorded activity yet.'));
  for (const entry of entries) list.append(el('div', 'audit-entry', entry));
}

function renderHistory(history, append = false) {
  if (!append) {
    renderLog(history.entries, $('#requestHistory'));
    message($('#historyMessage'), '');
  } else {
    for (const entry of history.entries) $('#requestHistory').append(el('div', 'audit-entry', entry));
  }
  historyOffset = history.nextOffset;
  $('#moreHistoryButton').hidden = historyOffset === null;
}

function renderDashboard(state) {
  renderPlatforms(state.platforms || []);
  renderGames(state.games || []);
  renderRequests(state.requests || []);
  renderGameRequests(state.gameRequests || []);
  renderHistory(state.history || { entries: [], nextOffset: null });
  renderLog(state.log || [], $('#auditLog'));
}

async function loadState() {
  const state = await jsonFetch('/dad/api/state');
  $('#dashboard').hidden = !state.authenticated;
  $('#loginPanel').hidden = state.authenticated;
  if (state.authenticated) renderDashboard(state);
  else {
    $('#loginHelp').textContent = state.configured ? 'Sign in to view requests and approve videos.'
      : 'No password is configured. Run “npm run set-password” in the project terminal first.';
    $('#loginButton').disabled = !state.configured;
  }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('#loginButton').disabled = true;
  try {
    await jsonFetch('/dad/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('#password').value })
    });
    $('#password').value = '';
    message($('#loginMessage'), '');
    await loadState();
  } catch (error) {
    message($('#loginMessage'), error.message, 'error');
  } finally {
    $('#loginButton').disabled = false;
  }
});

$('#gameForm').addEventListener('submit', event => {
  event.preventDefault();
  mutate(editingGameId ? `/dad/api/games/${encodeURIComponent(editingGameId)}` : '/dad/api/games',
    editingGameId ? 'PATCH' : 'POST', { platform: $('#newPlatform').value, name: $('#newGameName').value },
    $('#gameMessage'), [$('#addGameButton'), $('#cancelGameButton')], resetGame);
});
$('#cancelGameButton').addEventListener('click', () => { resetGame(); message($('#gameMessage'), 'Edit cancelled.'); });

$('#platformForm').addEventListener('submit', event => {
  event.preventDefault();
  mutate(editingPlatformId ? `/dad/api/platforms/${encodeURIComponent(editingPlatformId)}` : '/dad/api/platforms',
    editingPlatformId ? 'PATCH' : 'POST', { name: $('#platformName').value }, $('#platformMessage'),
    [$('#savePlatformButton'), $('#cancelPlatformButton')], resetPlatform);
});
$('#cancelPlatformButton').addEventListener('click', () => { resetPlatform(); message($('#platformMessage'), 'Edit cancelled.'); });

$('#pinForm').addEventListener('submit', event => {
  event.preventDefault();
  mutate('/dad/api/pins', editingPin ? 'PATCH' : 'POST', {
    gameId: $('#gameId').value, guide: $('#guide').value, url: $('#videoUrl').value,
    download: event.submitter === $('#approveButton'),
    ...(editingPin ? { previousGameId: editingPin.gameId, pinId: editingPin.id } : {}),
    ...(approvalRequestId ? { requestId: approvalRequestId } : {})
  }, $('#approvalMessage'), [$('#preapproveButton'), $('#approveButton'), $('#cancelPinButton')], resetPin);
});
$('#cancelPinButton').addEventListener('click', () => { resetPin(); message($('#approvalMessage'), 'Edit cancelled.'); });

$('#editForm').addEventListener('submit', event => {
  event.preventDefault();
  mutate(`/dad/api/requests/${encodeURIComponent(editingRequestId)}`, 'PATCH',
    { gameId: $('#editGameId').value, guide: $('#editGuide').value }, $('#editMessage'),
    [$('#saveEditButton'), $('#cancelEditButton')], state => {
      editingRequestId = '';
      $('#editPanel').hidden = true;
      message($('#approvalMessage'), state.message, 'success');
    });
});
$('#cancelEditButton').addEventListener('click', () => {
  editingRequestId = '';
  $('#editPanel').hidden = true;
  message($('#approvalMessage'), 'Edit cancelled.');
});
$('#moreHistoryButton').addEventListener('click', async () => {
  $('#moreHistoryButton').disabled = true;
  try {
    const history = await jsonFetch(`/dad/api/history?offset=${historyOffset}`);
    renderHistory(history, true);
    message($('#historyMessage'), 'Older requests loaded.');
  } catch (error) {
    message($('#historyMessage'), error.message, 'error');
  } finally {
    $('#moreHistoryButton').disabled = false;
  }
});
$('#logoutButton').addEventListener('click', async () => {
  try {
    await jsonFetch('/dad/api/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    resetGame(); resetPlatform(); resetPin();
    $('#editPanel').hidden = true;
    await loadState();
  } catch (error) {
    message($('#gameMessage'), error.message, 'error');
  }
});

loadState().catch(error => {
  $('#loginPanel').hidden = false;
  message($('#loginMessage'), error.message, 'error');
});
