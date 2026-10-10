#!/usr/bin/env node
/**
 * Every `rdk-docs-mcp@x.y.z` in the repo is the pinned release. The 2026-10-09
 * audit file is the one exception: it records the version it measured.
 * The npm-latest note is opt-in and does not spawn when the flag is off.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderRdkDocsPinDoctorLine } from '../dist/cli/doctor.js';
import { rdkDocsPinCheckEnabled, rdkDocsPinNote } from '../dist/cli/rdk-docs-pin-check.js';
import {
  DEFAULT_RDK_DOCS_MCP_PACKAGE,
  rdkDocsPinDrift,
  rdkDocsPinnedNpmVersion,
} from '../dist/core/mcp/rdk-docs.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.moss']);
const TEXT_EXT = new Set(['.ts', '.mjs', '.js', '.cjs', '.md', '.json']);
const HISTORICAL_AUDIT = 'docs/superpowers/plans/2026-10-09-rdk-knowledge-via-mcp.md';
const HISTORICAL_VERSION = '0.1.12';
const VERSION_IN_SPEC = /rdk-docs-mcp@(\d+\.\d+\.\d+)/g;

function walk(dir, hits) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, hits);
      continue;
    }
    if (!TEXT_EXT.has(path.extname(entry.name))) continue;
    const rel = path.relative(repoRoot, full).split(path.sep).join('/');
    const text = fs.readFileSync(full, 'utf8');
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      for (const match of lines[index].matchAll(VERSION_IN_SPEC)) {
        hits.push({ file: rel, line: index + 1, version: match[1] });
      }
    }
  }
}

test('every rdk-docs-mcp version string matches the pin', () => {
  const pinned = rdkDocsPinnedNpmVersion();
  assert.equal(DEFAULT_RDK_DOCS_MCP_PACKAGE, `rdk-docs-mcp@${pinned}`);
  const hits = [];
  walk(repoRoot, hits);
  const current = hits.filter(
    (hit) => !(hit.file === HISTORICAL_AUDIT && hit.version === HISTORICAL_VERSION)
  );
  assert.ok(current.length >= 10, `expected the pin to be quoted widely, found ${current.length}`);
  for (const hit of current) {
    assert.equal(
      hit.version,
      pinned,
      `${hit.file}:${hit.line} has rdk-docs-mcp@${hit.version}, pin is ${pinned}`
    );
  }
  assert.ok(
    hits.some((hit) => hit.file === HISTORICAL_AUDIT && hit.version === HISTORICAL_VERSION),
    'the 2026-10-09 audit still records the version it measured'
  );
});

test('pin drift compares semver and does not treat 0.10 as older than 0.9', () => {
  assert.equal(rdkDocsPinDrift('0.3.0', '0.3.0'), 'same');
  assert.equal(rdkDocsPinDrift('0.3.0', '0.4.0'), 'latest-newer');
  assert.equal(rdkDocsPinDrift('0.3.0', '0.3.1'), 'latest-newer');
  assert.equal(rdkDocsPinDrift('0.10.0', '0.9.0'), 'pin-newer');
  assert.equal(rdkDocsPinDrift('0.3.0', 'latest'), 'unparsed');
});

test('rdk-docs pin check stays offline unless MOSS_RDK_DOCS_PIN_CHECK is set', async () => {
  assert.equal(rdkDocsPinCheckEnabled({}), false);
  assert.equal(rdkDocsPinCheckEnabled({ MOSS_RDK_DOCS_PIN_CHECK: '0' }), false);
  assert.equal(rdkDocsPinCheckEnabled({ MOSS_RDK_DOCS_PIN_CHECK: '1' }), true);
  let calls = 0;
  const lookup = async () => {
    calls += 1;
    return { version: '9.9.9' };
  };
  assert.equal(await rdkDocsPinNote({}, lookup), undefined);
  assert.equal(calls, 0, 'a disabled check must not call npm');

  const behind = await rdkDocsPinNote({ MOSS_RDK_DOCS_PIN_CHECK: '1' }, lookup);
  assert.equal(calls, 1);
  assert.equal(behind?.kind, 'latest-newer');
  const behindLine = renderRdkDocsPinDoctorLine(behind);
  assert.match(behindLine, /^  warn  rdk-docs/);
  assert.match(behindLine, /9\.9\.9/);
  assert.doesNotMatch(behindLine, /^  fail /);

  const same = await rdkDocsPinNote({ MOSS_RDK_DOCS_PIN_CHECK: 'true' }, async () => ({
    version: rdkDocsPinnedNpmVersion(),
  }));
  assert.equal(same?.kind, 'current');
  assert.match(renderRdkDocsPinDoctorLine(same), /^  ok    rdk-docs/);

  const missed = await rdkDocsPinNote({ MOSS_RDK_DOCS_PIN_CHECK: 'on' }, async () => ({
    error: 'registry unreachable',
  }));
  assert.equal(missed?.kind, 'unchecked');
  const missedLine = renderRdkDocsPinDoctorLine(missed);
  assert.match(missedLine, /^  warn  rdk-docs/);
  assert.match(missedLine, /registry unreachable/);
  assert.doesNotMatch(missedLine, /^  fail /);
});
