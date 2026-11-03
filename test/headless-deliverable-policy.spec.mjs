import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentBehaviorPromptQuick } from '../dist/contracts/prompts/agent-behavior-prompt.js';
import { buildSoftwareEngineeringPromptQuick } from '../dist/contracts/prompts/software-engineering-prompt.js';
import { evaluateAmbiguityNudge } from '../dist/core/loop/nudges/ambiguity-nudge.js';

test('headless runs are instructed to choose defaults and produce requested artifacts', () => {
  const prompt = buildAgentBehaviorPromptQuick();
  assert.match(prompt, /headless|no-interaction/i);
  assert.match(prompt, /do not wait or ask/i);
  assert.match(prompt, /create the requested deliverable/i);
  assert.match(prompt, /state assumptions/i);
});

test('failing-test tasks are instructed to localize from real red output before editing', () => {
  const prompt = buildSoftwareEngineeringPromptQuick();
  assert.match(prompt, /run the failing test first/i);
  assert.match(prompt, /read\/search the exact implicated code/i);
  assert.match(prompt, /search.*minimal.*patch|read\/search.*minimal/i);
  assert.match(prompt, /rerun the same test/i);
});

test('ambiguity nudge never tells a headless run to ask a user', () => {
  const userText =
    'implement rate limiting either with Redis or with an in-memory map — choose a sensible default';
  const shared = { toolCallsByName: { edit_file: 1 }, userText, attempts: 0 };
  const interactive = evaluateAmbiguityNudge({ ...shared, userQuestionsAvailable: true });
  const headless = evaluateAmbiguityNudge({ ...shared, userQuestionsAvailable: false });
  assert.equal(interactive.fire, true);
  assert.match(interactive.correction, /ask_user_question/);
  assert.equal(headless.fire, true);
  assert.doesNotMatch(headless.correction, /ask_user_question/);
  assert.match(headless.correction, /State in one line which interpretation/i);
  assert.match(headless.correction, /continue/i);
});
