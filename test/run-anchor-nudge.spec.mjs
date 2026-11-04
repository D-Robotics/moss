#!/usr/bin/env node
/**
 * RunAnchorNudge — one-per-run objective re-anchor for deep tool loops.
 * Ported from Qoder conversation mining 2026-11-04: `goal_state` was the most
 * frequent runtime injection (9021 / 476 sessions) while Moss states the goal
 * only in the opening user message. Locks: fires once at ≥20 turns with
 * ≥8 tool calls, never for light runs, never twice, and is ablatable via
 * MOSS_DISABLE_NUDGES=run-anchor.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  evaluateRunAnchorNudge,
  RUN_ANCHOR_MIN_TOOL_CALLS,
  RUN_ANCHOR_TURN_THRESHOLD,
} from '../dist/core/loop/nudges/run-anchor-nudge.js';
import { NUDGE_IDS } from '../dist/core/loop/nudges/disable.js';

const base = {
  userText: 'fix the flaky spec',
  toolCallsByName: { exec: 6, read: 4 },
  totalToolCalls: 10,
  attempts: 0,
};

test('fires exactly once once a run is deep enough with real tool work', () => {
  const deep = { ...base, turns: RUN_ANCHOR_TURN_THRESHOLD };
  const fire = evaluateRunAnchorNudge(deep);
  assert.equal(fire.fire, true);
  assert.match(fire.correction, /first user message/);
  assert.match(fire.correction, /one thing that still blocks/);

  const again = evaluateRunAnchorNudge({ ...deep, attempts: 1 });
  assert.equal(again.fire, false, 'counter caps the nudge at one fire per run');
});

test('shallow runs and chat-heavy runs stay silent', () => {
  const shallow = evaluateRunAnchorNudge({ ...base, turns: RUN_ANCHOR_TURN_THRESHOLD - 1 });
  assert.equal(shallow.fire, false);

  const light = evaluateRunAnchorNudge({
    ...base,
    turns: RUN_ANCHOR_TURN_THRESHOLD + 5,
    totalToolCalls: RUN_ANCHOR_MIN_TOOL_CALLS - 1,
    toolCallsByName: { read: 3 },
  });
  assert.equal(light.fire, false);
});

test('registered under a stable ablation id', () => {
  assert.ok(
    NUDGE_IDS.includes('run-anchor'),
    'run-anchor must appear in NUDGE_IDS so MOSS_DISABLE_NUDGES can ablate it'
  );
});
