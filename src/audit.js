'use strict';

const fs = require('fs');
const path = require('path');

function field(value) {
  return String(value == null ? '' : value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/]/g, '\\]')
    .trim();
}

class RequestAudit {
  constructor(filePath) {
    this.filePath = filePath;
  }

  append(type, details = {}) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '# Voidling Guides Request Log\n\n', { mode: 0o600 });
    }
    const date = details.date || new Date().toISOString();
    const parts = [date, type, details.game, details.badge, details.video || 'NO VIDEO SERVED'];
    if (details.client) parts.push(`client=${details.client}`);
    if (details.url) parts.push(details.url);
    if (details.antigravity) parts.push(`AGY=${details.antigravity}`);
    if (details.reason) parts.push(`reason=${details.reason}`);
    fs.appendFileSync(this.filePath, `[${parts.map(field).join(' - ')}]\n`, { mode: 0o600 });
  }

  recent(limit = 40) {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.startsWith('['))
      .slice(-Math.max(1, Math.min(Number(limit) || 40, 100)))
      .reverse();
  }
}

module.exports = { RequestAudit, field };
