#!/usr/bin/env node
/**
 * Ledger schema: the committed backfill parses, and append rejects a bad or duplicate row.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendEntry, loadLedger, validateEntry } from '../scripts/rsi/ledger.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = path.join(repoRoot, '.rsi/ledger.jsonl');

function blankEntry(round) {
  return {
    round,
    branch: null,
    baseSha: null,
    headSha: null,
    backlogItem: null,
    hypothesis: null,
    changedPaths: null,
    tier: null,
    gates: { G0: null, G1: null, G2: null, G3: null, G4: null, G5: null, G6: null, G7: null },
    dev: { hardScore: null, weighted: null },
    holdout: { score: null, band: null },
    cost: { tokens: null, usd: null, wallMin: null },
    reviewer: { model: null, verdict: null },
    decision: null,
  };
}

test('committed rounds 1-2 backfill has null scores', () => {
  const entries = loadLedger(ledgerPath);
  assert.equal(entries.length, 1);
  const row = entries[0];
  assert.equal(row.round, '1-2');
  assert.equal(row.decision, 'merged');
  assert.equal(row.dev.hardScore, null);
  assert.equal(row.dev.weighted, null);
  assert.equal(row.holdout.score, null);
  assert.equal(row.holdout.band, null);
  assert.equal(row.cost.tokens, null);
  assert.equal(row.cost.usd, null);
  assert.equal(row.cost.wallMin, null);
  assert.equal(row.reviewer.model, null);
  assert.equal(row.reviewer.verdict, null);
  assert.ok(Array.isArray(row.changedPaths));
  assert.ok(row.changedPaths.length > 0);
  const numbers = row.prs.map((pr) => pr.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [2, 3, 4, 5, 6]);
});

test('append validates and rejects a duplicate round', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-ledger-'));
  const file = path.join(dir, 'ledger.jsonl');
  appendEntry(file, blankEntry(3));
  assert.equal(loadLedger(file).length, 1);
  assert.throws(() => appendEntry(file, blankEntry(3)), /duplicate round/);
  assert.throws(() => validateEntry({ round: 4 }), /missing/);
  const bad = blankEntry(5);
  bad.tier = 'C';
  assert.throws(() => validateEntry(bad), /tier/);
});

test('ledger CLI refuses when RSI is disabled', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts/rsi/ledger.mjs'), '--validate'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, MOSS_RSI_DISABLED: '1' },
    }
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /MOSS_RSI_DISABLED=1/);
});
