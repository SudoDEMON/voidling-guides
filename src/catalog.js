import crypto from 'node:crypto';
import fs from 'node:fs';
import { HttpError, writeFileAtomic } from './fs-utils.js';
import { normalizeKey, stableId, validateGameName, validateGuideName, validatePlatform } from './safety.js';
import { canonicalYouTubeUrl, extractYouTubeId } from './youtube.js';

const HEADING = /^##\s+([^:\n]+):\s*(.+?)\s*$/;
const GAME_ID = /^<!-- game-id: ([a-z0-9-]{3,160}) -->$/i;
const PLATFORM = /^<!-- platform: (.+) -->$/;
const PIN = /^\s*-\s*\[([^\]]+)]\((https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[^)\s]+)\)(?:\s+<!-- guide-id: ([a-z0-9-]{3,160}) -->)?\s*$/i;

export function gameKey(platform, name) {
  return normalizeKey(`${platform}:${name}`);
}

export function parseCatalog(markdown) {
  const games = [];
  let current = null;
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    const heading = rawLine.match(HEADING);
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
        id: link[3] || null, guide: link[1].trim(), url: link[2].trim()
      };
    }
  }
  const ids = new Set();
  const labels = new Set();
  for (const game of games) {
    const label = gameKey(game.platform, game.name);
    if (ids.has(game.id) || labels.has(label)) {
      throw new HttpError(400, `Duplicate approved game: ${game.platform}: ${game.name}`);
    }
    ids.add(game.id);
    labels.add(label);
    for (const pin of Object.values(game.pinned)) pin.id ||= stableId(`${game.id}:${pin.guide}`);
  }
  return games;
}

function parsePlatforms(markdown, parsedGames = null) {
  const platforms = [];
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = line.match(PLATFORM);
    if (!match) continue;
    let platform;
    try {
      platform = JSON.parse(match[1]);
    } catch {
      throw new HttpError(400, 'Invalid platform record in the approved catalog.');
    }
    if (!platform || !/^[a-z0-9-]{3,160}$/i.test(platform.id || '') || validatePlatform(platform.name) !== platform.name) {
      throw new HttpError(400, 'Invalid platform record in the approved catalog.');
    }
    if (platforms.some(item => item.id === platform.id || normalizeKey(item.name) === normalizeKey(platform.name))) {
      throw new HttpError(400, 'Duplicate platform in the approved catalog.');
    }
    platforms.push(platform);
  }
  for (const game of parsedGames || parseCatalog(markdown)) {
    if (!platforms.some(item => normalizeKey(item.name) === normalizeKey(game.platform))) {
      platforms.push({ id: stableId(`platform:${game.platform}`), name: game.platform });
    }
  }
  return platforms;
}

export function loadCatalog(filePath) {
  return parseCatalog(fs.readFileSync(filePath, 'utf8'));
}

export function loadPlatforms(filePath) {
  return parsePlatforms(fs.readFileSync(filePath, 'utf8'));
}

export function publicGames(games) {
  return games.map(({ id, platform, name }) => ({ id, platform, name }));
}

function writeCatalog(filePath, markdown) {
  // Validate the entire result before atomic replacement; retain free-form notes.
  const games = parseCatalog(markdown);
  parsePlatforms(markdown, games);
  writeFileAtomic(filePath, `${String(markdown).replace(/\n+$/, '')}\n`, { mode: 0o600 });
}

function withPlatforms(markdown, platforms) {
  const body = markdown.split(/\r?\n/).filter(line => !PLATFORM.test(line)).join('\n');
  const header = platforms.map(platform => `<!-- platform: ${JSON.stringify(platform)} -->`).join('\n');
  return header ? `${header}\n${body}` : body;
}

function gameSection(lines, game) {
  const targetKey = gameKey(game.platform, game.name);
  const start = lines.findIndex(line => {
    const match = line.match(HEADING);
    return match && gameKey(match[1].trim(), match[2].trim()) === targetKey;
  });
  if (start < 0) throw new HttpError(404, 'The approved game heading could not be found.');
  let end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  if (end < 0) end = lines.length;
  return { start, end };
}

function pinLine(pin) {
  return `- [${pin.guide}](${pin.url}) <!-- guide-id: ${pin.id} -->`;
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

export function addApprovedGame(filePath, platformValue, nameValue) {
  let platform = validatePlatform(platformValue);
  const name = validateGameName(nameValue);
  let markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const platforms = parsePlatforms(markdown, games);
  const existingPlatform = platforms.find(item => normalizeKey(item.name) === normalizeKey(platform));
  if (existingPlatform) platform = existingPlatform.name;
  else platforms.push({ id: crypto.randomUUID(), name: platform });
  if (games.some(game => gameKey(game.platform, game.name) === gameKey(platform, name))) {
    throw new HttpError(400, 'That game is already approved.');
  }
  const id = crypto.randomUUID();
  markdown = withPlatforms(markdown, platforms);
  writeCatalog(filePath, `${markdown}\n## ${platform}: ${name}\n<!-- game-id: ${id} -->`);
  return { id, platform, name, pinned: {} };
}

export function updateApprovedGame(filePath, gameId, platformValue, nameValue) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const game = games.find(item => item.id === gameId);
  if (!game) throw new HttpError(404, 'That approved game no longer exists.');
  const name = validateGameName(nameValue);
  const platforms = parsePlatforms(markdown, games);
  const platform = platforms.find(item => normalizeKey(item.name) === normalizeKey(validatePlatform(platformValue)));
  if (!platform) throw new HttpError(400, 'Please add that platform first.');
  if (games.some(item => item.id !== game.id && gameKey(item.platform, item.name) === gameKey(platform.name, name))) {
    throw new HttpError(400, 'That game is already approved.');
  }
  const lines = markdown.split(/\r?\n/);
  replaceGame(lines, game, platform.name, name);
  writeCatalog(filePath, withPlatforms(lines.join('\n'), platforms));
  return { ...game, platform: platform.name, name };
}

