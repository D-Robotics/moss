#!/usr/bin/env node
/**
 * O148: PowerShell nested execution deeper than one level was silently
 * ignored by the write-target scanner — `& { & { Set-Content <config> x } }`
 * resolved nothing (no hit, no unresolved marker), so a write hidden two or
 * more wrappers deep escaped the gate. The scanner now recurses to a bounded
 * depth and reports anything deeper as unresolved (fail-closed: the caller
 * prompts / refuses instead of silently allowing).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findPwshWriteTargets } from '../dist/safety/pwsh-write-targets.js';
import { findShellProtectedWrites } from '../dist/safety/protected-paths.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o148-'));
const profile = path.join(root, 'profile');
const cfg = path.join(profile, 'AppData', 'Roaming', 'moss');
const ws = path.join(root, 'ws');
for (const d of [cfg, ws]) fs.mkdirSync(d, { recursive: true });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const CFG = path.join(cfg, 'config.json').replace(/\\/g, '/');
const fwd = (s) => s.replace(/\\/g, '/');
const env = { USERPROFILE: profile, HOME: profile, APPDATA: path.dirname(cfg), PATH: '/usr/bin' };
const ctx = { cwd: ws, workspaceRoot: ws, configDirs: [cfg], env, home: profile };
const scan = (cmd) => findPwshWriteTargets(cmd, ctx);
const hasCfg = (r) => r.resolved.some((p) => fwd(p) === fwd(CFG));

test('depth 1 (baseline): & { Set-Content <config> } resolves the target', () => {
  assert.equal(hasCfg(scan(`& { Set-Content '${CFG}' x }`)), true);
});

test('depth 2: & { & { Set-Content <config> } } resolves the target', () => {
  const r = scan(`& { & { Set-Content '${CFG}' x } }`);
  assert.equal(hasCfg(r), true, JSON.stringify(r));
});

test('depth 3: three wrappers still resolve the target', () => {
  const r = scan(`& { & { & { Set-Content '${CFG}' x } } }`);
  assert.equal(hasCfg(r), true, JSON.stringify(r));
});

test('depth 2 through iex: iex "& { Set-Content <config> }" resolves', () => {
  const r = scan(`iex "& { Set-Content '${CFG}' x }"`);
  assert.equal(hasCfg(r), true, JSON.stringify(r));
});

test('deeper than the cap fails closed instead of being ignored', () => {
  const deep = `& { & { & { & { Set-Content '${CFG}' x } } } }`;
  const r = scan(deep);
  assert.ok(r.unresolved.length > 0, `unresolved marker expected; ${JSON.stringify(r)}`);
  // End to end: deep nesting must produce a gate hit — either the resolved
  // target itself or the fail-closed unresolved marker, never silence.
  const hits = findShellProtectedWrites(deep, ctx);
  assert.ok(hits.length > 0, 'deep nesting must produce a protected-path hit');
  assert.equal(
    hits.some((h) => h.category === 'unresolved' || h.category === 'moss-config'),
    true,
    JSON.stringify(hits)
  );
});

test('a deeply nested BENIGN body still fails closed (stricter only)', () => {
  const deep = `& { & { & { & { Write-Host hi } } } }`;
  assert.ok(scan(deep).unresolved.length > 0);
});

test('no false hits for ordinary one-level reads', () => {
  const r = scan(`& { Get-Content '${CFG}' }`);
  assert.equal(hasCfg(r), false);
  assert.equal(r.unresolved.length, 0);
});
