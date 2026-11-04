#!/usr/bin/env node
/**
 * Deterministic probe for the L1 verification completion gate (D-acceptance).
 * Asserts the decision table against dist/, so a regression in what counts as
 * "checked" fails the fast gate instead of only showing up in a model run.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  evaluateVerificationCompletionGate,
  createVerificationCompletionGate,
} from '../../dist/core/loop/verification-completion-gate.js';

const root = path.resolve(import.meta.dirname, '../..');
const { resolveCliConfig } = await import(
  pathToFileURL(path.join(root, 'dist/cli/config.js')).href
);

let toolUseId = 0;
function call(name, input = {}) {
  const id = `tool-${++toolUseId}`;
  return {
    use: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    result: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
    },
  };
}
function messages(...pairs) {
  return pairs.flatMap((pair) => [pair.use, pair.result]);
}
function writeFile() {
  return call('write_file', { path: 'a.txt', content: 'hi' });
}
function readFile() {
  return call('read_file', { path: 'a.txt' });
}
function exec(command) {
  return call('exec', { command });
}
function reviewChanges(resultText) {
  const id = `tool-${++toolUseId}`;
  return {
    use: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'review_changes', input: { depth: 'quick' } }],
    },
    result: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: resultText }],
    },
  };
}
function review(resultText) {
  const id = `tool-${++toolUseId}`;
  return {
    use: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'create_subagent', input: { expert: 'reviewer' } }],
    },
    result: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: resultText }],
    },
  };
}

const cases = [];
function check(name, fn) {
  try {
    fn();
    cases.push({ name, ok: true });
    console.log(`[verification-gate] PASS ${name}`);
  } catch (err) {
    cases.push({ name, ok: false, error: err });
    console.log(`[verification-gate] FAIL ${name}: ${err.message}`);
  }
}

check('edit with no check afterwards is held', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'Done — the file was written successfully.',
    messages: messages(writeFile()),
  });
  assert.equal(decision.ok, false);
});

check('read_file after the last edit passes', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'Done.',
    messages: messages(writeFile(), readFile()),
  });
  assert.equal(decision.ok, true);
});

check('a test/lint/build command after the edit passes', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'Done, npm test is green.',
    messages: messages(writeFile(), exec('npm run test -- --run')),
  });
  assert.equal(decision.ok, true);
});

check('a non-check command does not count', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'Done.',
    messages: messages(writeFile(), exec('rm -rf build')),
  });
  assert.equal(decision.ok, false);
});

check('an explicit unverified disclosure passes', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'The change is unverified — I did not run anything after writing it.',
    messages: messages(writeFile()),
  });
  assert.equal(decision.ok, true);
});

check('an unaddressed review FAIL is held', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'Everything is fine — the change is complete and correct.',
    messages: messages(
      writeFile(),
      review('## Reviewer verdict: **FAIL**\n[Critical finding] calc.js:2')
    ),
  });
  assert.equal(decision.ok, false);
});

check('a review FAIL that the answer owns passes', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'The reviewer reported a Critical finding at calc.js:2; it remains unresolved.',
    messages: messages(
      writeFile(),
      readFile(),
      review('## Reviewer verdict: **FAIL**\n[Critical finding] calc.js:2')
    ),
  });
  assert.equal(decision.ok, true);
});

check('a later PASS clears an earlier FAIL', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'Fixed and re-reviewed.',
    messages: messages(
      writeFile(),
      readFile(),
      review('## Reviewer verdict: **FAIL**\n[Critical finding] calc.js:2'),
      review('## Reviewer verdict: **PASS**')
    ),
  });
  assert.equal(decision.ok, true);
});

check('an unaddressed review_changes FAIL is held', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'All done — the change is complete and correct.',
    messages: messages(
      writeFile(),
      readFile(),
      reviewChanges('Independent review (working tree + staged changes, quick) — verdict: FAIL')
    ),
  });
  assert.equal(decision.ok, false);
});

check('a review_changes PASS clears an earlier FAIL', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'Fixed and re-reviewed.',
    messages: messages(
      writeFile(),
      readFile(),
      reviewChanges('Independent review (working tree + staged changes, quick) — verdict: FAIL'),
      reviewChanges('Independent review (working tree + staged changes, quick) — verdict: PASS')
    ),
  });
  assert.equal(decision.ok, true);
});

check('runs without file mutations are unaffected', () => {
  const decision = evaluateVerificationCompletionGate({
    response: 'The capital of France is Paris.',
    messages: messages(exec('echo hi')),
  });
  assert.equal(decision.ok, true);
});

check('the gate blocks at most once per run', async () => {
  // Synchronous part: a single request keeps failing, so the wrapper state is
  // what makes it finite. Exercised below with the wrapper itself.
});

const wrapper = createVerificationCompletionGate();
const request = {
  sessionKey: 'probe',
  runId: 'probe-run',
  turn: 1,
  response: 'Done.',
  messages: messages(writeFile()),
  totalToolCalls: 1,
  toolCallsByName: { write_file: 1 },
};
const first = await wrapper(request);
const second = await wrapper(request);
check('an unverified change is asked for exactly once', () => {
  assert.equal(first.ok, false);
  assert.equal(typeof first.retryLimit, 'number');
  assert.equal(second.ok, true);
});

const reviewWrapper = createVerificationCompletionGate();
const reviewRequest = {
  sessionKey: 'probe',
  runId: 'probe-review-run',
  turn: 1,
  response: 'Everything is fine.',
  messages: messages(
    writeFile(),
    readFile(),
    review('## Reviewer verdict: **FAIL**\n[Critical finding] calc.js:2')
  ),
  totalToolCalls: 2,
  toolCallsByName: { write_file: 1, read_file: 1, create_subagent: 1 },
};
const reviewDecisions = [];
for (let i = 0; i < 4; i += 1) reviewDecisions.push(await reviewWrapper(reviewRequest));
check('a review FAIL allows three bounded repair cycles, then stops', () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal(reviewDecisions[i].ok, false);
    assert.equal(typeof reviewDecisions[i].retryLimit, 'number');
  }
  assert.equal(reviewDecisions[3].ok, true);
});

// ── review.mode: auto ─────────────────────────────────────────────────────

const autoGate = createVerificationCompletionGate({ reviewMode: 'auto' });
const autoUnreviewed = {
  sessionKey: 'probe',
  runId: 'probe-auto-run',
  turn: 1,
  response: 'done',
  messages: messages(writeFile(), readFile()),
  totalToolCalls: 2,
  toolCallsByName: { write_file: 1, read_file: 1 },
};
const autoFirst = await autoGate(autoUnreviewed);
check('review.mode=auto holds a changed run that never reviewed', () => {
  assert.equal(autoFirst.ok, false);
  assert.match(String(autoFirst.reason), /never reviewed/);
});
const autoSecond = await autoGate(autoUnreviewed);
check('auto-review correction is bounded to one nudge', () => {
  assert.equal(autoSecond.ok, true);
});
const autoReviewed = await autoGate({
  ...autoUnreviewed,
  messages: messages(writeFile(), readFile(), reviewChanges('VERDICT: PASS')),
});
check('auto-review accepts a run that reviewed its change', () => {
  assert.equal(autoReviewed.ok, true);
});
const manualGate = createVerificationCompletionGate({ reviewMode: 'manual' });
const manualDecision = await manualGate(autoUnreviewed);
check('review.mode=manual does not force a review', () => {
  assert.equal(manualDecision.ok, true);
});

const reviewedInsteadOfRead = await createVerificationCompletionGate({
  reviewMode: 'auto',
})({
  sessionKey: 'probe',
  runId: 'probe-review-check-run',
  turn: 1,
  response: 'done',
  messages: messages(writeFile(), reviewChanges('VERDICT: PASS')),
  totalToolCalls: 2,
  toolCallsByName: { write_file: 1, review_changes: 1 },
});
check('a recorded review counts as checking the change', () => {
  assert.equal(reviewedInsteadOfRead.ok, true);
});

// ── P0-b escape valve ─────────────────────────────────────────────────────

const disabledGate = createVerificationCompletionGate({ enabled: false });
const disabledDecision = await disabledGate(autoUnreviewed);
check('verificationGate=false turns the whole gate into a no-op', () => {
  assert.equal(disabledDecision.ok, true);
});

const defaultConfig = resolveCliConfig({}, {});
check('the completion gate is on by default', () => {
  assert.equal(defaultConfig.verificationGate, true);
  assert.equal(defaultConfig.verificationGateSource, 'default');
});
const envOff = resolveCliConfig({ MOSS_VERIFICATION_GATE: '0' }, {});
check('MOSS_VERIFICATION_GATE=0 disables it and is visible as an env source', () => {
  assert.equal(envOff.verificationGate, false);
  assert.equal(envOff.verificationGateSource, 'env');
});
const configOff = resolveCliConfig({}, { verificationGate: false });
check('a config file can disable it', () => {
  assert.equal(configOff.verificationGate, false);
  assert.equal(configOff.verificationGateSource, 'config');
});

const failed = cases.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`[verification-gate] ${failed.length} assertion(s) failed`);
  process.exit(1);
}
console.log(`[verification-gate] ${cases.length} assertion(s) passed`);
