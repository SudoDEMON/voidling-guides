import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function findAgy({ platform = process.platform, env = process.env, run = spawnSync } = {}) {
  const candidates = ['agy'];
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(local, 'Microsoft', 'WinGet', 'Links', 'agy.exe'),
      path.join(local, 'agy', 'bin', 'agy.exe')
    );
  } else if (platform === 'linux' || platform === 'darwin') {
    candidates.push(path.join(env.HOME || os.homedir(), '.local', 'bin', 'agy'));
  }
  let probe;
  for (const command of candidates) {
    probe = { command, result: run(command, ['--version'], { env, encoding: 'utf8', timeout: 5000 }) };
    if (probe.result.error?.code !== 'ENOENT') return probe;
  }
  return probe;
}

export function resolveAgyCommand(options = {}) {
  const probe = findAgy(options);
  return !probe?.result?.error && probe?.result?.status === 0 ? probe.command : 'agy';
}
