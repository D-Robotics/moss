#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  classifyUserIntent,
  intentNeedsCodingTools,
  intentNeedsWebTools,
  intentNeedsPlanTools,
} from '../dist/cli/intent-classify.js';

{
  const r = classifyUserIntent('Reply with exactly: PONG');
  assert.equal(r.primary, 'chat');
}

{
  const r = classifyUserIntent('fix the pre-abort child process bug in edit_file');
  assert.equal(r.primary, 'debug');
  assert.equal(intentNeedsCodingTools(r.primary), true);
}

{
  const r = classifyUserIntent('search the web for latest ROS2 humble release notes');
  assert.equal(r.primary, 'research');
  assert.equal(intentNeedsWebTools(r.primary), true);
}

{
  const r = classifyUserIntent('connect to RDK board and list ROS2 topics');
  assert.equal(r.primary, 'ops');
}

{
  const r = classifyUserIntent('write a phased roadmap for the migration — plan only, no code yet');
  assert.ok(r.primary === 'plan_only' || r.primary === 'coding');
  // plan_only when no implement verb dominates
}

{
  const r = classifyUserIntent('implement multi_edit path headlines for the TUI');
  assert.equal(r.primary, 'coding');
  assert.equal(intentNeedsPlanTools(r.primary), false);
}

console.log('[PASS] intent-classify');
