#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseCidr } = require('../src/network');
const { LOOPBACK_CLIENTS, writeSettings } = require('../src/settings');

const cidr = String(process.argv[2] || '').trim();
if (!parseCidr(cidr)) {
  console.error('Usage: npm run configure-lan -- 192.168.1.0/24');
  process.exitCode = 2;
} else {
  const target = path.join(__dirname, '..', 'data', 'settings.json');
  writeSettings(target, { version: 1, allowedClients: [...LOOPBACK_CLIENTS, cidr] });
  console.log(`Configured the app to allow LAN clients from ${cidr}`);
  console.log(`Also run: npm run firewall -- add ${cidr}`);
}
