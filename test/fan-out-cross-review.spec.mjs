#!/usr/bin/env node
/**
 * Fleet mode (v0.10 W3): fan_out cross_review + machine-checkable evidence
 * gate + builtin experts. Locked at the unit level with a stubbed spawner.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summaryHasEvidence, buildReviewerTask } from '../dist/tools/create-subagent.js';
import { fanOutSubagentsTool } from '../dist/tools/create-subagent.js';
import { SubagentExpertRegistry } from '../dist/core/subagent/expert-registry.js';

test('evidence gate: prose-only summaries are UNVERIFIED, concrete citations pass', () => {
  assert.equal(summaryHasEvidence('I looked at the code and it seems fine.'), false);
  assert.equal(summaryHasEvidence('Refactored the module and everything works now.'), false);
  assert.equal(summaryHasEvidence('Edited `src/lib/util.js` to remove the dedupe.'), true);
  assert.equal(summaryHasEvidence('Ran npm test — 3 passing.'), true);
  assert.equal(summaryHasEvidence('Fixed the bug in lib/queue.js drain loop.'), true);
  assert.equal(summaryHasEvidence(''), false);
});

test('reviewer task is read-only, verdict-first, independently verifies', () => {
  const r = buildReviewerTask({ task: 'Fix the login bug. Verify: npm test' });
  assert.match(r.task, /Fix the login bug/);
  assert.match(r.task, /READ-ONLY/);
  assert.match(r.task, /VERDICT: PASS/);
  assert.match(r.task, /VERDICT: FAIL/);
  assert.match(r.task, /Do not trust the implementer summary/);
  assert.equal(r.scope, 'verify');
});

test('fan_out cross_review=true appends reviewers and marks evidence/verdict state', async () => {
  const spawned = [];
  const ctx = {
    workspaceDir: process.cwd(),
    runId: 't',
    sessionKey: 't',
    abortSignal: new AbortController().signal,
    spawnSubagent: async (params) => {
      spawned.push(params);
      const isReviewer = params.mode === 'fan-out' && /review|VERDICT/i.test(params.task);
      if (isReviewer) {
        return {
          runId: `rev-${spawned.length}`,
          sessionKey: 's',
          summary: 'VERDICT: PASS\nRan `npm test` — 5 passing, output line "all tests passed".',
          success: true,
        };
      }
      return {
        runId: `imp-${spawned.length}`,
        sessionKey: 's',
        summary: 'Implemented the requested fix and the suite is green now.',
        success: true,
      };
    },
  };
  const out = await fanOutSubagentsTool.execute(
    {
      tasks: [
        { task: 'Fix bug A. Verify: npm test', scope: 'full', writePaths: ['src/'] },
        { task: 'Fix bug B. Verify: npm test', scope: 'full', writePaths: ['src/'] },
      ],
      cross_review: true,
    },
    ctx
  );
  const text = String(out);
  // 2 implementers + 2 reviewers spawned
  assert.equal(spawned.length, 4, `expected 4 children, got ${spawned.length}`);
  assert.ok(
    spawned.some((p) => /VERDICT/.test(p.task)),
    'reviewer task present'
  );
  // evidence gate marks implementer summary without backticks/paths
  assert.match(text, /SUCCESS \(UNVERIFIED — no concrete evidence cited\)/);
  // reviewer with verdict + evidence is plain SUCCESS
  assert.match(text, /VERDICT: PASS/);
});

test('fan_out without cross_review behaves as before (no reviewers)', async () => {
  const spawned = [];
  const ctx = {
    workspaceDir: process.cwd(),
    runId: 't',
    sessionKey: 't',
    abortSignal: new AbortController().signal,
    spawnSubagent: async (params) => {
      spawned.push(params);
      return {
        runId: `x-${spawned.length}`,
        sessionKey: 's',
        summary: 'done — edited `a.ts`',
        success: true,
      };
    },
  };
  const out = await fanOutSubagentsTool.execute(
    {
      tasks: [
        { task: 'task one', scope: 'explore' },
        { task: 'task two', scope: 'explore' },
      ],
    },
    ctx
  );
  assert.equal(spawned.length, 2);
  assert.doesNotMatch(String(out), /VERDICT/);
});

test('builtin analysis experts are registered and read-only', async () => {
  const registry = new SubagentExpertRegistry();
  const resolved = registry.get('debugger');
  assert.ok(resolved, 'debugger expert resolves');
  assert.equal(resolved.scope, 'read-only');
  for (const id of ['refactoring', 'test-writer']) {
    assert.ok(registry.get(id), `${id} expert resolves`);
  }
  assert.equal(registry.get('nonexistent'), undefined);
  assert.ok(registry instanceof SubagentExpertRegistry);
});

console.log('[PASS] fleet cross-review + evidence gate + experts');
