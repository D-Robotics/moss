#!/usr/bin/env node
/**
 * Context usage escalation path — threshold continuity and accurate feedback.
 *
 * Verifies that the escalation ladder (warning → proactive → hard cap → overflow)
 * has no dead zones or inversions across a range of model context window sizes,
 * and that steering contextUsageRatio includes the system prompt.
 */
import assert from 'node:assert/strict';

import {
  getContextWarningThreshold,
  getProactiveCompactThreshold,
  getEffectiveContextWindowTokens,
  estimatePromptUnitsForContextWindow,
} from '../dist/context/index.js';
import { planContextBudgetActions } from '../dist/core/loop/index.js';
import { classifyProviderError } from '../dist/provider/index.js';

// ─── 1. Warning threshold never 0 for reasonable windows ─────────────────

{
  // 32K model — the case that used to produce warningThreshold = 0
  const effCtx = getEffectiveContextWindowTokens(32_000, 8192);
  const warning = getContextWarningThreshold(effCtx);
  const proactive = getProactiveCompactThreshold(effCtx);

  assert.ok(warning > 0, `warningThreshold must be > 0 for 32K window, got ${warning}`);
  assert.ok(
    warning < proactive,
    `warningThreshold (${warning}) must be below proactiveThreshold (${proactive})`
  );
}

{
  // 200K model — the standard large-window case
  const effCtx = getEffectiveContextWindowTokens(200_000, 8192);
  const warning = getContextWarningThreshold(effCtx);
  const proactive = getProactiveCompactThreshold(effCtx);

  assert.ok(warning > 0, `warningThreshold must be > 0 for 200K window, got ${warning}`);
  assert.ok(
    warning < proactive,
    `warningThreshold (${warning}) must be below proactiveThreshold (${proactive})`
  );
}

// ─── 2. Escalation ladder: warning < proactive < hard cap < effCtx ──────

for (const [label, ctxTokens, maxOut] of [
  ['32K', 32_000, 8192],
  ['128K', 128_000, 8192],
  ['200K', 200_000, 8192],
  ['1M', 1_000_000, 32_000],
]) {
  const effCtx = getEffectiveContextWindowTokens(ctxTokens, maxOut);
  const warning = getContextWarningThreshold(effCtx);
  const proactive = getProactiveCompactThreshold(effCtx);
  const hardCap = Math.floor(effCtx * 0.9); // dynamic hard cap (90% of effCtx)

  assert.ok(
    warning < proactive,
    `[${label}] warning (${warning}) must be < proactive (${proactive})`
  );
  assert.ok(
    proactive < hardCap,
    `[${label}] proactive (${proactive}) must be < hard cap (${hardCap})`
  );
  assert.ok(
    hardCap < effCtx,
    `[${label}] hard cap (${hardCap}) must be < effCtx (${effCtx})`
  );
}

// ─── 3. Steering ratio includes system prompt ───────────────────────────

{
  // Empty messages but large system prompt → ratio must be > 0
  const effCtx = getEffectiveContextWindowTokens(200_000, 8192);
  const systemPrompt = 'x'.repeat(40_000); // ~10K tokens at 4 chars/token
  const ratio = estimatePromptUnitsForContextWindow({
    messages: [],
    systemPrompt,
    charsPerTokenUnit: 4,
    effectiveContextWindowTokens: effCtx,
    includeThinking: false,
  }) / effCtx;

  assert.ok(ratio > 0, `ratio must be > 0 when system prompt is non-empty, got ${ratio}`);
  assert.ok(
    ratio < 1,
    `ratio must be < 1 for a 40K-char system prompt on 200K window, got ${ratio}`
  );
}

{
  // Same messages, same system prompt → ratio from estimatePromptUnitsForContextWindow
  // should be >= ratio from raw message chars only (because it includes system prompt)
  const effCtx = getEffectiveContextWindowTokens(200_000, 8192);
  const systemPrompt = 'system prompt content';
  const messages = [{ role: 'user', content: 'hello world', timestamp: 0 }];

  const withSystem = estimatePromptUnitsForContextWindow({
    messages,
    systemPrompt,
    charsPerTokenUnit: 4,
    effectiveContextWindowTokens: effCtx,
    includeThinking: false,
  });
  const withoutSystem = estimatePromptUnitsForContextWindow({
    messages,
    systemPrompt: '',
    charsPerTokenUnit: 4,
    effectiveContextWindowTokens: effCtx,
    includeThinking: false,
  });

  assert.ok(
    withSystem > withoutSystem,
    `estimate with system prompt (${withSystem}) must be > without (${withoutSystem})`
  );
}

// ─── 4. Planner tool_followup_round branch returns invalidate_stale_reads ──

{
  const plan = planContextBudgetActions({
    estimatedPromptTokens: 5000,
    effectiveContextWindowTokens: 191_808,
    isToolFollowUpRound: true,
    turn: 3,
  });

  assert.equal(plan.reason, 'tool_followup_round');
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].kind, 'invalidate_stale_reads');
  assert.equal(plan.actions[0].reason, 'tool_followup_round');
}

// ─── 5. Error message for context_length_exceeded is accurate ───────────

{
  const surface = classifyProviderError({
    errorMessage: 'context_length_exceeded',
    code: 'context_length_exceeded',
  });

  assert.equal(surface.category, 'context_length_exceeded');
  assert.ok(
    surface.userMessage.includes('上下文'),
    `userMessage must mention "上下文", got: ${surface.userMessage}`
  );
  assert.ok(
    surface.userMessage.includes('超出'),
    `userMessage must mention "超出", got: ${surface.userMessage}`
  );
}

{
  // Also verify the English variant is still classified correctly
  const surface = classifyProviderError({
    errorMessage: 'This model maximum context length is 131072 tokens',
  });

  assert.equal(surface.category, 'context_length_exceeded');
  assert.ok(
    surface.userMessage.includes('上下文'),
    `userMessage must mention "上下文" for English error too, got: ${surface.userMessage}`
  );
}

console.log('✓ context-escalation: all tests passed');
