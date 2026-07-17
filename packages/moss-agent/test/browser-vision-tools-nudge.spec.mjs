#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateBrowserVisionToolsNudge } from '../dist/core/loop/browser-vision-tools-nudge.js';

// No tools yet
{
  const r = evaluateBrowserVisionToolsNudge({
    userText: 'open the browser and fill the login form',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Browser intent + tools without browser tools → fire
{
  const r = evaluateBrowserVisionToolsNudge({
    userText: 'open the browser and fill the login form',
    toolCallsByName: { web_search: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /web_browser_control|web_browser_fetch/i);
}

// Vision intent without vision tools
{
  const r = evaluateBrowserVisionToolsNudge({
    userText: 'analyze this screenshot of the dashboard',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /vision_analyze|screenshot_capture/i);
}

// Already used browser tools
{
  const r = evaluateBrowserVisionToolsNudge({
    userText: 'click the submit button in the browser',
    toolCallsByName: { web_browser_control: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateBrowserVisionToolsNudge({
    userText: 'take a screenshot and describe it',
    toolCallsByName: { exec: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] browser-vision-tools-nudge');
