#!/usr/bin/env node
/**
 * Context budget planner — tests the planContextBudgetActions function
 * which decides what context management actions to take based on
 * token usage, turn number, and whether this is a tool follow-up round.
 */
import assert from 'node:assert/strict';
import { planContextBudgetActions } from '../dist/core/loop/context-budget-planner.js';
import {
  getContextWarningThreshold,
  getProactiveCompactThreshold,
} from '../dist/context/window-economics.js';

// Use a realistic context window for threshold calculations
const WINDOW = 200_000;
const proactiveThreshold = getProactiveCompactThreshold(WINDOW);
const warningThreshold = getContextWarningThreshold(WINDOW);

// ─── first turn (turn <= 1) ──────────────────────────────────────────────────

{
  const result = planContextBudgetActions({
    estimatedPromptTokens: 50_000,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: false,
    turn: 1,
  });
  assert.equal(result.reason, 'first_turn', 'turn=1 reason is first_turn');
  assert.deepEqual(result.actions, [], 'first turn has no actions');
  assert.equal(result.warningThreshold, warningThreshold, 'warningThreshold correct');
  assert.equal(result.proactiveThreshold, proactiveThreshold, 'proactiveThreshold correct');
}

{
  const result = planContextBudgetActions({
    estimatedPromptTokens: 180_000,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: false,
    turn: 0,
  });
  assert.equal(result.reason, 'first_turn', 'turn=0 also first_turn');
  assert.deepEqual(result.actions, [], 'turn=0 no actions even at high pressure');
}

// ─── tool follow-up round ────────────────────────────────────────────────────

{
  const result = planContextBudgetActions({
    estimatedPromptTokens: 180_000,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: true,
    turn: 5,
  });
  assert.equal(result.reason, 'tool_followup_round', 'tool follow-up reason');
  assert.equal(result.actions.length, 1, 'one action for tool follow-up');
  assert.equal(result.actions[0].kind, 'invalidate_stale_reads', 'action is invalidate_stale_reads');
  assert.equal(result.actions[0].reason, 'tool_followup_round', 'action reason matches');
}

// ─── baseline hygiene (below warning threshold) ──────────────────────────────

{
  const result = planContextBudgetActions({
    estimatedPromptTokens: 10_000,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: false,
    turn: 3,
  });
  assert.equal(result.reason, 'baseline_hygiene', 'low tokens = baseline_hygiene');
  assert.ok(result.actions.length >= 1, 'at least baseline invalidate action');
  assert.equal(result.actions[0].kind, 'invalidate_stale_reads', 'first action is invalidate');
  assert.equal(result.actions[0].reason, 'baseline_hygiene', 'action reason is baseline');

  // Should NOT have snip_tail_tool_results or microcompact when below warning
  const kinds = result.actions.map((a) => a.kind);
  assert.ok(!kinds.includes('snip_tail_tool_results'), 'no snip below warning');
  assert.ok(!kinds.includes('microcompact'), 'no microcompact below warning');
}

// ─── warning threshold exceeded ──────────────────────────────────────────────

{
  const result = planContextBudgetActions({
    estimatedPromptTokens: warningThreshold + 1_000,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: false,
    turn: 5,
  });
  assert.equal(result.reason, 'warning_threshold', 'above warning = warning_threshold');
  const kinds = result.actions.map((a) => a.kind);
  assert.ok(kinds.includes('invalidate_stale_reads'), 'has invalidate_stale_reads');
  assert.ok(kinds.includes('snip_tail_tool_results'), 'has snip_tail_tool_results');
  assert.ok(kinds.includes('microcompact'), 'has microcompact at warning');
}

// ─── proactive threshold exceeded ────────────────────────────────────────────

{
  const result = planContextBudgetActions({
    estimatedPromptTokens: proactiveThreshold,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: false,
    turn: 5,
  });
  // proactiveThreshold - 2500 is the trigger for proactive
  assert.equal(result.reason, 'proactive_threshold', 'at proactive = proactive_threshold');
  const kinds = result.actions.map((a) => a.kind);
  assert.ok(kinds.includes('snip_tail_tool_results'), 'has snip at proactive');
  assert.ok(kinds.includes('microcompact'), 'has microcompact at proactive');
}

{
  // Just below proactive threshold — should be warning
  const result = planContextBudgetActions({
    estimatedPromptTokens: proactiveThreshold - 3_000,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: false,
    turn: 5,
  });
  assert.equal(result.reason, 'warning_threshold', 'below proactive-2500 = warning');
}

// ─── microcompact config differs by pressure level ───────────────────────────

{
  const warningResult = planContextBudgetActions({
    estimatedPromptTokens: warningThreshold + 100,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: false,
    turn: 5,
  });
  const mcAction = warningResult.actions.find((a) => a.kind === 'microcompact');
  assert.ok(mcAction, 'microcompact action present at warning');
  assert.equal(mcAction.microcompactConfig.keepRecentResults, 4, 'warning keeps 4 recent results');
  assert.equal(mcAction.microcompactConfig.minContentLength, 100, 'warning min content 100');
}

{
  const proactiveResult = planContextBudgetActions({
    estimatedPromptTokens: proactiveThreshold + 100,
    effectiveContextWindowTokens: WINDOW,
    isToolFollowUpRound: false,
    turn: 5,
  });
  const mcAction = proactiveResult.actions.find((a) => a.kind === 'microcompact');
  assert.ok(mcAction, 'microcompact action present at proactive');
  assert.equal(mcAction.microcompactConfig.keepRecentResults, 2, 'proactive keeps 2 recent results');
  assert.equal(mcAction.microcompactConfig.minContentLength, 50, 'proactive min content 50');
}

console.log('✅ loop-context-budget-planner.spec.mjs — all tests passed');
