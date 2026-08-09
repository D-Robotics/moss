#!/usr/bin/env node
/**
 * Steering engine — builtin rules and SteeringEngine lifecycle.
 * Tests the four builtin steering rules and the engine's
 * priority ordering, cooldown, and reset behaviour.
 */
import assert from 'node:assert/strict';
import {
  BUILTIN_ERROR_RECOVERY_RULE,
  BUILTIN_TOOL_LOOP_RULE,
  BUILTIN_CONTEXT_PRESSURE_RULE,
  BUILTIN_WEB_SEARCH_VARIATION_RULE,
  DEFAULT_STEERING_RULES,
  SteeringEngine,
} from '../dist/core/loop/steering.js';

// ─── helper: build a SteeringContext ─────────────────────────────────────────

function makeCtx(overrides = {}) {
  return {
    messages: [],
    turn: 1,
    consecutiveToolErrors: 0,
    totalToolCalls: 0,
    contextUsageRatio: 0,
    sessionKey: 'test-session',
    ...overrides,
  };
}

function assistantWithToolUse(name = 'exec') {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'tu-1', name, input: {} }],
  };
}

function assistantWithText(text = 'thinking...') {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

// ─── BUILTIN_ERROR_RECOVERY_RULE ─────────────────────────────────────────────

{
  // Below threshold — no guidance
  const result = BUILTIN_ERROR_RECOVERY_RULE.check(makeCtx({ consecutiveToolErrors: 2 }));
  assert.equal(result, null, 'consecutiveToolErrors < 3 returns null');
}

{
  // At threshold — guidance fired
  const result = BUILTIN_ERROR_RECOVERY_RULE.check(makeCtx({ consecutiveToolErrors: 3 }));
  assert.ok(result, 'consecutiveToolErrors >= 3 returns guidance text');
  assert.ok(result.includes('Steering'), 'guidance includes [Steering] prefix');
  assert.ok(result.includes('tool errors'), 'guidance mentions tool errors');
}

{
  // Well above threshold
  const result = BUILTIN_ERROR_RECOVERY_RULE.check(makeCtx({ consecutiveToolErrors: 10 }));
  assert.ok(result, 'consecutiveToolErrors = 10 still fires');
}

// ─── BUILTIN_TOOL_LOOP_RULE ──────────────────────────────────────────────────

{
  // Turn below threshold
  const result = BUILTIN_TOOL_LOOP_RULE.check(makeCtx({ turn: 7 }));
  assert.equal(result, null, 'turn < 8 returns null');
}

{
  // Turn at threshold but not enough assistant messages
  const result = BUILTIN_TOOL_LOOP_RULE.check(
    makeCtx({ turn: 8, messages: [assistantWithToolUse()] })
  );
  assert.equal(result, null, 'turn=8 but < 4 recent assistant returns null');
}

{
  // Turn at threshold with 4+ assistant tool_use messages
  const msgs = [];
  for (let i = 0; i < 4; i++) msgs.push(assistantWithToolUse());
  const result = BUILTIN_TOOL_LOOP_RULE.check(makeCtx({ turn: 8, messages: msgs }));
  assert.ok(result, 'turn=8 with 4 tool_use assistants fires guidance');
  assert.ok(result.includes('tool loop'), 'guidance mentions tool loop');
}

{
  // Recent assistants include a text-only message — no fire
  const msgs = [
    assistantWithToolUse(),
    assistantWithText(),
    assistantWithToolUse(),
    assistantWithToolUse(),
  ];
  const result = BUILTIN_TOOL_LOOP_RULE.check(makeCtx({ turn: 10, messages: msgs }));
  assert.equal(result, null, 'mixed text/tool_use assistants does not fire');
}

// ─── BUILTIN_CONTEXT_PRESSURE_RULE ───────────────────────────────────────────

{
  // Below ratio
  const result = BUILTIN_CONTEXT_PRESSURE_RULE.check(makeCtx({ contextUsageRatio: 0.74 }));
  assert.equal(result, null, 'ratio < 0.75 returns null');
}

{
  // At ratio
  const result = BUILTIN_CONTEXT_PRESSURE_RULE.check(makeCtx({ contextUsageRatio: 0.75 }));
  assert.ok(result, 'ratio >= 0.75 fires guidance');
  assert.ok(result.includes('75%'), 'guidance includes percentage');
  assert.ok(result.includes('concise'), 'guidance asks for conciseness');
}

{
  // High ratio
  const result = BUILTIN_CONTEXT_PRESSURE_RULE.check(makeCtx({ contextUsageRatio: 0.95 }));
  assert.ok(result, 'ratio=0.95 fires');
  assert.ok(result.includes('95%'), 'guidance shows 95%');
}

{
  // Ratio > 1.0 — must NOT fire. This happens when the context window was
  // not probed (fell back to the conservative 32k default) and a normal
  // ~40k-token system prompt reads as "125% full". Firing here wastes a
  // turn on every simple query for providers that don't expose context
  // length via /v1/models (e.g. deepseek). The overflow/compaction path
  // handles genuine overflow; "be concise" is the wrong action either way.
  const result = BUILTIN_CONTEXT_PRESSURE_RULE.check(makeCtx({ contextUsageRatio: 1.25 }));
  assert.equal(result, null, 'ratio > 1.0 returns null (unprobed/overflow — not a steering case)');

  const resultAtOne = BUILTIN_CONTEXT_PRESSURE_RULE.check(makeCtx({ contextUsageRatio: 1.0 }));
  assert.ok(resultAtOne, 'ratio=1.0 still fires (upper bound of believable band)');
}

// ─── BUILTIN_WEB_SEARCH_VARIATION_RULE ───────────────────────────────────────

{
  // No web_search calls
  const result = BUILTIN_WEB_SEARCH_VARIATION_RULE.check(
    makeCtx({ messages: [assistantWithToolUse('exec')] })
  );
  assert.equal(result, null, 'no web_search calls returns null');
}

{
  // Only 2 distinct queries — below new threshold of 3
  const msgs = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: '1', name: 'web_search', input: { query: 'first query' } }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: '2', name: 'web_search', input: { query: 'second query' } },
      ],
    },
  ];
  const result = BUILTIN_WEB_SEARCH_VARIATION_RULE.check(makeCtx({ messages: msgs }));
  assert.equal(result, null, '< 3 distinct queries returns null');
}

