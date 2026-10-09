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
    /Finish every requirement and verify it before stopping/,
    'persistence: implement and verify before stopping'
  );
  assert.match(
    p,
    /mistaken premise or wrong detail in the task description is not a contradiction/,
    'a wrong premise is not a spec contradiction'
  );
  assert.match(
    p,
    /locked\/existing tests and observable behavior win/,
    'locked tests and observed behavior win over a wrong premise'
  );
  assert.match(
    p,
    /Only stop for a true contradiction where no implementation can satisfy all requirements/,
    'stop only when no implementation can satisfy every requirement'
  );
});

console.log('[PASS] spec-audit honesty contract in prompts');
