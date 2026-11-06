#!/usr/bin/env node
/**
 * Composer hint probe (offline, B191).
 *
 * The empty-composer hint says what this workspace is. A dev checkout's `.env`
 * (device host) used to leak its board into every folder, so unrelated projects
 * offered "stream the camera" first. The device host now only makes a workspace
 * a board when it comes from the project itself or the real process environment.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);
const composer = await load('cli/composer-placeholder.js');
const startup = await load('utils/startup-env.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[composer-hint] ok ${name}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-composer-'));
const workspace = path.join(tmp, 'project');
fs.mkdirSync(workspace, { recursive: true });
const envWith = (host) => ({ MOSS_DEVICE_HOST: host });

// 1. Real process env (no dotenv origin) still means board.
assert.equal(
  composer.detectComposerProjectKind({ workspaceDir: workspace, env: envWith('board.local') }),
  'board'
);
// 2. A foreign checkout `.env` (not this project, not an ancestor) must not leak.
startup.recordDotenvOrigin('MOSS_DEVICE_HOST', path.join(root, '.env'), false);
assert.equal(
  composer.detectComposerProjectKind({ workspaceDir: workspace, env: envWith('board.local') }),
  'general',
  'a checkout .env must not make an unrelated folder a board'
);
// 3. The project's own `.env` does make it a board.
fs.writeFileSync(path.join(workspace, '.env'), 'MOSS_DEVICE_HOST=board.local\n');
startup.recordDotenvOrigin('MOSS_DEVICE_HOST', path.join(workspace, '.env'), false);
assert.equal(
  composer.detectComposerProjectKind({ workspaceDir: workspace, env: envWith('board.local') }),
  'board'
);
// 4. Workspace kind still drives the hint when there is no device.
const codeWs = path.join(tmp, 'code');
fs.mkdirSync(codeWs, { recursive: true });
fs.writeFileSync(path.join(codeWs, 'package.json'), '{}\n');
assert.equal(composer.detectComposerProjectKind({ workspaceDir: codeWs, env: {} }), 'code');
assert.equal(composer.detectComposerProjectKind({ workspaceDir: workspace, env: {} }), 'general');
ok('device hint follows project env (not a checkout .env); code/general still detected');

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`[composer-hint] ${checks}/${checks} checks passed`);
