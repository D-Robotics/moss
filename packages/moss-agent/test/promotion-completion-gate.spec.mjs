import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapWithPromotionObservation } from '../dist/core/tools/promotion-completion-gate.js';

const request = {
  sessionKey: 'session-1',
  runId: 'run-1',
  turn: 1,
  response: 'done',
  messages: [],
  totalToolCalls: 0,
  toolCallsByName: {},
};

async function captureWarnings(run) {
  const write = process.stderr.write;
  const warnings = [];
  process.stderr.write = (chunk) => {
    warnings.push(String(chunk));
    return true;
  };
  try {
    await run();
  } finally {
    process.stderr.write = write;
  }
  return warnings;
}

test('rejected gate result bypasses promotion and preserves identity', async () => {
  const result = { ok: false, reason: 'not done', correction: 'continue' };
  let calls = 0;
  const wrapped = wrapWithPromotionObservation(async () => result, {
    observeCompletion: async () => {
      calls += 1;
    },
  });

  assert.equal(await wrapped(request), result);
  assert.equal(calls, 0);
});

test('successful gate is observed once and preserves identity', async () => {
  const result = { ok: true };
  let observed;
  const wrapped = wrapWithPromotionObservation(async () => result, {
    observeCompletion: async (completion) => {
      observed = completion;
    },
  });

  assert.equal(await wrapped(request), result);
  assert.equal(observed, request);
});

test('observer failure warns and returns the original successful result', async () => {
  const result = { ok: true };
  const wrapped = wrapWithPromotionObservation(async () => result, {
    observeCompletion: async () => {
      throw new Error('observer failure');
    },
  });

  const warnings = await captureWarnings(async () => {
    assert.equal(await wrapped(request), result);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /promotion observation failed/);
});

test('original gate failure rejects and never runs the observer', async () => {
  const failure = new Error('gate failure');
  let calls = 0;
  const wrapped = wrapWithPromotionObservation(
    async () => {
      throw failure;
    },
    {
      observeCompletion: async () => {
        calls += 1;
      },
    }
  );

  await assert.rejects(wrapped(request), (error) => error === failure);
  assert.equal(calls, 0);
});
