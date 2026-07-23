'use strict';

const { spawn } = require('child_process');

class ProcessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProcessError';
    Object.assign(this, details);
  }
}

function signalTree(child, signal) {
  if (!child || !child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || 60_000;
  const maxBuffer = options.maxBuffer || 16 * 1024 * 1024;
  const cwd = options.cwd || process.cwd();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const collect = (stream, chunk) => {
      const text = chunk.toString();
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > maxBuffer) {
        signalTree(child, 'SIGKILL');
      }
      if (options.onOutput) options.onOutput(stream, text);
    };

    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProcessError(`${command} could not start: ${error.message}`, { command, args, cause: error }));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new ProcessError(`${command} timed out.`, { command, args, code, signal, stdout, stderr, timedOut: true }));
      } else if (code !== 0) {
        reject(new ProcessError(`${command} exited with code ${code}.`, { command, args, code, signal, stdout, stderr }));
      } else {
        resolve({ stdout, stderr, code, signal });
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      signalTree(child, 'SIGTERM');
      const killTimer = setTimeout(() => signalTree(child, 'SIGKILL'), 3000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

module.exports = { ProcessError, run };