export function addPlatform(filePath, nameValue) {
  const name = validatePlatform(nameValue);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const platforms = parsePlatforms(markdown);
  if (platforms.some(item => normalizeKey(item.name) === normalizeKey(name))) {
    throw new HttpError(400, 'That platform already exists.');
  }
  const platform = { id: crypto.randomUUID(), name };
  writeCatalog(filePath, withPlatforms(markdown, [...platforms, platform]));
  return platform;
}

export function updatePlatform(filePath, id, nameValue) {
  const name = validatePlatform(nameValue);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const platforms = parsePlatforms(markdown, games);
  const platform = platforms.find(item => item.id === id);
  if (!platform) throw new HttpError(404, 'That platform no longer exists.');
  if (platforms.some(item => item.id !== id && normalizeKey(item.name) === normalizeKey(name))) {
    throw new HttpError(400, 'That platform already exists.');
  }
  const lines = markdown.split(/\r?\n/);
  for (const game of games.filter(item => normalizeKey(item.platform) === normalizeKey(platform.name))) {
    replaceGame(lines, game, name, game.name);
  }
  platform.name = name;
  writeCatalog(filePath, withPlatforms(lines.join('\n'), platforms));
  return platform;
}

export function removePlatform(filePath, id) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const platforms = parsePlatforms(markdown, games);
  const platform = platforms.find(item => item.id === id);
  if (!platform) throw new HttpError(404, 'That platform no longer exists.');
  if (games.some(game => normalizeKey(game.platform) === normalizeKey(platform.name))) {
    throw new HttpError(409, 'Move or remove the games using this platform first.');
  }
  writeCatalog(filePath, withPlatforms(markdown, platforms.filter(item => item.id !== id)));
  return platform;
}

export function upsertPinnedGuide(filePath, gameId, guideValue, url, previous = null) {
  const guide = validateGuideName(guideValue);
  // Only validated canonical URLs can be persisted, including callers outside HTTP.
  const videoId = extractYouTubeId(url);
  if (!videoId) throw new HttpError(400, 'Pinned guide is not a canonical YouTube video URL.');
  const canonicalUrl = canonicalYouTubeUrl(videoId);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const game = games.find(item => item.id === gameId);
  if (!game) throw new HttpError(400, 'Please choose an approved game.');
  const oldGame = previous ? games.find(item => item.id === previous.gameId) : game;
  const oldPin = previous
    ? Object.values(oldGame?.pinned || {}).find(pin => pin.id === previous.id)
    : game.pinned[normalizeKey(guide)];
  if (previous && !oldPin) throw new HttpError(404, 'That pre-approved guide no longer exists.');
  const duplicate = game.pinned[normalizeKey(guide)];
  if (previous && duplicate && duplicate.id !== oldPin.id) {
    throw new HttpError(400, 'That pre-approved guide already exists.');
  }
  const pin = { id: oldPin?.id || crypto.randomUUID(), guide, url: canonicalUrl };
  const lines = markdown.split(/\r?\n/);
  if (oldPin) {
    const { start, end } = gameSection(lines, oldGame);
    const index = lines.findIndex((line, lineIndex) => (
      lineIndex > start && lineIndex < end && normalizeKey(line.match(PIN)?.[1]) === normalizeKey(oldPin.guide)
    ));
    if (index < 0) throw new HttpError(404, 'The pre-approved guide entry could not be found.');
    lines.splice(index, 1);
  }
  const { start, end } = gameSection(lines, game);
  let insert = end;
  while (insert > start + 1 && lines[insert - 1].trim() === '') insert -= 1;
  lines.splice(insert, 0, pinLine(pin));
  writeCatalog(filePath, lines.join('\n'));
  return { game, ...pin, replaced: Boolean(oldPin) };
}

export function removePinnedGuide(filePath, gameId, guideValue) {
  const guide = validateGuideName(guideValue);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const game = parseCatalog(markdown).find(item => item.id === gameId);
  if (!game) throw new HttpError(400, 'Please choose an approved game.');
  const pin = game.pinned[normalizeKey(guide)];
  if (!pin) throw new HttpError(404, 'That approved video no longer exists.');
  const lines = markdown.split(/\r?\n/);
  const { start, end } = gameSection(lines, game);
  const index = lines.findIndex((line, lineIndex) => (
    lineIndex > start && lineIndex < end && normalizeKey(line.match(PIN)?.[1]) === normalizeKey(guide)
  ));
  if (index < 0) throw new HttpError(404, 'The approved video entry could not be found.');
  lines.splice(index, 1);
  writeCatalog(filePath, lines.join('\n'));
  return { game, pin };
}

export function removeApprovedGame(filePath, gameId) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const game = games.find(item => item.id === gameId);
  if (!game) throw new HttpError(404, 'That approved game no longer exists.');
  const lines = markdown.split(/\r?\n/);
  const { start, end } = gameSection(lines, game);
  lines.splice(start, end - start);
  writeCatalog(filePath, withPlatforms(lines.join('\n'), parsePlatforms(markdown, games)));
  return game;
}
