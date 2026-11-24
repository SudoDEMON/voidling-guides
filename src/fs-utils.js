import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class HttpError extends Error {
  constructor(statusCode, message, options) {
    super(message, options);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

export function writeFileAtomic(filePath, content, { mode = 0o600 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.renameSync(temporary, filePath);
    try {
      fs.chmodSync(filePath, mode);
    } catch (error) {
      if (!['ENOTSUP', 'ENOSYS'].includes(error?.code)) throw error;
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function isWithinDirectory(rootPath, targetPath) {
  if (!rootPath || !targetPath) return false;
  const root = path.resolve(rootPath);
  const target = path.resolve(targetPath);
  return target.startsWith(`${root}${path.sep}`);
}

export function isMainModule(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}
