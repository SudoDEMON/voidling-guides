import fs from 'node:fs';
import path from 'node:path';
import { run } from './process.js';

export const DIRECT_WEBM_FORMAT = 'bv*[vcodec^=vp9][ext=webm]+ba[acodec^=opus][ext=webm]/bv*[ext=webm]+ba[ext=webm]/b[ext=webm]';

const TERMINAL_DOWNLOAD_ERROR = /Video unavailable|Private video|Sign in to confirm|HTTP Error (?:403|404|429)|Unable to download webpage/i;

function shouldFallbackToTranscode(error) {
  if (!error) return false;
  if (error.timedOut || error.signal) return false;
  const details = `${error.message || ''}\n${error.stderr || ''}`;
  return !TERMINAL_DOWNLOAD_ERROR.test(details);
}

export async function probeWebm(filePath, options = {}) {
  const result = await (options.run || run)('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', filePath
  ], { timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const data = JSON.parse(result.stdout);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  if (!streams.some(stream => stream.codec_type === 'video')) throw new Error('Downloaded guide has no video stream.');
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size === 0) throw new Error('Downloaded guide is empty.');
  return {
    duration: Number(data.format && data.format.duration || 0),
    size: stat.size,
    codecs: streams.map(stream => stream.codec_name).filter(Boolean)
  };
}

async function directWebm(url, target, runImpl, onOutput) {
  await runImpl('yt-dlp', [
    '--force-ipv4', '--socket-timeout', '15', '--no-playlist', '--force-overwrites',
    '-f', DIRECT_WEBM_FORMAT, '--merge-output-format', 'webm', '-o', target, url
  ], { timeoutMs: 24 * 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, onOutput });
}

async function transcodedWebm(url, target, workDir, runImpl, onOutput) {
  const source = path.join(workDir, 'source.mp4');
  await runImpl('yt-dlp', [
    '--force-ipv4', '--socket-timeout', '15', '--no-playlist', '--force-overwrites',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/best',
    '--merge-output-format', 'mp4', '-o', source, url
  ], { timeoutMs: 24 * 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, onOutput });
  await runImpl('ffmpeg', [
    '-y', '-i', source, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libvpx-vp9', '-crf', '34', '-b:v', '0', '-deadline', 'good',
    '-cpu-used', '5', '-row-mt', '1', '-threads', '0', '-tile-columns', '2',
    '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '128k', target
  ], { timeoutMs: 24 * 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, onOutput });
}

export async function convertGuide({ url, outputPath, overwrite = false, onOutput, run: runOverride }) {
  const runImpl = runOverride || run;
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  if (!overwrite && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return probeWebm(outputPath, { run: runImpl });
  }

  const workDir = fs.mkdtempSync(path.join(outputDir, '.job-'));
  const partial = path.join(workDir, 'guide.webm');
  try {
    try {
      await directWebm(url, partial, runImpl, onOutput);
    } catch (directError) {
      if (!shouldFallbackToTranscode(directError)) throw directError;
      if (onOutput) onOutput('stderr', `Compatible WebM streams were unavailable (${directError.message}); transcoding the best source.\n`);
      await transcodedWebm(url, partial, workDir, runImpl, onOutput);
    }
    const info = await probeWebm(partial, { run: runImpl });
    fs.renameSync(partial, outputPath);
    return info;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
