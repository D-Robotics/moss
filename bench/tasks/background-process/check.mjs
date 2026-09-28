#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const log = readFileSync('server.log', 'utf8');
assert.ok(log.includes('ready'), 'server.log must contain the ready line');

const pid = Number(readFileSync('server.pid', 'utf8').trim());
assert.ok(Number.isInteger(pid) && pid > 0, 'server.pid must hold a pid');

let alive = true;
try {
  process.kill(pid, 0);
} catch (err) {
  alive = err.code !== 'ESRCH';
}
assert.ok(!alive, `process ${pid} must not be alive when the check runs`);
console.log('check passed');
