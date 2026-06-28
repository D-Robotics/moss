#!/usr/bin/env node
/**
 * Compact hooks — tests the CompactHookRegistry class and the
 * buildCompactionCheckpointOutline function.
 */
import assert from 'node:assert/strict';
import {
  CompactHookRegistry,
  buildCompactionCheckpointOutline,
} from '../dist/core/loop/compact-hooks.js';

// ─── buildCompactionCheckpointOutline ────────────────────────────────────────

{
  assert.equal(
    buildCompactionCheckpointOutline(undefined),
    undefined,
    'undefined summary returns undefined'
  );
  assert.equal(
    buildCompactionCheckpointOutline(''),
    undefined,
    'empty summary returns undefined'
  );
  assert.equal(
    buildCompactionCheckpointOutline('   '),
    undefined,
    'whitespace-only returns undefined'
  );
}

{
  const result = buildCompactionCheckpointOutline('some random text without sections');
  assert.deepEqual(result, ['结构化上下文检查点'], 'no matching sections returns default');
}

{
  const summary = '历史脉络\n主要目标\n待办事项';
  const result = buildCompactionCheckpointOutline(summary);
  assert.ok(result.includes('历史脉络'), 'matched 历史脉络');
  assert.ok(result.includes('主要目标'), 'matched 主要目标');
  assert.ok(result.includes('待办事项'), 'matched 待办事项');
  assert.equal(result.length, 3, '3 sections matched');
}

{
  const summary = '已完成的工作 and 关键决策与约束 mixed';
  const result = buildCompactionCheckpointOutline(summary);
  assert.ok(result.includes('已完成的工作'), 'matched 已完成的工作');
  assert.ok(result.includes('关键决策与约束'), 'matched 关键决策与约束');
}

// ─── CompactHookRegistry — registration and execution ────────────────────────

{
  // Pre-hook execution
  const registry = new CompactHookRegistry();
  let called = false;
  registry.registerPre(async (ctx) => {
    called = true;
    assert.equal(ctx.sessionKey, 'test-session', 'pre-hook receives sessionKey');
    assert.equal(ctx.reason, 'overflow', 'pre-hook receives reason');
  });
  await registry.runPreHooks({
    sessionKey: 'test-session',
    runId: 'run-1',
    messages: [],
    reason: 'overflow',
  });
  assert.equal(called, true, 'pre-hook was called');
}

{
  // Post-hook execution
  const registry = new CompactHookRegistry();
  let called = false;
  registry.registerPost(async (ctx) => {
    called = true;
    assert.equal(ctx.success, true, 'post-hook receives success');
    assert.equal(ctx.droppedMessages, 5, 'post-hook receives droppedMessages');
  });
  await registry.runPostHooks({
    sessionKey: 'test-session',
    runId: 'run-1',
    summaryChars: 500,
    droppedMessages: 5,
    reason: 'overflow',
    success: true,
  });
  assert.equal(called, true, 'post-hook was called');
}

// ─── CompactHookRegistry — multiple hooks in order ───────────────────────────

{
  const registry = new CompactHookRegistry();
  const order = [];
  registry.registerPre(async () => { order.push(1); });
  registry.registerPre(async () => { order.push(2); });
  registry.registerPre(async () => { order.push(3); });
  await registry.runPreHooks({
    sessionKey: 's',
    runId: 'r',
    messages: [],
    reason: 'overflow',
  });
  assert.deepEqual(order, [1, 2, 3], 'pre-hooks execute in registration order');
}

// ─── CompactHookRegistry — error isolation ───────────────────────────────────

{
  const registry = new CompactHookRegistry();
  const order = [];
  registry.registerPre(async () => { order.push('before-error'); });
  registry.registerPre(async () => { throw new Error('hook failure'); });
  registry.registerPre(async () => { order.push('after-error'); });
  await registry.runPreHooks({
    sessionKey: 's',
    runId: 'r',
    messages: [],
    reason: 'overflow',
  });
  assert.deepEqual(
    order,
    ['before-error', 'after-error'],
    'error in one hook does not prevent subsequent hooks'
  );
}

{
  // Post-hooks also have error isolation
  const registry = new CompactHookRegistry();
  const order = [];
  registry.registerPost(async () => { throw new Error('post failure'); });
  registry.registerPost(async () => { order.push('survived'); });
  await registry.runPostHooks({
    sessionKey: 's',
    runId: 'r',
    summaryChars: 0,
    droppedMessages: 0,
    reason: 'overflow',
    success: true,
  });
  assert.deepEqual(order, ['survived'], 'post-hook error isolation works');
}

// ─── CompactHookRegistry — empty registry ────────────────────────────────────

{
  const registry = new CompactHookRegistry();
  // Should not throw with no hooks registered
  await registry.runPreHooks({
    sessionKey: 's',
    runId: 'r',
    messages: [],
    reason: 'overflow',
  });
  await registry.runPostHooks({
    sessionKey: 's',
    runId: 'r',
    summaryChars: 0,
    droppedMessages: 0,
    reason: 'overflow',
    success: true,
  });
  // If we reach here, no errors were thrown
  assert.ok(true, 'empty registry does not throw');
}

console.log('✅ loop-compact-hooks.spec.mjs — all tests passed');
