'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeKey, stableId, validateGameName, validateGuideName, validatePlatform } = require('./safety');

const GAME_ID = /^<!-- game-id: ([a-z0-9-]{3,160}) -->$/i;
const PLATFORM = /^<!-- platform: (.+) -->$/;
const PIN = /^\s*-\s*\[([^\]]+)]\((https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[^)\s]+)\)(?:\s+<!-- guide-id: ([a-z0-9-]{3,160}) -->)?\s*$/i;

function parseCatalog(markdown) {
  const games = [];
  let current = null;
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    const heading = rawLine.match(/^##\s+([^:\n]+):\s*(.+?)\s*$/);
    if (heading) {
      const platform = heading[1].trim();
      const name = heading[2].trim();
      current = { id: stableId(`${platform}:${name}`), platform, name, pinned: {} };
      games.push(current);
      continue;
    }
    const identity = rawLine.match(GAME_ID);
    if (current && identity) current.id = identity[1];
    const link = rawLine.match(PIN);
    if (current && link) {
      current.pinned[normalizeKey(link[1])] = {
        id: link[3] || null, badge: link[1].trim(), url: link[2].trim()
      };
    }
  }
  const ids = new Set();
  const labels = new Set();
  for (const game of games) {
    const label = gameKey(game.platform, game.name);
    if (ids.has(game.id) || labels.has(label)) throw new Error(`Duplicate approved game: ${game.platform}: ${game.name}`);
    ids.add(game.id);
    labels.add(label);
    for (const pin of Object.values(game.pinned)) pin.id ||= stableId(`${game.id}:${pin.badge}`);
  }
  return games;
}

function gameKey(platform, name) {
  return normalizeKey(`${platform}:${name}`);
}

function parsePlatforms(markdown) {
  const platforms = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(PLATFORM);
    if (!match) continue;
    const platform = JSON.parse(match[1]);
    if (!/^[a-z0-9-]{3,160}$/i.test(platform.id) || validatePlatform(platform.name) !== platform.name) {
      throw new Error('Invalid platform record in the approved catalog.');
    }
    if (platforms.some(item => item.id === platform.id || normalizeKey(item.name) === normalizeKey(platform.name))) {
      throw new Error('Duplicate platform in the approved catalog.');
    }
    platforms.push(platform);
  }
  for (const game of parseCatalog(markdown)) {
    if (!platforms.some(item => normalizeKey(item.name) === normalizeKey(game.platform))) {
      platforms.push({ id: stableId(`platform:${game.platform}`), name: game.platform });
    }
  }
  return platforms;
}

function loadCatalog(filePath) { return parseCatalog(fs.readFileSync(filePath, 'utf8')); }
function loadPlatforms(filePath) { return parsePlatforms(fs.readFileSync(filePath, 'utf8')); }
function publicGames(games) { return games.map(({ id, platform, name }) => ({ id, platform, name })); }

function writeCatalog(filePath, markdown) {
  // Validate the entire result before the atomic replacement; retain free-form notes.
  parseCatalog(markdown);
  parsePlatforms(markdown);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(temporary, `${String(markdown).replace(/\n+$/, '')}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function withPlatforms(markdown, platforms) {
  const body = markdown.split(/\r?\n/).filter(line => !PLATFORM.test(line)).join('\n');
  return `${platforms.map(platform => `<!-- platform: ${JSON.stringify(platform)} -->`).join('\n')}\n${body}`;
}

function gameSection(lines, game) {
  const start = lines.findIndex(line => line.trim() === `## ${game.platform}: ${game.name}`);
  if (start < 0) throw new Error('The approved game heading could not be found.');
  let end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  if (end < 0) end = lines.length;
  return { start, end };
}

function replaceGame(lines, game, platform, name) {
  const { start, end } = gameSection(lines, game);
  // Materialize legacy identities before changing any display names.
  for (let index = start + 1; index < end; index += 1) {
    const link = lines[index].match(PIN);
    if (link) lines[index] = pinLine(game.pinned[normalizeKey(link[1])]);
  }
  lines[start] = `## ${platform}: ${name}`;
  const idIndex = lines.findIndex((line, index) => index > start && index < end && GAME_ID.test(line));
  if (idIndex >= 0) lines[idIndex] = `<!-- game-id: ${game.id} -->`;
  else lines.splice(start + 1, 0, `<!-- game-id: ${game.id} -->`);
}

function addApprovedGame(filePath, platformValue, nameValue) {
  let platform = validatePlatform(platformValue);
  const name = validateGameName(nameValue);
  let markdown = fs.readFileSync(filePath, 'utf8');
  const platforms = parsePlatforms(markdown);
  const existingPlatform = platforms.find(item => normalizeKey(item.name) === normalizeKey(platform));
  if (existingPlatform) platform = existingPlatform.name;
  else platforms.push({ id: crypto.randomUUID(), name: platform });
  if (parseCatalog(markdown).some(game => gameKey(game.platform, game.name) === gameKey(platform, name))) {
    throw new Error('That game is already approved.');
  }
  const id = crypto.randomUUID();
  markdown = withPlatforms(markdown, platforms);
  writeCatalog(filePath, `${markdown}\n## ${platform}: ${name}\n<!-- game-id: ${id} -->`);
  return { id, platform, name, pinned: {} };
}

function updateApprovedGame(filePath, gameId, platformValue, nameValue) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const game = games.find(item => item.id === gameId);
  if (!game) throw new Error('That approved game no longer exists.');
  const name = validateGameName(nameValue);
  const platforms = parsePlatforms(markdown);
  const platform = platforms.find(item => normalizeKey(item.name) === normalizeKey(validatePlatform(platformValue)));
  if (!platform) throw new Error('Please add that platform first.');
  if (games.some(item => item.id !== game.id && gameKey(item.platform, item.name) === gameKey(platform.name, name))) {
    throw new Error('That game is already approved.');
  }
  const lines = markdown.split(/\r?\n/);
  replaceGame(lines, game, platform.name, name);
  writeCatalog(filePath, withPlatforms(lines.join('\n'), platforms));
  return { ...game, platform: platform.name, name };
}

