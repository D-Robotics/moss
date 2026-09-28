#!/usr/bin/env node
/**
 * /usage and /export — session cumulative usage + markdown export.
 * Locks the accumulator math and the registry command behavior with a stub
 * CommandContext (agent stub backed by InMemorySessionStore).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionUsageAccumulator } from '../dist/cli/session-usage.js';
import { runRegistryCommand, registryCommandNames } from '../dist/cli/commands/registry.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

// ─── accumulator ─────────────────────────────────────────────────────────────

{
  const acc = createSessionUsageAccumulator();
  // non-usage events are ignored
  acc.record({ type: 'microcompact', compressedCount: 1, savedChars: 10, savedTokens: 5 });
  assert.equal(acc.summary().calls, 0, 'non-usage events ignored');

  acc.record({
    type: 'llm_usage',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 7,
    cacheCreationTokens: 3,
    contextTokens: 1000,
  });
  acc.record({
    type: 'llm_usage',
    inputTokens: 50,
    outputTokens: 10,
    cacheReadTokens: 3,
    contextTokens: 1000,
  });
  const s = acc.summary();
  assert.equal(s.calls, 2, 'accumulates call count');
  assert.equal(s.inputTokens, 150, 'sums input tokens');
  assert.equal(s.outputTokens, 30, 'sums output tokens');
  assert.equal(s.cacheReadTokens, 10, 'sums cache read');
  assert.equal(s.cacheCreationTokens, 3, 'sums cache creation');
  const ctx = acc.latestContextUsage();
  assert.ok(ctx, 'latest context snapshot present');
  assert.equal(ctx.used, 53, 'latest used = 50 input + 3 cache read');
  assert.equal(ctx.total, 1000, 'context total from event');
}

// ─── /usage and /export via the registry ─────────────────────────────────────

function makeCtx({ messages = [], usageSummary = undefined }) {
  const store = new InMemorySessionStore();
  store.replaceMessages('s1', messages);
  const said = [];
  return {
    ctx: {
      agent: { config: { sessionStore: store, contextTokens: 1000, model: 'test-model' } },
      runtime: undefined,
      sessionKey: 's1',
      workspace: process.cwd(),
      surface: 'repl',
      say: (kind, text) => said.push({ kind, text }),
      prefillInput: () => {},
      getSessionUsage: usageSummary ? () => usageSummary : undefined,
    },
    said,
  };
}

{
  assert.ok(registryCommandNames().includes('/usage'), '/usage registered');
  assert.ok(registryCommandNames().includes('/export'), '/export registered');

  const { ctx, said } = makeCtx({
    usageSummary: {
      calls: 3,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 400,
      cacheCreationTokens: 100,
      spanMs: 45000,
      firstAt: 1,
      lastAt: 2,
    },
  });
  const handled = await runRegistryCommand('/usage', ctx);
  assert.equal(handled, true, '/usage handled');
  const text = said[0].text;
  assert.match(text, /3/, 'shows call count');
  assert.match(text, /1,000/, 'shows formatted input tokens');
  assert.match(text, /1,500/, 'shows prompt total incl. cache (1000+400+100)');
}

{
  // no usage yet → guidance, not a crash
  const { ctx, said } = makeCtx({});
  await runRegistryCommand('/usage', ctx);
  assert.match(said[0].text, /No model calls/i, 'empty usage guidance');
}

{
  // /export writes markdown of the session to a temp file
  const dir = mkdtempSync(join(tmpdir(), 'moss-export-spec-'));
  try {
    const messages = [
      { role: 'user', content: 'hello moss' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hi there' },
          { type: 'tool_use', id: 't1', name: 'exec', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'file-a\nfile-b', is_error: false },
        ],
      },
    ];
    const { ctx } = makeCtx({ messages });
    const out = join(dir, 'session.md');
    await runRegistryCommand(`/export ${out}`, ctx);
    const md = readFileSync(out, 'utf8');
    assert.match(md, /# Session s1/, 'title includes session key');
    assert.match(md, /hello moss/, 'user text preserved');
    assert.match(md, /tool_use exec/, 'tool_use rendered');
    assert.match(md, /file-a/, 'tool_result content rendered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  // /export with no messages → clear error
  const { ctx, said } = makeCtx({ messages: [] });
  await runRegistryCommand('/export', ctx);
  assert.equal(said[0].kind, 'error', 'empty export is an error message');
  assert.match(said[0].text, /no messages/i);
}

console.log('[PASS] cli usage accumulation + /usage + /export commands');

// ─── O2: compaction metrics flow through the accumulator ────────────────────

{
  const acc = createSessionUsageAccumulator();
  acc.record({
    type: 'compaction',
    summaryChars: 812,
    droppedMessages: 42,
    tokensBefore: 90_000,
    tokensAfter: 18_000,
    keptToolNames: 5,
  });
  acc.record({ type: 'compaction', summaryChars: 100, droppedMessages: 3 });
  const history = acc.compactionHistory();
  assert.equal(history.length, 2, 'compactions recorded');
  assert.equal(history[0].tokensBefore, 90_000, 'tokensBefore preserved');
  assert.equal(history[0].tokensAfter, 18_000, 'tokensAfter preserved');
  assert.equal(history[0].keptToolNames, 5, 'keptToolNames preserved');
  assert.equal(history[1].tokensBefore, undefined, 'optional fields stay optional');
  // usage summary unaffected by compaction events
  assert.equal(acc.summary().calls, 0, 'compaction events do not count as model calls');
}

// /context renders compaction history when the hook provides it
{
  const { ctx, said } = makeCtx({});
  ctx.getCompactionHistory = () => [
    {
      ts: Date.now(),
      summaryChars: 500,
      droppedMessages: 10,
      tokensBefore: 80_000,
      tokensAfter: 16_000,
      keptToolNames: 4,
    },
  ];
  await runRegistryCommand('/context', ctx);
  assert.match(said[0].text, /compactions 1 this session/, '/context shows compaction count');
  assert.match(said[0].text, /80,000 tokens → 16,000 \(20%\)/, '/context shows compression ratio');
  assert.match(said[0].text, /kept 4 tool\(s\)/, '/context shows kept tool signal');
}
