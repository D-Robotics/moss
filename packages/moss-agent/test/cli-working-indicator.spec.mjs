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

// The indicator animates on a restrained tick and reads the ref each frame;
// settle past at least one tick before sampling rendered output.
const settle = () => new Promise((res) => setTimeout(res, 1100));

// The status line must not repaint the whole Ink tree at animation-frame speed.
// One update per second is enough to show elapsed progress without flooding
// PTYs, logs, screen readers, or remote terminals with control sequences.
{
  const r = render(React.createElement(WorkingIndicator, {}));
  await new Promise((res) => setTimeout(res, 2200));
  const renderedFrames = r.frames.length;
  r.unmount();
  assert.ok(
    renderedFrames <= 4,
    `working indicator should render at most 4 frames in 2200ms, rendered ${renderedFrames}`
  );
}

{
  const r = render(React.createElement(WorkingIndicator, { phase: 'Synthesizing results' }));
  const frame = r.lastFrame();
  r.unmount();
  assert.match(
    frame,
    /Synthesizing results/,
    'tool completion can surface the model synthesis phase'
  );
}

// Live reasoning activity → "Reasoning" + a thinking-char counter.
{
  const reasoningRef = { current: { lastAt: 0, chars: 1234 } };
  const r = render(React.createElement(WorkingIndicator, { reasoningRef }));
  await settle();
  // Refresh the activity timestamp RIGHT BEFORE sampling so the ref is
  // guaranteed live (Date.now() - lastAt < 1500) regardless of how long the
  // preceding settle took under CI load — then wait one tick for the component
  // to read it. Without this, a slow CI runner could make the settle exceed
  // the 1.5s freshness window and falsely show "Working" instead of "Reasoning".
  reasoningRef.current.lastAt = Date.now();
  await new Promise((res) => setTimeout(res, 1100));
  const frame = r.lastFrame();
  r.unmount();
  assert.ok(frame.includes('Reasoning'), 'shows Reasoning while thinking streams');
  assert.ok(frame.includes('1234 thinking chars'), 'shows the thinking-char counter');
}

// Thinking that stopped over ~1.5s ago → Grok-style "Waiting for response…"
// (not a generic Working freeze).
{
  const idleRef = { current: { lastAt: Date.now() - 5000, chars: 4096 } };
  const r = render(React.createElement(WorkingIndicator, { reasoningRef: idleRef }));
  await settle();
  const frame = r.lastFrame();
  r.unmount();
  assert.ok(
    frame.includes('Waiting for response'),
    'shows Waiting for response when reasoning is stale'
  );
  assert.ok(!frame.includes('Reasoning'), 'not Reasoning once thinking activity lapses');
}

// No ref at all (defensive) → Waiting for response…, never crashes.
{
  const r = render(React.createElement(WorkingIndicator, {}));
  await settle();
  const frame = r.lastFrame();
  r.unmount();
  assert.ok(
    frame.includes('Waiting for response'),
    'defaults to Waiting for response without a reasoning ref'
  );
}

// Explicit tool phase still wins over waiting.
{
  const r = render(React.createElement(WorkingIndicator, { phase: 'Running exec' }));
  const frame = r.lastFrame();
  r.unmount();
  assert.match(frame, /Running exec/, 'tool phase label is preserved');
}

console.log('[PASS] WorkingIndicator reasoning activity');
