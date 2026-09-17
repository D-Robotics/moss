#!/usr/bin/env node
/**
 * Verification tool-row summaries — edit→verify feedback must be scannable
 * without expanding full tool results (coding-first UX).
 */
import assert from 'node:assert/strict';

import {
  summarizeVerificationResult,
  extractVerificationFailurePreview,
} from '../dist/tools/harness-tools.js';

{
  const text =
    'Test Results: ✅ ALL PASSED\n' +
    'Command: npm test\n' +
    'Tests: 12 total, 12 passed, 0 failed, 0 skipped\n' +
    'Duration: 842ms\n';
  const s = summarizeVerificationResult('run_tests', text);
  assert.ok(s, 'green suite yields summary');
  assert.match(s, /ALL PASSED/i);
  assert.match(s, /12\/12 passed|12 total/i);
}

{
  const text =
    'Test Results: ❌ 2 FAILED\n' +
    'Command: npm test\n' +
    'Tests: 10 total, 8 passed, 2 failed, 0 skipped\n' +
    'Duration: 1200ms\n' +
    '\nFailures:\n' +
    '  • packages/moss-agent/test/foo.spec.mjs — expected true\n' +
    '  • packages/moss-agent/test/bar.spec.mjs — boom\n';
  const s = summarizeVerificationResult('run_tests', text);
  assert.ok(s);
  assert.match(s, /2 FAILED|2 failed/i);
  assert.match(s, /foo\.spec|2 failed \/ 10/i);
}

{
  const text =
    'Test Results: ⚠️ NO TESTS EXECUTED\n' +
    'Command: npm test\n' +
    'Tests: 0 total, 0 passed, 0 failed, 0 skipped\n';
  const s = summarizeVerificationResult('run_tests', text);
  assert.ok(s);
  assert.match(s, /NO TESTS EXECUTED/i);
}

{
  const text =
    'Verify Fix: ✅ ALL PASSED\n' +
    'Build: ✅ pass | Typecheck: ✅ pass | Tests: ✅ pass\n' +
    'Duration: 3000ms\n';
  const s = summarizeVerificationResult('verify_fix', text);
  assert.ok(s);
  assert.match(s, /ALL PASSED/i);
  assert.match(s, /build pass|tsc pass|tests pass/i);
}

{
  const text =
    'Verify Fix: ❌ ISSUES FOUND\n' +
    'Build: ✅ pass | Typecheck: ❌ FAIL | Tests: ⏭ skipped\n' +
    'Duration: 900ms\n' +
    '\n--- Typecheck Errors ---\nerror TS2322: Type string is not assignable\n';
  const s = summarizeVerificationResult('verify_fix', text);
  assert.ok(s);
  assert.match(s, /ISSUES FOUND/i);
  assert.match(s, /tsc FAIL|typecheck/i);
}

{
  const clean = summarizeVerificationResult(
    'code_diagnostics',
    'No diagnostics found.\nCommand: tsc --noEmit\n'
  );
  assert.ok(clean);
  assert.match(clean, /clean|No diagnostics/i);

  const issues = summarizeVerificationResult(
    'code_diagnostics',
    '3 errors\nsrc/a.ts:1:1 - error TS1005\n'
  );
  assert.ok(issues);
  assert.match(issues, /3 issue|3 errors|error TS1005/i);
}

{
  assert.equal(summarizeVerificationResult('run_tests', ''), null);
  assert.equal(summarizeVerificationResult('exec', 'random output'), null);
}

// ── failure preview lines (TUI collapsed row) ────────────────────────────────

{
  const red =
    'Test Results: ❌ 2 FAILED\n' +
    'Command: npm test\n' +
    'Tests: 12 total, 10 passed, 2 failed, 0 skipped\n' +
    '\nFailures:\n' +
    '  • packages/moss-agent/test/todo-progress-panel.spec.mjs — Expected equal\n' +
    '  • packages/moss-agent/test/cli-onboarding.spec.mjs — missing /quickstart\n';
  const lines = extractVerificationFailurePreview('run_tests', red, 4);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /todo-progress-panel/);
  assert.match(lines[1], /cli-onboarding|quickstart/);
}

{
  const green =
    'Test Results: ✅ ALL PASSED\n' +
    'Command: npm test\n' +
    'Tests: 12 total, 12 passed, 0 failed, 0 skipped\n';
  assert.deepEqual(extractVerificationFailurePreview('run_tests', green), []);
}

{
  const verify =
    'Verify Fix: ❌ ISSUES FOUND\n' +
    'Build: ✅ pass | Typecheck: ❌ FAIL | Tests: ⏭ skipped\n' +
    '\n--- Typecheck Errors ---\n' +
    "src/cli/tui.ts(1,1): error TS1005: ',' expected.\n" +
    'src/cli/tui.ts(2,1): error TS1109: Expression expected.\n';
  const lines = extractVerificationFailurePreview('verify_fix', verify, 4);
  assert.ok(lines.length >= 1);
  assert.match(lines[0], /TS1005|tui\.ts/);
}

{
  assert.deepEqual(extractVerificationFailurePreview('exec', 'exit_code: 1\nbad'), []);
}

console.log('[PASS] verify result summary');
