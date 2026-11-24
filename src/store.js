import fs from 'node:fs';
import path from 'node:path';
import { isWithinDirectory, writeFileAtomic } from './fs-utils.js';

export const COMPLETE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FAILED_TTL_MS = 24 * 60 * 60 * 1000;
export const BUSY_STATUSES = new Set(['queued', 'searching', 'checking', 'downloading']);
export const ACTIVE_DUPLICATE_STATUSES = new Set([...BUSY_STATUSES, 'needs_confirmation', 'complete']);

function defaultState() {
  return { version: 1, guides: [], gameRequests: [] };
}

function normalizeSelection(selection) {
  if (!selection || typeof selection !== 'object') return selection;
  if (selection.canonicalGuide === undefined && selection.canonicalBadge !== undefined) {
    const next = { ...selection, canonicalGuide: selection.canonicalBadge };
    delete next.canonicalBadge;
    return next;
  }
  return selection;
}

function normalizeGuideRecord(record) {
  let changed = false;
  if (record.guide === undefined && record.badge !== undefined) {
    record.guide = record.badge;
    delete record.badge;
    changed = true;
  }
  if (record.suggestedGuide === undefined && record.suggestedBadge !== undefined) {
    record.suggestedGuide = record.suggestedBadge;
    delete record.suggestedBadge;
    changed = true;
  }
  if (record.pendingSelection?.canonicalBadge !== undefined && record.pendingSelection.canonicalGuide === undefined) {
    record.pendingSelection = normalizeSelection(record.pendingSelection);
    changed = true;
  }
  if (record.approvedSelection?.canonicalBadge !== undefined && record.approvedSelection.canonicalGuide === undefined) {
    record.approvedSelection = normalizeSelection(record.approvedSelection);
    changed = true;
  }
  return changed;
}

function removeManagedFile(videosRoot, filePath) {
  if (!isWithinDirectory(videosRoot, filePath)) return;
  fs.rmSync(filePath, { force: true });
  const parent = path.dirname(filePath);
  if (isWithinDirectory(videosRoot, parent)) {
    try {
      fs.rmdirSync(parent);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
  }
}

function sweepVideoOrphans(videosRoot, now, minOrphanAgeMs) {
  if (!fs.existsSync(videosRoot)) return;
  const dirs = fs.readdirSync(videosRoot, { withFileTypes: true }).filter(entry => entry.isDirectory());
  for (const dirEntry of dirs) {
    const dirPath = path.join(videosRoot, dirEntry.name);
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const target = path.join(dirPath, entry.name);
      if (!isWithinDirectory(videosRoot, target)) continue;
      if (entry.isDirectory() && entry.name.startsWith('.job-')) {
        const stat = minOrphanAgeMs > 0 ? fs.statSync(target, { throwIfNoEntry: false }) : null;
        if (minOrphanAgeMs <= 0 || (stat && now - stat.mtimeMs >= minOrphanAgeMs)) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } else if (entry.isFile() && entry.name.includes('.part')) {
        const stat = minOrphanAgeMs > 0 ? fs.statSync(target, { throwIfNoEntry: false }) : null;
        if (minOrphanAgeMs <= 0 || (stat && now - stat.mtimeMs >= minOrphanAgeMs)) {
          fs.rmSync(target, { force: true });
        }
      }
    }
    try {
      if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
  }
}

export class LibraryStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.videosRoot = options.videosRoot || path.join(path.dirname(filePath), 'videos');
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
      if (normalizeGuideRecord(guide)) changed = true;
      if (BUSY_STATUSES.has(guide.status)) {
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
    writeFileAtomic(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
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
    const removed = this.state.guides.find(guide => guide.id === id) || null;
    this.state.guides = this.state.guides.filter(guide => guide.id !== id);
    if (removed) this.save();
    return removed;
  }

  findDuplicate(key) {
    return this.state.guides.find(guide => guide.key === key && ACTIVE_DUPLICATE_STATUSES.has(guide.status));
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

  removeGameRequest(id) {
    const removed = this.state.gameRequests.find(request => request.id === id) || null;
    this.state.gameRequests = this.state.gameRequests.filter(request => request.id !== id);
    if (removed) this.save();
    return removed;
  }

  findPendingGameRequest(key) {
    return this.state.gameRequests.find(request => request.key === key && request.status === 'pending');
  }

  cleanup({ sweepOrphans = false, minOrphanAgeMs = 5 * 60 * 1000 } = {}) {
    const now = this.now();
    const kept = [];
    const removed = [];
    for (const guide of this.state.guides) {
      const finished = Date.parse(guide.completedAt || guide.finishedAt || guide.createdAt || 0);
      const expiredComplete = guide.status === 'complete' && Number.isFinite(finished) && now - finished >= COMPLETE_TTL_MS;
      const expiredFailed = guide.status === 'failed' && Number.isFinite(finished) && now - finished >= FAILED_TTL_MS;
      const missingFile = guide.status === 'complete' && (!guide.filePath || !fs.existsSync(guide.filePath));
      if (expiredComplete || expiredFailed || missingFile) {
        if (guide.filePath) removeManagedFile(this.videosRoot, guide.filePath);
        removed.push(guide);
      } else {
        kept.push(guide);
      }
    }
    if (removed.length > 0) {
      this.state.guides = kept;
      this.save();
    }
    if (sweepOrphans) {
      sweepVideoOrphans(this.videosRoot, now, minOrphanAgeMs);
    }
    return removed;
  }
}