function addPlatform(filePath, nameValue) {
  const name = validatePlatform(nameValue);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const platforms = parsePlatforms(markdown);
  if (platforms.some(item => normalizeKey(item.name) === normalizeKey(name))) throw new Error('That platform already exists.');
  const platform = { id: crypto.randomUUID(), name };
  writeCatalog(filePath, withPlatforms(markdown, [...platforms, platform]));
  return platform;
}

function updatePlatform(filePath, id, nameValue) {
  const name = validatePlatform(nameValue);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const platforms = parsePlatforms(markdown);
  const platform = platforms.find(item => item.id === id);
  if (!platform) throw new Error('That platform no longer exists.');
  if (platforms.some(item => item.id !== id && normalizeKey(item.name) === normalizeKey(name))) throw new Error('That platform already exists.');
  const lines = markdown.split(/\r?\n/);
  for (const game of parseCatalog(markdown).filter(item => normalizeKey(item.platform) === normalizeKey(platform.name))) {
    replaceGame(lines, game, name, game.name);
  }
  platform.name = name;
  writeCatalog(filePath, withPlatforms(lines.join('\n'), platforms));
  return platform;
}

function removePlatform(filePath, id) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const platforms = parsePlatforms(markdown);
  const platform = platforms.find(item => item.id === id);
  if (!platform) throw new Error('That platform no longer exists.');
  if (parseCatalog(markdown).some(game => normalizeKey(game.platform) === normalizeKey(platform.name))) {
    throw new Error('Move or remove the games using this platform first.');
  }
  writeCatalog(filePath, withPlatforms(markdown, platforms.filter(item => item.id !== id)));
  return platform;
}

function pinLine(pin) { return `- [${pin.badge}](${pin.url}) <!-- guide-id: ${pin.id} -->`; }

function upsertPinnedGuide(filePath, gameId, badgeValue, url, previous = null) {
  const badge = validateGuideName(badgeValue);
  // Only validated canonical URLs can be persisted, including callers outside HTTP.
  const { extractYouTubeId, canonicalYouTubeUrl } = require('./discovery');
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new Error('Pinned guide is not a canonical YouTube video URL.');
  url = canonicalYouTubeUrl(videoId);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const game = games.find(item => item.id === gameId);
  if (!game) throw new Error('Please choose an approved game.');
  const oldGame = previous ? games.find(item => item.id === previous.gameId) : game;
  const oldPin = previous ? Object.values(oldGame?.pinned || {}).find(pin => pin.id === previous.id) : game.pinned[normalizeKey(badge)];
  if (previous && !oldPin) throw new Error('That pre-approved guide no longer exists.');
  const duplicate = game.pinned[normalizeKey(badge)];
  if (previous && duplicate && duplicate.id !== oldPin.id) throw new Error('That pre-approved guide already exists.');
  const pin = { id: oldPin?.id || crypto.randomUUID(), badge, url };
  const lines = markdown.split(/\r?\n/);
  if (oldPin) {
    const { start, end } = gameSection(lines, oldGame);
    const index = lines.findIndex((line, index) => index > start && index < end && normalizeKey(line.match(PIN)?.[1]) === normalizeKey(oldPin.badge));
    if (index < 0) throw new Error('The pre-approved guide entry could not be found.');
    lines.splice(index, 1);
  }
  const { start, end } = gameSection(lines, game);
  let insert = end;
  while (insert > start + 1 && lines[insert - 1].trim() === '') insert -= 1;
  lines.splice(insert, 0, pinLine(pin));
  writeCatalog(filePath, lines.join('\n'));
  return { game, ...pin, replaced: Boolean(oldPin) };
}

function removePinnedGuide(filePath, gameId, badgeValue) {
  const badge = validateGuideName(badgeValue);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const game = parseCatalog(markdown).find(item => item.id === gameId);
  if (!game) throw new Error('Please choose an approved game.');
  const pin = game.pinned[normalizeKey(badge)];
  if (!pin) throw new Error('That approved video no longer exists.');
  const lines = markdown.split(/\r?\n/);
  const { start, end } = gameSection(lines, game);
  const index = lines.findIndex((line, index) => index > start && index < end && normalizeKey(line.match(PIN)?.[1]) === normalizeKey(badge));
  if (index < 0) throw new Error('The approved video entry could not be found.');
  lines.splice(index, 1);
  writeCatalog(filePath, lines.join('\n'));
  return { game, pin };
}

function removeApprovedGame(filePath, gameId) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const game = parseCatalog(markdown).find(item => item.id === gameId);
  if (!game) throw new Error('That approved game no longer exists.');
  const lines = markdown.split(/\r?\n/);
  const { start, end } = gameSection(lines, game);
  lines.splice(start, end - start);
  writeCatalog(filePath, withPlatforms(lines.join('\n'), parsePlatforms(markdown)));
  return game;
}

module.exports = {
  addApprovedGame, updateApprovedGame, loadCatalog, parseCatalog, publicGames, gameKey,
  addPlatform, updatePlatform, removePlatform, loadPlatforms,
  removeApprovedGame, removePinnedGuide, upsertPinnedGuide
};
