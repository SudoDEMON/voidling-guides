#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCidr } from '../src/network.js';
import { LOOPBACK_CLIENTS, writeSettings } from '../src/settings.js';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cidr = String(process.argv[2] || '').trim();
if (!parseCidr(cidr)) {
  console.error('Usage: npm run configure-lan -- 192.168.1.0/24');
  process.exitCode = 2;
} else {
  const target = path.join(ROOT_DIR, 'data', 'settings.json');
  writeSettings(target, { version: 1, allowedClients: [...LOOPBACK_CLIENTS, cidr] });
  console.log(`Configured the app to allow LAN clients from ${cidr}`);
  console.log(`Also run: npm run firewall -- add ${cidr}`);
}
