#!/usr/bin/env node
'use strict';

const path = require('path');
const { writePassword } = require('../src/admin-auth');

function secretPrompt(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal.');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(label);
    process.stdin.setEncoding('utf8');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = chunk => {
      for (const character of chunk) {
        if (character === '\u0003') return finish(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (character >= ' ') {
          value += character;
          process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

(async () => {
  const first = await secretPrompt('New Dad password: ');
  const second = await secretPrompt('Confirm Dad password: ');
  if (first !== second) throw new Error('Passwords did not match.');
  const target = path.join(__dirname, '..', 'data', 'admin-auth.json');
  writePassword(target, first);
  console.log(`Dad password saved securely in ${target}`);
  console.log('Open http://127.0.0.1:3002/dad on this computer.');
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
