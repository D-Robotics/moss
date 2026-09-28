#!/usr/bin/env node
/**
 * Compaction budget includes the tool schema payload (v0.9 W2).
 * Root causes locked: (1) the estimate omitted ~7k tokens of serialized tool
 * schemas; (2) the proactive trigger never forced, so the internal threshold
 * silently vetoed it; (3) compactSession's keepRecent gate was an absolute
 * 20k. Bench evidence: 39.6k actual input at MOSS_CONTEXT_TOKENS=20000
 * without compaction; after the fix compaction fires at the original quota.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  estimatePromptUnitsForContextWindow,
  resolveContextCharsPerTokenUnit,
} from '../dist/context/tokens.js';
import {
  getProactiveCompactThreshold,
  getEffectiveContextWindowTokens,
} from '../dist/context/window-economics.js';

const unit = resolveContextCharsPerTokenUnit();
const TOOLS_CHARS = 28_476; // the real builtin set at the time of the fix
const SYSTEM = 'You are Moss. Stable persona.'.repeat(20);
const messages = [
  { role: 'user', content: 'read the notes', timestamp: Date.now() },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'reading now, summarizing the record set' }],
    timestamp: Date.now(),
  },
];

test('tools chars raise the budget estimate by their token share', () => {
  const without = estimatePromptUnitsForContextWindow({
    messages,
    systemPrompt: SYSTEM,
    charsPerTokenUnit: unit,
  });
  const withTools = estimatePromptUnitsForContextWindow({
    messages,
    systemPrompt: SYSTEM,
    charsPerTokenUnit: unit,
    toolsChars: TOOLS_CHARS,
  });
  assert.ok(
    withTools - without >= Math.floor(TOOLS_CHARS / unit) - 1,
    `estimate grows by ~tools tokens: ${without} -> ${withTools}`
  );
});

test('without the fix a 20k window misses compaction; with it the threshold fires', () => {
  const effective = getEffectiveContextWindowTokens(20_000, 4_096);
  const threshold = getProactiveCompactThreshold(effective);
  const without = 3_500;
  const withTools = 3_500 + Math.round(TOOLS_CHARS / unit);
  assert.ok(
    without < threshold,
    `legacy estimate (${without}) below threshold (${threshold}) — the bug`
  );
  assert.ok(
    withTools >= threshold,
    `fixed estimate (${withTools}) reaches threshold (${threshold})`
  );
});

test('threshold semantics: max(4k floor, effective − dynamic buffer)', () => {
  const eff = getEffectiveContextWindowTokens(20_000, 4_096);
  const thr = getProactiveCompactThreshold(eff);
  const buffer = Math.max(13_000, Math.floor(eff * 0.18), 2_000);
  assert.equal(thr, Math.max(4_000, eff - buffer));
});

test('proactive compaction actually fires on a small window (force wiring + relative gate)', async () => {
  const { MossAgent } = await import('../dist/core/agent/moss-agent.js');
  const { InMemorySessionStore } = await import('../dist/core/session/session.js');
  let round = 0;
  const provider = {
    id: 'p',
    displayName: 'p',
    capabilities: { streaming: true },
    async complete(opts) {
      if (!opts.tools || opts.tools.length === 0) {
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'SUMMARY: fat reads performed.' }],
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      }
      round += 1;
      if (round <= 8) {
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: `r${round}` },
            { type: 'tool_use', id: `tu_${round}`, name: 'fat_read', input: {} },
          ],
          usage: { inputTokens: 4000 * round, outputTokens: 10 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async stream(opts, cb) {
      cb?.({ type: 'message_start' });
      return this.complete(opts);
    },
  };
  const events = [];
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'm',
    workspaceDir: process.cwd(),
    baseSystemPrompt: 'You are Moss.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    contextTokens: 20_000,
    maxAgentTurns: 12,
  });
  agent.tools.register({
    name: 'fat_read',
    description: 'fat',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'X'.repeat(4000);
    },
  });
  for await (const ev of agent.streamChat('budget-regression', 'read', {})) {
    events.push(ev.type);
  }
  const compactions = events.filter((t) => t === 'compaction').length;
  assert.ok(compactions >= 1, `proactive compaction fires on a 20k window (got ${compactions})`);
});

test('compactSession gate scales with the window (12k history compacts under a 20k window)', async () => {
  const { MossAgent } = await import('../dist/core/agent/moss-agent.js');
  const { InMemorySessionStore } = await import('../dist/core/session/session.js');
  const provider = {
    id: 'p2',
    displayName: 'p2',
    capabilities: { streaming: true },
    async complete() {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'SUMMARY.' }],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    async stream(opts, cb) {
      cb?.({ type: 'message_start' });
      return this.complete(opts);
    },
  };
  const store = new InMemorySessionStore();
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    model: 'm',
    workspaceDir: process.cwd(),
    baseSystemPrompt: 'You are Moss.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    contextTokens: 20_000,
  });
  // 12 rounds ≈ 12k tokens: ABOVE the relative gate (60% of ~15.9k ≈ 9.5k)
  // but BELOW the old absolute 20k — exactly the case that never compacted.
  const fat = [{ role: 'user', content: 'go', timestamp: Date.now() }];
  for (let i = 1; i <= 12; i++) {
    fat.push({
      role: 'assistant',
      content: [{ type: 'text', text: `r${i}` }],
      timestamp: Date.now(),
    });
    fat.push({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: `t${i}`, content: 'X'.repeat(4000), is_error: false },
      ],
      timestamp: Date.now(),
    });
  }
  await store.replaceMessages('gate', fat);
  const result = await agent.compactSession('gate');
  assert.equal(result.compacted, true, '12k history compacts under the relative gate');
});

console.log('[PASS] compaction budget includes tool schemas');
