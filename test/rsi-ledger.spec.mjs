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
    parent: null,
    hypothesis: null,
    prediction: null,
    predictionHeld: null,
    changedPaths: null,
    dev: { score: null, baseline: null, deltaS: null },
    holdout: { score: null, band: null },
    cost: { tokens: null, usd: null, wallMin: null },
    decision: null,
  };
}

test('committed rounds 1-2 backfill has null scores and a null prediction', () => {
  const entries = loadLedger(ledgerPath);
  assert.equal(entries.length, 1);
  const row = entries[0];
  assert.equal(row.round, '1-2');
  assert.equal(row.decision, 'merged');
  assert.equal(row.parent, null);
  assert.equal(row.prediction, null);
  assert.equal(row.predictionHeld, null);
  assert.equal(row.dev.hardScore, null);
  assert.equal(row.holdout.score, null);
  assert.equal(row.cost.tokens, null);
  assert.ok(Array.isArray(row.changedPaths));
  assert.ok(row.changedPaths.length > 0);
  const numbers = row.prs.map((pr) => pr.number).sort((a, b) => a - b);
  assert.deepEqual(numbers, [2, 3, 4, 5, 6]);
});

test('append requires a prediction object and rejects a duplicate round', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-ledger-'));
  const file = path.join(dir, 'ledger.jsonl');
  appendEntry(file, blankEntry(3));
  assert.equal(loadLedger(file).length, 1);
  assert.throws(() => appendEntry(file, blankEntry(3)), /duplicate round/);
  assert.throws(() => validateEntry({ round: 4 }), /missing/);
  const bad = blankEntry(5);
  bad.prediction = { tasks: [], why: '' };
  assert.throws(() => validateEntry(bad), /prediction/);
  const leaked = blankEntry(6);
  leaked.apiKey = 'must-not-enter-ledger';
  assert.throws(() => validateEntry(leaked), /sensitive data/);
  const checked = blankEntry(7);
  checked.prediction = { tasks: ['safety-boundary'], why: 'the check should pass more often' };
  checked.predictionHeld = false;
  checked.decision = 'reject';
  appendEntry(file, checked);
  assert.equal(loadLedger(file)[1].predictionHeld, false);
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
