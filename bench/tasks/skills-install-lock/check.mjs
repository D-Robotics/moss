#!/usr/bin/env node
/**
 * skills-install-lock acceptance: the skill was installed with provenance, the
 * lockfile records a real tree hash, the tree matches the source, and
 * `moss skill lock` in the workspace still passes (the model had to restore
 * after the deliberate drift test instead of leaving it dirty).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const taskDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(taskDir, '..', '..', '..');
const cli = path.join(repoRoot, 'dist', 'cli.js');
const installed = path.join('.moss', 'skills', 'bench-install');

assert.ok(
  fs.existsSync(path.join(installed, 'SKILL.md')),
  'skill was not installed into .moss/skills'
);
assert.ok(
  fs.existsSync(path.join(installed, 'scripts', 'run.sh')),
  'scripts/ was not copied with the skill'
);

const skillText = fs.readFileSync(path.join(installed, 'SKILL.md'), 'utf8');
assert.match(
  skillText,
  /description: install a skill with provenance/,
  'installed body lost the description'
);
assert.doesNotMatch(skillText, /drift probe/, 'the drift-test edit was left in the installed tree');

const lockFile = path.join('.moss', 'skills.lock.json');
assert.ok(fs.existsSync(lockFile), 'skills.lock.json was not written');
const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
const entry = lock.skills?.['bench-install'];
assert.ok(entry, 'lockfile has no bench-install entry');
assert.match(entry.hash, /^sha256:[0-9a-f]{64}$/, 'lockfile hash is not a sha256 of the tree');
assert.equal(entry.kind, 'local', 'lockfile did not record the local source kind');
assert.equal(entry.scope, 'workspace', 'lockfile did not record the workspace scope');
assert.ok(entry.files >= 3, `lockfile recorded too few files: ${entry.files}`);

const source = fs.readFileSync(
  path.join(taskDir, 'files', 'skill-src', 'scripts', 'run.sh'),
  'utf8'
);
assert.equal(
  fs.readFileSync(path.join(installed, 'scripts', 'run.sh'), 'utf8'),
  source,
  'installed scripts/run.sh differs from the source'
);

const verify = spawnSync(process.execPath, [cli, 'skill', 'lock', '--workspace'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 60_000,
});
assert.equal(
  verify.status,
  0,
  `skill lock exited ${verify.status}:\n${verify.stdout}\n${verify.stderr}`
);
assert.match(`${verify.stdout}${verify.stderr}`, /bench-install: ok/);

console.log('check passed');
