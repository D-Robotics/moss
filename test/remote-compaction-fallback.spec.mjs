import test from 'node:test';
import assert from 'node:assert/strict';

import { compactHistoryIfNeeded } from '../dist/context/compaction.js';

function messages() {
  return Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index} ALPHA-${index}-${'context '.repeat(30)}`,
    timestamp: index + 1,
  }));
}

function remoteProvider({
  available = true,
  failCompact = false,
  summary = 'REMOTE_SUMMARY',
} = {}) {
  const compactRequests = [];
  let availabilityChecks = 0;
  return {
    compactRequests,
    get availabilityChecks() {
      return availabilityChecks;
    },
    async isAvailable() {
      availabilityChecks += 1;
      return available;
    },
    async compact(request) {
      compactRequests.push(request);
      if (failCompact) throw new Error('remote compact failed');
      return { summary, tokensSaved: 12, method: 'remote' };
    },
  };
}

function localSummarizer({ fail = false, output = 'LOCAL_SUMMARY' } = {}) {
  const calls = [];
  return {
    calls,
    fn: async (request) => {
      calls.push(request);
      if (fail) throw new Error('local summary failed');
      return output;
    },
  };
}

async function compact({ summarize, remoteCompactProvider, abortSignal }) {
  return compactHistoryIfNeeded({
    summarize,
    messages: messages(),
    contextWindowTokens: 2_000,
    forceCompaction: true,
    compactionSettings: { enabled: true, restoreFileContents: false },
    remoteCompactProvider,
    abortSignal,
  });
}

test('remote compaction success never calls the local summarizer', async () => {
  const remote = remoteProvider();
  const local = localSummarizer();
  const result = await compact({ summarize: local.fn, remoteCompactProvider: remote });
  assert.equal(remote.compactRequests.length, 1);
  assert.equal(local.calls.length, 0);
  assert.equal(result.degraded, undefined);
  assert.match(result.summary, /REMOTE_SUMMARY/);
});

test('remote failure falls back to the real local summary contract', async () => {
  const remote = remoteProvider({ failCompact: true });
  const local = localSummarizer();
  const result = await compact({ summarize: local.fn, remoteCompactProvider: remote });
  assert.equal(remote.compactRequests.length, 1);
  assert.ok(local.calls.length >= 1, 'the outer LLM strategy runs');
  for (const call of local.calls) {
    assert.match(call.system, /summar/i);
    assert.match(call.userPrompt, /ALPHA-/);
  }
  assert.equal(result.degraded, true);
  assert.match(result.summary, /LOCAL_SUMMARY/);
});

test('remote and local failure reaches the deterministic summary', async () => {
  const remote = remoteProvider({ failCompact: true });
  const local = localSummarizer({ fail: true });
  const result = await compact({ summarize: local.fn, remoteCompactProvider: remote });
  assert.equal(remote.compactRequests.length, 1);
  assert.ok(local.calls.length >= 1, 'the outer LLM strategy is attempted');
  assert.equal(result.degraded, true);
  assert.doesNotMatch(result.summary, /LOCAL_SUMMARY/);
  assert.match(result.summary, /本地规则生成|message 0 ALPHA-0/);
});

test('an unavailable remote endpoint uses the outer LLM fallback', async () => {
  const remote = remoteProvider({ available: false });
  const local = localSummarizer();
  const result = await compact({ summarize: local.fn, remoteCompactProvider: remote });
  assert.equal(remote.availabilityChecks, 1);
  assert.equal(remote.compactRequests.length, 0);
  assert.ok(local.calls.length >= 1);
  for (const call of local.calls) {
    assert.match(call.system, /summar/i);
    assert.match(call.userPrompt, /ALPHA-/);
  }
  assert.match(result.summary, /LOCAL_SUMMARY/);
});

test('an aborted remote compaction never enters a local fallback', async () => {
  const controller = new AbortController();
  const reason = new Error('compaction cancelled');
  controller.abort(reason);
  const remote = remoteProvider();
  remote.compact = async () => {
    throw reason;
  };
  const local = localSummarizer();
  await assert.rejects(
    () =>
      compact({
        summarize: local.fn,
        remoteCompactProvider: remote,
        abortSignal: controller.signal,
      }),
    (error) => error === reason
  );
  assert.equal(local.calls.length, 0);
});
