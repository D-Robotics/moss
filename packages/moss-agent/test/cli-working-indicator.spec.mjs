#!/usr/bin/env node
/**
 * WorkingIndicator — the live "Working / Reasoning" line shown above the input
 * while the agent runs. Tested from the user's perspective: a reasoning model
 * (e.g. glm-5.2) can think for tens of seconds before the first visible token;
 * the line must surface "Reasoning" during that window so a long thinking pause
 * no longer reads as a freeze, and fall back to plain "Working" otherwise.
 */
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { WorkingIndicator } from '../dist/cli/tui.js';

// The indicator animates on an 80ms tick and reads the ref each frame; settle
// past one tick before sampling the rendered output.
const settle = () => new Promise((res) => setTimeout(res, 120));

// Live reasoning activity → "Reasoning" + a thinking-char counter.
{
  const reasoningRef = { current: { lastAt: Date.now(), chars: 1234 } };
  const r = render(React.createElement(WorkingIndicator, { reasoningRef }));
  await settle();
  const frame = r.lastFrame();
  r.unmount();
  assert.ok(frame.includes('Reasoning'), 'shows Reasoning while thinking streams');
  assert.ok(frame.includes('1234 thinking chars'), 'shows the thinking-char counter');
}

// Thinking that stopped over ~1.5s ago → plain "Working" (reasoning is no longer live).
{
  const idleRef = { current: { lastAt: Date.now() - 5000, chars: 4096 } };
  const r = render(React.createElement(WorkingIndicator, { reasoningRef: idleRef }));
  await settle();
  const frame = r.lastFrame();
  r.unmount();
  assert.ok(frame.includes('Working'), 'shows Working when reasoning is stale');
  assert.ok(!frame.includes('Reasoning'), 'not Reasoning once thinking activity lapses');
}

// No ref at all (defensive) → plain "Working", never crashes.
{
  const r = render(React.createElement(WorkingIndicator, {}));
  await settle();
  const frame = r.lastFrame();
  r.unmount();
  assert.ok(frame.includes('Working'), 'defaults to Working without a reasoning ref');
}

console.log('[PASS] WorkingIndicator reasoning activity');