{
  // 3+ distinct queries — fires
  const msgs = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: '1', name: 'web_search', input: { query: 'first query' } }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: '2', name: 'web_search', input: { query: 'second query' } },
      ],
    },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: '3', name: 'web_search', input: { query: 'third query' } }],
    },
  ];
  const result = BUILTIN_WEB_SEARCH_VARIATION_RULE.check(makeCtx({ messages: msgs }));
  assert.ok(result, '>= 3 distinct queries fires guidance');
  assert.ok(result.includes('web_search'), 'guidance mentions web_search');
  assert.ok(result.includes('web_fetch'), 'guidance suggests web_fetch');
}

// ─── DEFAULT_STEERING_RULES ──────────────────────────────────────────────────

{
  assert.equal(DEFAULT_STEERING_RULES.length, 5, '5 builtin rules');
  const ids = DEFAULT_STEERING_RULES.map((r) => r.id);
  assert.ok(ids.includes('error-recovery'), 'includes error-recovery');
  assert.ok(ids.includes('tool-loop'), 'includes tool-loop');
  assert.ok(ids.includes('context-pressure'), 'includes context-pressure');
  assert.ok(ids.includes('web-search-variation'), 'includes web-search-variation');
  assert.ok(ids.includes('local-exploration-loop'), 'includes local-exploration-loop');
}

// ─── SteeringEngine ──────────────────────────────────────────────────────────

{
  // Default rules, no trigger
  const engine = new SteeringEngine();
  const result = engine.evaluate(makeCtx({ turn: 1 }));
  assert.equal(result.triggered, false, 'no triggers on clean context');
  assert.deepEqual(result.guidances, [], 'empty guidances');
  assert.deepEqual(result.firedRules, [], 'empty firedRules');
}

{
  // Error recovery fires
  const engine = new SteeringEngine();
  const result = engine.evaluate(makeCtx({ turn: 5, consecutiveToolErrors: 3 }));
  assert.equal(result.triggered, true, 'triggered by error recovery');
  assert.ok(result.firedRules.includes('error-recovery'), 'firedRules includes error-recovery');
}

{
  // Cooldown prevents re-firing
  const engine = new SteeringEngine();
  const ctx1 = makeCtx({ turn: 5, consecutiveToolErrors: 3 });
  const r1 = engine.evaluate(ctx1);
  assert.equal(r1.triggered, true, 'first eval fires');

  // Same rule, within cooldown
  const ctx2 = makeCtx({ turn: 6, consecutiveToolErrors: 3 });
  const r2 = engine.evaluate(ctx2);
  assert.equal(r2.triggered, false, 'second eval within cooldown does not fire');

  // After cooldown
  const ctx3 = makeCtx({ turn: 10, consecutiveToolErrors: 3 });
  const r3 = engine.evaluate(ctx3);
  assert.equal(r3.triggered, true, 'eval after cooldown fires again');
}

{
  // reset() clears cooldown
  const engine = new SteeringEngine();
  engine.evaluate(makeCtx({ turn: 5, consecutiveToolErrors: 3 }));
  engine.reset();
  const result = engine.evaluate(makeCtx({ turn: 5, consecutiveToolErrors: 3 }));
  assert.equal(result.triggered, true, 'after reset, rule fires again immediately');
}

{
  // addRule() — custom rule
  const engine = new SteeringEngine([]);
  const customRule = {
    id: 'custom-test',
    priority: 100,
    cooldownTurns: 1,
    check: (ctx) => (ctx.turn > 0 ? 'custom guidance' : null),
  };
  engine.addRule(customRule);
  const result = engine.evaluate(makeCtx({ turn: 1 }));
  assert.equal(result.triggered, true, 'custom rule fires');
  assert.ok(result.firedRules.includes('custom-test'), 'firedRules includes custom-test');
  assert.ok(result.guidances[0].includes('custom'), 'guidance from custom rule');
}

{
  // Multiple rules fire in same turn
  const engine = new SteeringEngine();
  const result = engine.evaluate(
    makeCtx({
      turn: 10,
      consecutiveToolErrors: 5,
      contextUsageRatio: 0.9,
    })
  );
  assert.equal(result.triggered, true, 'multiple conditions fire');
  assert.ok(result.firedRules.length >= 2, 'at least 2 rules fired');
}

console.log('✅ loop-steering.spec.mjs — all tests passed');
