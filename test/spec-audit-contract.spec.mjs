#!/usr/bin/env node
/**
 * Spec-audit honesty contract (v0.11 S3) — prompt-layer lock.
 * The contract must survive in BOTH prompt variants; removing it is a
 * deliberate capability decision, not an accidental cleanup.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSoftwareEngineeringPrompt,
  buildSoftwareEngineeringPromptQuick,
} from '../dist/contracts/prompts/software-engineering-prompt.js';

test('full prompt carries the spec-audit honesty contract', () => {
  const p = buildSoftwareEngineeringPrompt();
  assert.match(p, /Spec audit before implementation/, 'section present');
  assert.match(p, /mutually exclusive/, 'pairwise contradiction check described');
  assert.match(p, /stale/i, 'stale-spec guidance present');
  assert.match(p, /does not reproduce/, 'unreproducible-bug guidance present');
  assert.match(p, /SPEC-AUDIT\.md/, 'canonical report file named');
  assert.match(
    p,
    /reporting it is the success path|Identifying.*is the success/i,
    'success/failure framing explicit'
  );
});

test('quick prompt carries the one-line contract', () => {
  const p = buildSoftwareEngineeringPromptQuick();
  assert.match(p, /Spec audit/, 'contract line present');
  assert.match(p, /change no code/, 'no-code rule present');
  assert.match(p, /SPEC-AUDIT\.md/, 'canonical report file named');
  assert.match(
    p,
    /Format, lint, typecheck, and the full suite are the ship gate, not the per-edit loop\. Finish every requirement before stopping\./,
    'persistence: ship gate stated, every requirement finished before stopping'
  );
  assert.match(
    p,
    /stale doc or wrong premise/,
    'a wrong premise is treated as stale/non-implementable input'
  );
  assert.match(p, /locked tests/, 'locked tests participate in the authority comparison');
  assert.match(
    p,
    /restore premature edits/,
    'a premature edit is undone rather than kept while auditing'
  );
  assert.match(
    p,
    /Only continue coding for a true, consistent requirement/,
    'coding continues only after the audit resolves consistently'
  );
});

console.log('[PASS] spec-audit honesty contract in prompts');
