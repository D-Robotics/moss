#!/usr/bin/env node
/**
 * Deterministic probe for the L1 verification completion gate (D-acceptance).
 * Asserts the decision table against dist/, so a regression in what counts as
 * "checked" fails the fast gate instead of only showing up in a model run.
 */
import assert from 'node:assert/strict';
import {
  evaluateVerificationCompletionGate,
  createVerificationCompletionGate,
} from '../../dist/core/loop/verification-completion-gate.js';

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
check('wrapper retryLimit is exactly one', () => {
  assert.equal(first.ok, false);
  assert.equal(first.retryLimit, 1);
  assert.equal(second.ok, true);
});

const failed = cases.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`[verification-gate] ${failed.length} assertion(s) failed`);
  process.exit(1);
}
console.log(`[verification-gate] ${cases.length} assertion(s) passed`);
