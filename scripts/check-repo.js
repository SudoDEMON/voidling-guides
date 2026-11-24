#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIRS = ['src', 'public', 'scripts', 'test', 'test-support', '.github', '.forgejo'];
const ROOT_FILES = ['server.js', 'package.json', 'package-lock.json', 'README.md', 'SECURITY.md', 'approved-guides.example.md', '.gitignore'];
const TEXT_EXTENSIONS = new Set(['.js', '.css', '.html', '.json', '.md', '.sh', '.ps1', '.yml', '.yaml']);
const SHEBANG_CLI_SCRIPTS = [
  'server.js',
  'src/doctor.js',
  'scripts/check-repo.js',
  'scripts/configure-firewall.js',
  'scripts/configure-firewall.sh',
  'scripts/configure-lan.js',
  'scripts/install-agy.js',
  'scripts/set-admin-password.js'
];
const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})(?:\s|$)/m;
const TRAILING_WHITESPACE = /[ \t]+$/m;
const PRIVATE_PATTERNS = [
  { label: 'private LAN subnet', pattern: /\b10\.10\.1\./ },
  { label: 'local home path', pattern: /\/home\/void\b/i },
  { label: 'email address', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i }
];

function collectFiles() {
  const files = new Set();
  for (const name of ROOT_FILES) {
    const full = path.join(ROOT_DIR, name);
    if (fs.existsSync(full)) files.add(full);
  }
  const walk = dirPath => {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) files.add(full);
    }
  };
  for (const dir of SOURCE_DIRS) walk(path.join(ROOT_DIR, dir));
  return [...files].sort();
}

const failures = [];
const files = collectFiles();

for (const filePath of files) {
  const rel = path.relative(ROOT_DIR, filePath);
  const content = fs.readFileSync(filePath, 'utf8');

  if (path.extname(filePath) === '.js') {
    const syntax = spawnSync(process.execPath, ['--check', filePath], { encoding: 'utf8' });
    if (syntax.status !== 0) {
      failures.push(`${rel}: JS syntax check failed: ${(syntax.stderr || syntax.stdout).trim()}`);
    }
  }
  if (TRAILING_WHITESPACE.test(content)) {
    failures.push(`${rel}: contains trailing whitespace`);
  }
  if (CONFLICT_MARKER.test(content)) {
    failures.push(`${rel}: contains merge conflict marker`);
  }
  const withoutUrls = content.replace(/https?:\/\/\S+/g, '');
  for (const { label, pattern } of PRIVATE_PATTERNS) {
    const haystack = label === 'email address' ? withoutUrls : content;
    if (pattern.test(haystack)) {
      failures.push(`${rel}: contains ${label}`);
    }
  }
}

if (process.platform !== 'win32') {
  const bashCheck = spawnSync('bash', ['-n', path.join(ROOT_DIR, 'scripts', 'configure-firewall.sh')], { encoding: 'utf8' });
  if (bashCheck.error?.code !== 'ENOENT' && bashCheck.status !== 0) {
    failures.push(`scripts/configure-firewall.sh: bash -n failed: ${(bashCheck.stderr || bashCheck.stdout).trim()}`);
  }
  for (const rel of SHEBANG_CLI_SCRIPTS) {
    const mode = fs.statSync(path.join(ROOT_DIR, rel)).mode;
    if ((mode & 0o111) === 0) {
      failures.push(`${rel}: missing executable permission bit`);
    }
  }
}

if (failures.length > 0) {
  console.error('Repository checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Repo checks passed (${files.length} files verified).`);
}
