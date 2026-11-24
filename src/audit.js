import fs from 'node:fs';
import path from 'node:path';

const GUIDE_HISTORY_LINE = /^\[[^\]]+? - (REQUESTED|DUPLICATE|SUGGESTED|CONFIRMED|DECLINED|SERVED|FAILED|DAD_REQUEST_UPDATED|DAD_REQUEST_REMOVED|DAD_PIN_ADDED|DAD_PIN_REPLACED) - /;

function field(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/]/g, '\\]')
    .trim();
}

function formatHistory(lines, offset = 0, limit = 30) {
  const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  const entries = lines.filter(line => GUIDE_HISTORY_LINE.test(line)).reverse();
  return {
    entries: entries.slice(safeOffset, safeOffset + limit),
    total: entries.length,
    offset: safeOffset,
    nextOffset: safeOffset + limit < entries.length ? safeOffset + limit : null
  };
}

function formatRecent(lines, limit = 40) {
  const clamped = Math.max(1, Math.min(Number(limit) || 40, 100));
  return lines.filter(line => line.startsWith('[')).slice(-clamped).reverse();
}

export class RequestAudit {
  constructor(filePath) {
    this.filePath = filePath;
  }

  readLines() {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/);
  }

  append(type, details = {}) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '# Voidling Guides Request Log\n\n', { mode: 0o600 });
    }
    const date = details.date || new Date().toISOString();
    const guideName = details.guide ?? details.badge;
    const parts = [date, type, details.game, guideName, details.video || 'NO VIDEO SERVED'];
    if (details.client) parts.push(`client=${details.client}`);
    if (details.url) parts.push(details.url);
    if (details.antigravity) parts.push(`AGY=${details.antigravity}`);
    if (details.reason) parts.push(`reason=${details.reason}`);
    fs.appendFileSync(this.filePath, `[${parts.map(field).join(' - ')}]\n`, { mode: 0o600 });
  }

  guideHistory(offset = 0, limit = 30) {
    return formatHistory(this.readLines(), offset, limit);
  }

  recent(limit = 40) {
    return formatRecent(this.readLines(), limit);
  }

  snapshot(recentLimit = 50, historyLimit = 30) {
    const lines = this.readLines();
    return {
      history: formatHistory(lines, 0, historyLimit),
      log: formatRecent(lines, recentLimit)
    };
  }
}
