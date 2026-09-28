#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { config } = await import(pathToFileURL('config.js').href);
assert.equal(config.timeoutMs, 5000, 'timeoutMs must default to 5000');
assert.equal(config.retries, 3, 'retries must stay 3');

const md = readFileSync('options.md', 'utf8');
assert.match(md, /retries/);
assert.match(md, /timeoutMs/);
console.log('check passed');
