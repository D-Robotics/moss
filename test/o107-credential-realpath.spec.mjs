#!/usr/bin/env node
/**
 * O107: symlink / realpath follow-up to O105 (#100).
 * `isMossCredentialPath` must classify a workspace symlink whose realpath
 * lands on `.moss/config.json`, `.moss/devices.json`, `~/.moss/*`,
 * `~/.config/moss/*`, or `.apikey-key` as credential so direct
 * `readFileTool.execute` redacts (no plaintext bypass).
 *
 * Red-on-revert: drop the realpathOfNearestAncestor follow in
 * `src/safety/read-scope.ts` `isMossCredentialPath` → symlink→config asserts fail.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFileTool } from '../dist/tools/file-tools.js';
import { isMossCredentialPath } from '../dist/safety/read-scope.js';

const SECRET = 'sk-O107FAKE0000000000000000000001';
const PLAIN = 'o107-plain-secret-must-not-leak-XYZ';
const NOTE = 'ordinary notes stay readable for O107';

function ctx(workspaceDir) {
  return {
    workspaceDir,
    sessionKey: 'o107',
    abortSignal: new AbortController().signal,
  };
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-o107-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(ws, '.moss'), { recursive: true });
  await fs.mkdir(path.join(home, '.moss'), { recursive: true });
  await fs.mkdir(path.join(home, '.config', 'moss'), { recursive: true });
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.USERPROFILE;
  });
  return { root, home, ws };
}

function assertNoSecret(text, label) {
  const s = String(text);
  assert.ok(!s.includes(SECRET), `${label}: sk- secret absent`);
  assert.ok(!s.includes(PLAIN), `${label}: plain secret absent`);
}

test('O107: symlink → project .moss/config.json is credential and redacts on execute', async (t) => {
  const { ws } = await setup(t);
  const target = path.join(ws, '.moss', 'config.json');
  await fs.writeFile(
    target,
    JSON.stringify(
      { provider: 'openai-compatible', model: 'test-model', apiKey: SECRET },
      null,
      2
    ) + '\n'
  );
  const link = path.join(ws, 'config-link.json');
  await fs.symlink(target, link);
  assert.equal(isMossCredentialPath(link), true, 'symlink path is credential');
  assert.equal(isMossCredentialPath(path.join(ws, '.moss', 'config.json')), true);
  const out = await readFileTool.execute({ path: 'config-link.json' }, ctx(ws));
  assert.doesNotMatch(String(out), /denied|Command blocked/i);
  assert.match(String(out), /openai-compatible/);
  assert.match(String(out), /test-model/);
  assertNoSecret(out, 'symlink→config execute');
  assert.match(String(out), /\[REDACTED\]/);
});

test('O107: symlink → project .moss/devices.json redacts password on execute', async (t) => {
  const { ws } = await setup(t);
  const target = path.join(ws, '.moss', 'devices.json');
  await fs.writeFile(
    target,
    JSON.stringify({ devices: [{ host: 'board.local', password: PLAIN }] }, null, 2) + '\n'
  );
  const link = path.join(ws, 'devices-link.json');
  await fs.symlink(target, link);
  assert.equal(isMossCredentialPath(link), true);
  const out = await readFileTool.execute({ path: 'devices-link.json' }, ctx(ws));
  assert.ok(!String(out).includes(PLAIN), 'device password absent');
  assert.match(String(out), /board\.local/);
  assert.match(String(out), /\[REDACTED\]/);
});

test('O107: symlink → ordinary notes.txt is not credential; plaintext stays', async (t) => {
  const { ws } = await setup(t);
  const notes = path.join(ws, 'notes.txt');
  await fs.writeFile(notes, `${NOTE}\n`);
  const link = path.join(ws, 'notes-link.txt');
  await fs.symlink(notes, link);
  assert.equal(isMossCredentialPath(link), false);
  assert.equal(isMossCredentialPath(notes), false);
  const out = await readFileTool.execute({ path: 'notes-link.txt' }, ctx(ws));
  assert.match(String(out), new RegExp(NOTE));
});

test('O107: symlink → ~/.moss/config.json and ~/.config/moss/config.json', async (t) => {
  const { home, ws } = await setup(t);
  const body = JSON.stringify({ apiKey: SECRET, provider: 'openai-compatible' }, null, 2) + '\n';
  const targets = [
    path.join(home, '.moss', 'config.json'),
    path.join(home, '.config', 'moss', 'config.json'),
  ];
  for (const [i, target] of targets.entries()) {
    await fs.writeFile(target, body);
    const link = path.join(ws, `home-config-link-${i}.json`);
    await fs.symlink(target, link);
    assert.equal(isMossCredentialPath(link), true, link);
    const out = await readFileTool.execute({ path: path.basename(link) }, ctx(ws));
    assertNoSecret(out, `home symlink ${i}`);
    assert.match(String(out), /openai-compatible/);
    assert.match(String(out), /\[REDACTED\]/);
  }
});

test('O107: symlink → .apikey-key withholds on execute', async (t) => {
  const { home, ws } = await setup(t);
  const keyPath = path.join(home, '.moss', '.apikey-key');
  await fs.writeFile(keyPath, `${PLAIN}\n`);
  const link = path.join(ws, 'key-link');
  await fs.symlink(keyPath, link);
  assert.equal(isMossCredentialPath(link), true);
  const out = await readFileTool.execute({ path: 'key-link' }, ctx(ws));
  assertNoSecret(out, 'symlink→.apikey-key');
  assert.match(String(out), /Moss credential values withheld/);
});

test('O107: dangling symlink to missing ordinary file is not credential', async (t) => {
  const { ws } = await setup(t);
  const link = path.join(ws, 'dangling-ordinary');
  await fs.symlink(path.join(ws, 'missing-notes.txt'), link);
  assert.equal(isMossCredentialPath(link), false);
});

test('O107: dangling symlink into .moss/config.json still classifies as credential', async (t) => {
  const { ws } = await setup(t);
  // .moss exists; config.json does not — nearest-ancestor realpath rejoins the tail.
  const link = path.join(ws, 'dangling-config');
  await fs.symlink(path.join(ws, '.moss', 'config.json'), link);
  assert.equal(isMossCredentialPath(link), true);
});

test('O107 revert-red: without realpath follow, symlink→config would leak', async (t) => {
  /**
   * Documents the regression this PR closes. Lexical-only classification
   * (pre-O107) must NOT treat a workspace symlink as credential.
   * If this assert fails, someone reintroduced lexical-only gating incorrectly
   * into a helper — or the test fixture is wrong.
   */
  const { ws } = await setup(t);
  const target = path.join(ws, '.moss', 'config.json');
  await fs.writeFile(
    target,
    JSON.stringify({ apiKey: SECRET, provider: 'openai-compatible' }, null, 2) + '\n'
  );
  const link = path.join(ws, 'leak-link.json');
  await fs.symlink(target, link);
  // Lexical shape of the link path: not under .moss, basename not credential.
  const abs = path.resolve(link);
  assert.notEqual(path.basename(path.dirname(abs)), '.moss');
  assert.notEqual(path.basename(abs), 'config.json');
  assert.notEqual(path.basename(abs), '.apikey-key');
  // Full classifier (with realpath) must still catch it.
  assert.equal(isMossCredentialPath(link), true);
  // And execute must not leak (the product gate).
  const out = await readFileTool.execute({ path: 'leak-link.json' }, ctx(ws));
  assertNoSecret(out, 'revert-red product gate');
  // Source must still contain the realpath follow (static smoke for revert-red).
  const { fileURLToPath } = await import('node:url');
  const src = fssync.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'safety', 'read-scope.ts'),
    'utf8'
  );
  assert.match(src, /realpathSync\.native/, 'realpath follow present in source');
  assert.match(src, /realpathOfNearestAncestor/, 'nearest-ancestor helper present');
});
