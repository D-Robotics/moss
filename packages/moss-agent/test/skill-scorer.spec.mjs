#!/usr/bin/env node
/**
 * Skill scorer — confidence scoring logic.
 * Tests base score, tool-count bonus, error-recovery bonus,
 * pattern-occurrence bonus, verification bonus, and failure penalties.
 */
import assert from 'node:assert/strict';
import {
  scoreSkillCandidate,
  isHighConfidence,
  isMediumConfidence,
} from '../dist/skill-learning/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function tc(name, failed = false, input = {}) {
  return { name, input, failed };
}

function makeEvidence(toolCalls, opts = {}) {
  return {
    candidateId: 'test-candidate',
    sourceKind: 'conversation',
    createdAt: Date.now(),
    sourceSessionKey: 'test-session',
    turnHash: 'abc123',
    gate: 'strict',
    toolCalls,
    toolNames: [...new Set(toolCalls.map((t) => t.name))],
    userMessage: 'deploy model to board',
    assistantText: 'done',
    runMeta: {
      completionKind: opts.completionKind || 'partial',
      model: 'test-model',
      totalElapsedMs: 1000,
    },
  };
}

// ─── 1. Base score + tool-count + verification bonus ─────────────────────────

{
  // 3 distinct tools, all succeed, exec provides strong verification.
  // 0.3 (base) + 0.1 (3+ tools) + 0.1 (3+ distinct) + 0.1 (allSucceeded & 3+) + 0.1 (strong verification) = 0.7
  const evidence = makeEvidence([
    tc('exec'),
    tc('read_file'),
    tc('write_file'),
  ]);
  const result = scoreSkillCandidate(evidence, 1);

  assert.equal(result.confidence, 0.7, '3 distinct tools all-succeed → 0.7');
  assert.equal(result.signals.toolCallCount, 3);
  assert.equal(result.signals.distinctTools, 3);
  assert.equal(result.signals.allSucceeded, true);
  assert.equal(result.signals.hasVerification, true);
  assert.ok(isHighConfidence(result), '0.7 >= 0.7 threshold → high confidence');
  assert.ok(isMediumConfidence(result), '0.7 >= 0.5 threshold → medium confidence');
}

// ─── 2. Error recovery — same-tool retry ─────────────────────────────────────

{
  // exec fails → exec retries successfully → read_file.
  // 0.3 + 0.1 (3+ tools) + 0.2 (same-tool retry) + 0.1 (strong verification from exec success) = 0.7
  const evidence = makeEvidence([
    tc('exec', true),
    tc('exec', false),
    tc('read_file'),
  ]);
  const result = scoreSkillCandidate(evidence, 1);

  assert.equal(result.signals.errorRecovered, true, 'same-tool retry detected');
  assert.equal(result.signals.differentToolRecovery, false, 'not different-tool recovery');
  assert.equal(result.confidence, 0.7, 'same-tool retry → 0.7');
  assert.ok(
    result.errorRecoveryPatterns.some((p) => p.includes('immediate retry')),
    'recovery pattern describes retry'
  );
}

// ─── 3. Error recovery — different-tool substitution ─────────────────────────

{
  // exec fails → device_exec (substitution group) succeeds.
  // 0.3 + 0.12 (different-tool recovery, weaker) + 0.1 (strong verification from device_exec) = 0.52
  // Note: only 2 tools, no 3+ tool bonus, no distinctTools bonus, not allSucceeded
  const evidence = makeEvidence([
    tc('exec', true),
    tc('device_exec', false),
  ]);
  const result = scoreSkillCandidate(evidence, 1);

  assert.equal(result.signals.errorRecovered, true, 'substitution recovery detected');
  assert.equal(result.signals.differentToolRecovery, true, 'different-tool recovery flagged');
  assert.equal(result.confidence, 0.52, 'different-tool recovery → 0.52');
  assert.ok(!isHighConfidence(result), '0.52 < 0.7 → not high');
  assert.ok(isMediumConfidence(result), '0.52 >= 0.5 → medium');
}

// ─── 4. Penalty — ends with failure ──────────────────────────────────────────

{
  // exec succeeds → write_file fails (last call).
  // 0.3 + 0.1 (strong verification from exec) = 0.4, then ×0.8 (endsWithFailure) = 0.32
  const evidence = makeEvidence([
    tc('exec'),
    tc('write_file', true),
  ]);
  const result = scoreSkillCandidate(evidence, 1);

  assert.equal(result.signals.allSucceeded, false);
  assert.equal(result.confidence, 0.32, 'endsWithFailure ×0.8 penalty → 0.32');
}

// ─── 5. Pattern recurrence drives confidence ─────────────────────────────────

{
  // Same 3-tool pattern seen 3 times.
  // 0.3 + 0.1 + 0.1 + 0.1 + 0.1 + 0.3 (3+ occurrences) = 1.0, clamped to 1.0
  const evidence = makeEvidence([
    tc('exec'),
    tc('read_file'),
    tc('write_file'),
  ]);
  const result = scoreSkillCandidate(evidence, 3);

  assert.equal(result.signals.patternOccurrences, 3);
  assert.equal(result.confidence, 1.0, '3+ pattern occurrences → 1.0 (clamped)');
  assert.ok(isHighConfidence(result), '1.0 → high confidence');
}

// ─── 6. >50% failure rate penalty (last tool succeeds) ──────────────────────

{
  // 2 of 3 tools fail (>50%), last tool succeeds so endsWithFailure=false.
  // 0.3 (base) + 0.1 (3+ tools) + 0.1 (3+ distinct) + 0.1 (strong verification
  // from exec) = 0.6, then ×0.6 (>50% failures, not ending) = 0.36
  const evidence = makeEvidence([
    tc('write_file', true),
    tc('read_file', true),
    tc('exec', false),
  ]);
  const result = scoreSkillCandidate(evidence, 1);

  assert.equal(result.signals.failedCount, 2);
  assert.equal(result.confidence, 0.36, '>50% failures (not ending) ×0.6 → 0.36');
}

console.log('✓ skill-scorer.spec.mjs — all assertions passed');
