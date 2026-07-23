'use strict';

const fs = require('fs');
const path = require('path');

const COMPLETE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_TTL_MS = 24 * 60 * 60 * 1000;
const RESOLVED_GAME_REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function defaultState() {
  return { version: 1, guides: [], gameRequests: [] };
}

class LibraryStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.now = options.now || (() => Date.now());
    this.state = defaultState();
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.guides)) {
        throw new Error('data/library.json has an unsupported format.');
      }
      this.state = parsed;
    }
    const nowIso = new Date(this.now()).toISOString();
    let changed = false;
    if (!Array.isArray(this.state.gameRequests)) {
      this.state.gameRequests = [];
      changed = true;
    }
    for (const guide of this.state.guides) {
      if (guide.status === 'queued' || ['searching', 'checking', 'downloading'].includes(guide.status)) {
        guide.status = 'failed';
        guide.message = 'The server stopped before this guide finished. Please request it again.';
        guide.finishedAt = nowIso;
        changed = true;
      }
    }
    if (changed || !fs.existsSync(this.filePath)) this.save();
    return this.state;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }

  add(guide) {
    this.state.guides.push(guide);
    this.save();
    return guide;
  }

  update(id, changes) {
    const guide = this.state.guides.find(item => item.id === id);
    if (!guide) throw new Error(`Unknown guide: ${id}`);
    Object.assign(guide, changes);
    this.save();
    return guide;
  }

  remove(id) {
    const before = this.state.guides.length;
    this.state.guides = this.state.guides.filter(guide => guide.id !== id);
    if (this.state.guides.length !== before) this.save();
  }

  findDuplicate(key) {
    return this.state.guides.find(guide => guide.key === key && ['queued', 'searching', 'checking', 'needs_confirmation', 'downloading', 'complete'].includes(guide.status));
  }

  addGameRequest(request) {
    this.state.gameRequests.push(request);
    this.save();
    return request;
  }

  updateGameRequest(id, changes) {
    const request = this.state.gameRequests.find(item => item.id === id);
    if (!request) throw new Error(`Unknown game request: ${id}`);
    Object.assign(request, changes);
    this.save();
    return request;
  }

  findPendingGameRequest(key) {
    return this.state.gameRequests.find(request => request.key === key && request.status === 'pending');
  }

  cleanup() {
    const now = this.now();
    const kept = [];
    const removed = [];
    for (const guide of this.state.guides) {
      const finished = Date.parse(guide.completedAt || guide.finishedAt || guide.createdAt || 0);
      const expiredComplete = guide.status === 'complete' && Number.isFinite(finished) && now - finished >= COMPLETE_TTL_MS;
      const expiredFailed = guide.status === 'failed' && Number.isFinite(finished) && now - finished >= FAILED_TTL_MS;
      const missingFile = guide.status === 'complete' && (!guide.filePath || !fs.existsSync(guide.filePath));
      if (expiredComplete || expiredFailed || missingFile) {
        if (guide.filePath) fs.rmSync(guide.filePath, { force: true });
        removed.push(guide);
      } else {
        kept.push(guide);
      }
    }
    if (removed.length > 0) {
      this.state.guides = kept;
    }
    const gameRequestCount = this.state.gameRequests.length;
    this.state.gameRequests = this.state.gameRequests.filter(request => {
      if (request.status === 'pending') return true;
      const resolved = Date.parse(request.resolvedAt || 0);
      return !Number.isFinite(resolved) || now - resolved < RESOLVED_GAME_REQUEST_TTL_MS;
    });
    if (removed.length > 0 || this.state.gameRequests.length !== gameRequestCount) this.save();
    return removed;
  }
}

module.exports = { COMPLETE_TTL_MS, FAILED_TTL_MS, RESOLVED_GAME_REQUEST_TTL_MS, LibraryStore, defaultState };
