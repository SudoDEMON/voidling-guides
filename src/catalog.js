'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeKey, stableId, validateGameName, validatePlatform } = require('./safety');

function parseCatalog(markdown) {
  const games = [];
  let current = null;

  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    const heading = rawLine.match(/^##\s+([^:\n]+):\s*(.+?)\s*$/);
    if (heading) {
      const platform = heading[1].trim();
      const name = heading[2].trim();
      current = {
        id: stableId(`${platform}:${name}`),
        platform,
        name,
        pinned: {}
      };
      games.push(current);
      continue;
    }

    const link = rawLine.match(/^\s*-\s*\[([^\]]+)]\((https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)[^)\s]+)\)\s*$/i);
    if (current && link) {
      current.pinned[normalizeKey(link[1])] = {
        badge: link[1].trim(),
        url: link[2].trim()
      };
    }
  }

  const seen = new Set();
  for (const game of games) {
    if (seen.has(game.id)) throw new Error(`Duplicate approved game: ${game.platform}: ${game.name}`);
    seen.add(game.id);
  }
  return games;
}

function loadCatalog(filePath) {
  return parseCatalog(fs.readFileSync(filePath, 'utf8'));
}

function publicGames(games) {
  return games.map(({ id, platform, name }) => ({ id, platform, name }));
}

function writeCatalog(filePath, markdown) {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(temporary, `${String(markdown).replace(/\n+$/, '')}\n`);
  fs.renameSync(temporary, filePath);
}

function addApprovedGame(filePath, platformValue, nameValue) {
  const platform = validatePlatform(platformValue);
  const name = validateGameName(nameValue);
  const markdown = fs.readFileSync(filePath, 'utf8');
  const id = stableId(`${platform}:${name}`);
  if (parseCatalog(markdown).some(game => game.id === id)) throw new Error('That game is already approved.');
  writeCatalog(filePath, `${markdown}\n## ${platform}: ${name}`);
  return { id, platform, name, pinned: {} };
}

function upsertPinnedGuide(filePath, gameId, badge, url) {
  const markdown = fs.readFileSync(filePath, 'utf8');
  const games = parseCatalog(markdown);
  const game = games.find(item => item.id === gameId);
  if (!game) throw new Error('Please choose an approved game.');

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const targetHeading = `## ${game.platform}: ${game.name}`;
  const start = lines.findIndex(line => line.trim() === targetHeading);
  if (start < 0) throw new Error('The approved game heading could not be found.');
  let end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  if (end < 0) end = lines.length;

  const badgeKey = normalizeKey(badge);
  const replacement = `- [${badge}](${url})`;
  const existing = lines.findIndex((line, index) => {
    if (index <= start || index >= end) return false;
    const match = line.match(/^\s*-\s*\[([^\]]+)]\(/);
    return match && normalizeKey(match[1]) === badgeKey;
  });
  if (existing >= 0) {
    lines[existing] = replacement;
  } else {
    while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
    lines.splice(end, 0, replacement);
  }

  writeCatalog(filePath, lines.join('\n'));
  return { game, badge, url, replaced: existing >= 0 };
}

module.exports = { addApprovedGame, loadCatalog, parseCatalog, publicGames, upsertPinnedGuide };
