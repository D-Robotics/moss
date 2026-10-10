#!/usr/bin/env node
/**
 * `moss -p` must not print a gateway key fragment or LiteLLM key hash.
 * The user-facing line is localized and keeps the redacted gateway text.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactEgress } from '../dist/safety/tool-output-redact.js';
import { trackTempDir } from './helpers/temp-home.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(repoRoot, 'dist', 'cli.js');
const KEY = 'sk-fake-key-000';
const HASH = 'f00dbeefcafe';

{
  const raw = `Authentication Error, Received API Key = ${KEY}, Key Hash (Token) =${HASH}`;
  const redacted = redactEgress(raw);
  assert.match(redacted, /Received API Key = \[REDACTED\]/);
  assert.match(redacted, /Key Hash \(Token\) =\[REDACTED\]/);
  assert.doesNotMatch(redacted, new RegExp(KEY));
  assert.doesNotMatch(redacted, new RegExp(HASH));
}

const body = `Authentication Error, Received API Key = ${KEY}, Key Hash (Token) =${HASH}`;
const server = http.createServer((req, res) => {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: body } }));
});
const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const home = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-print-redact-')));
const configDir = path.join(home, 'config');
const workspace = trackTempDir(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-print-redact-ws-')));
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  `${JSON.stringify(
    {
      provider: 'openai-compatible',
      model: 'stub-alpha',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: KEY,
    },
    null,
    2
  )}\n`
);

const child = spawn(process.execPath, [cli, '-p', 'hi', '-C', workspace], {
  cwd: workspace,
  env: {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: os.tmpdir(),
    LANG: 'zh_CN.UTF-8',
    LC_ALL: 'zh_CN.UTF-8',
    TERM: 'dumb',
    MOSS_CONFIG_DIR: configDir,
    MOSS_NO_TUI: '1',
    MOSS_NO_BUNDLED_DEFAULT: '1',
    NO_COLOR: '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
child.stdin.end();
const status = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    resolve(1);
  }, 40_000);
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve(code ?? 1);
  });
});
await new Promise((resolve) => server.close(() => resolve()));

const combined = `${stdout}\n${stderr}`;
assert.notEqual(status, 0, combined.slice(-1500));
assert.match(stderr, /错误：/);
assert.match(stderr, /密钥被拒绝（401）/);
assert.match(stderr, /网关原文：/);
assert.match(stderr, /Key Hash \(Token\) =\[REDACTED\]/);
assert.doesNotMatch(stderr, /Key Has\nh/);
assert.doesNotMatch(stderr, /captive portal or proxy login page/);
assert.doesNotMatch(stderr, /✗ error/);
assert.doesNotMatch(stderr, /retryable/);
assert.doesNotMatch(stderr, /provider returned HTTP/);
assert.doesNotMatch(stderr, /check your API key/);
assert.doesNotMatch(combined, new RegExp(KEY));
assert.doesNotMatch(combined, new RegExp(HASH));
assert.doesNotMatch(combined, /流在处理事件之后抛出/);
assert.doesNotMatch(combined, /gateway API error unknown/);

console.log('[PASS] cli-print-redact');
