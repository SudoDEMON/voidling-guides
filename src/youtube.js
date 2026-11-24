import { HttpError } from './fs-utils.js';

export const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function canonicalYouTubeUrl(id) {
  if (!YOUTUBE_ID.test(String(id || ''))) {
    throw new HttpError(400, 'Invalid YouTube video ID.');
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

export function extractYouTubeId(value) {
  try {
    const url = new URL(String(value || '').trim());
    const host = url.hostname.replace(/^www\./, '');
    const id = host === 'youtu.be'
      ? url.pathname.split('/').filter(Boolean)[0]
      : (host === 'youtube.com' || host.endsWith('.youtube.com') ? url.searchParams.get('v') : '');
    return YOUTUBE_ID.test(id || '') ? id : '';
  } catch {
    return '';
  }
}

export function isSafeSubtitleUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    return /(?:^|\.)youtube\.com$/i.test(url.hostname) || /(?:^|\.)googlevideo\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}
