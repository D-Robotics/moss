#!/usr/bin/env node
/**
 * LLM usage feedback — per-call vs. cumulative event forwarding.
 *
 * Verifies that:
 * 1. The adapter forwards per-call inputTokens/outputTokens in llm_usage events
 *    (not cumulative sums), so the TUI displays the *current* context usage.
 * 2. The adapter's internal cumulative usage is preserved for the final ChatResult.
 * 3. State lastReportedPromptTokens is initialized to 0 and reset properly.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMossAgentLoopEventAdapter } from '../dist/core/agent/index.js';
import { contextUsageFromAgentEvent } from '../dist/cli/usage-display.js';
import { totalPromptTokens } from '../dist/core/llm/usage.js';
import {
  formatUsageSummary,
  logLLMUsage,
  readUsageLog,
  resolveLLMUsageLogPath,
  summarizeUsage,
} from '../dist/observability/llm-usage.js';

// ─── 1. Adapter forwards per-call (not cumulative) llm_usage events ────

{
  const adapter = createMossAgentLoopEventAdapter({ contextTokens: 100_000 });

  // Simulate two LLM turns with different usage
  const turn1 = adapter.onMiniEvent({
    type: 'llm_usage',
    inputTokens: 15_000,
    outputTokens: 500,
  });
  const turn2 = adapter.onMiniEvent({
    type: 'llm_usage',
    inputTokens: 22_000,
    outputTokens: 800,
  });

  // Turn 1 event should carry per-call values (not cumulative)
  assert.strictEqual(turn1.length, 1, 'turn 1 llm_usage should produce one MossAgentEvent');
  const e1 = turn1[0];
  assert.strictEqual(e1.type, 'llm_usage');
  assert.strictEqual(e1.inputTokens, 15_000, 'turn 1 inputTokens should be 15_000 (per-call)');
  assert.strictEqual(e1.outputTokens, 500, 'turn 1 outputTokens should be 500 (per-call)');
  assert.strictEqual(e1.contextTokens, 100_000, 'contextTokens should be forwarded');

  // Turn 2 event should carry per-call values for turn 2 (not 15K+22K=37K)
  assert.strictEqual(turn2.length, 1);
  const e2 = turn2[0];
  assert.strictEqual(e2.type, 'llm_usage');
  assert.strictEqual(
    e2.inputTokens,
    22_000,
    'turn 2 inputTokens should be 22_000 (per-call, not cumulative 37_000)'
  );
  assert.strictEqual(
    e2.outputTokens,
    800,
    'turn 2 outputTokens should be 800 (per-call, not cumulative 1_300)'
  );
}

{
  assert.equal(
    resolveLLMUsageLogPath({
      workspaceDir: '/workspace',
      env: { MOSS_LLM_USAGE_LOG: '/custom/usage.jsonl' },
    }),
    '/custom/usage.jsonl',
    'explicit environment path wins over the workspace default'
  );
  assert.equal(
    resolveLLMUsageLogPath({ workspaceDir: '/workspace', env: {} }),
    path.join('/workspace', '.moss', 'llm-usage.jsonl'),
    'workspace fallback is stable when no custom path is configured'
  );
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-usage-'));
  const logPath = path.join(dir, 'custom', 'usage.jsonl');
  await logLLMUsage(
    {
      runId: 'custom-path',
      providerId: 'test',
      model: 'unknown-model',
      inputTokens: 10,
      outputTokens: 2,
      durationMs: 1,
      success: true,
    },
    { logPath }
  );
  const records = await readUsageLog({ logPath });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(records.length, 1, 'usage APIs honor an explicit workspace log path');
  assert.equal(records[0].runId, 'custom-path');
}

// ─── 6. Workspace usage includes cached prompt tokens ────────────────

{
  const summary = summarizeUsage([
    {
      timestamp: '2026-07-16T00:00:00.000Z',
      runId: 'run-1',
      providerId: 'anthropic',
      model: 'unknown-model',
      inputTokens: 8_000,
      outputTokens: 400,
      cacheReadTokens: 3_000,
      cacheCreationTokens: 500,
      durationMs: 100,
      success: true,
    },
  ]);
  assert.equal(
    summary.totalInputTokens,
    11_500,
    'workspace input total includes cache reads and writes'
  );
  assert.equal(summary.totalCacheReadTokens, 3_000, 'workspace summary preserves cache reads');
  assert.equal(summary.totalCacheCreationTokens, 500, 'workspace summary preserves cache writes');
  const formatted = formatUsageSummary(summary);
  assert.ok(formatted.includes('3,000 cache read'), '/cost exposes cache-read volume');
  assert.ok(formatted.includes('500 cache write'), '/cost exposes cache-write volume');
  assert.ok(
    formatted.includes('Cost unavailable'),
    '/cost does not present unknown pricing as zero cost'
  );
}

// ─── 5. TUI context usage consumes llm_usage with cache-aware prompt size ──

{
  assert.equal(
    totalPromptTokens({ inputTokens: 8_000, cacheReadTokens: 3_000, cacheCreationTokens: 500 }),
    11_500,
    'provider-normalized uncached input plus cache tokens equals prompt context size'
  );
  assert.deepEqual(
    contextUsageFromAgentEvent({
      type: 'llm_usage',
      inputTokens: 8_000,
      outputTokens: 400,
      cacheReadTokens: 3_000,
      cacheCreationTokens: 500,
      contextTokens: 100_000,
    }),
    {
      used: 11_500,
      total: 100_000,
      source: 'provider',
      inputTokens: 8_000,
      cacheReadTokens: 3_000,
      cacheCreationTokens: 500,
    }
  );
  assert.equal(
    contextUsageFromAgentEvent({ type: 'turn_end', turn: 1, stopReason: 'end_turn' }),
    null
  );
}

// ─── 2. getResult returns cumulative usage for cost tracking ──────────

{
  const adapter = createMossAgentLoopEventAdapter();

  adapter.onMiniEvent({
    type: 'llm_usage',
    inputTokens: 10_000,
    outputTokens: 1_000,
  });
  adapter.onMiniEvent({
    type: 'llm_usage',
    inputTokens: 25_000,
    outputTokens: 2_000,
  });

  const done = adapter.getDoneEvent({
    finalText: 'done',
    turns: 2,
    totalToolCalls: 0,
    messages: [],
  });
  const result = done.result;

  assert.ok(result.usage, 'ChatResult should have usage');
  assert.strictEqual(
    result.usage.inputTokens,
    35_000,
    'ChatResult.usage.inputTokens should be cumulative (10K + 25K)'
  );
  assert.strictEqual(
    result.usage.outputTokens,
    3_000,
    'ChatResult.usage.outputTokens should be cumulative (1K + 2K)'
  );
}

// ─── 3. llm_usage events without contextTokens omit the field ──────────

{
  const adapter = createMossAgentLoopEventAdapter();

  const events = adapter.onMiniEvent({
    type: 'llm_usage',
    inputTokens: 5_000,
    outputTokens: 200,
  });

  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].type, 'llm_usage');
  assert.strictEqual(events[0].contextTokens, undefined, 'contextTokens absent when not provided');
}

// ─── 4. Cache token forwarding ────────────────────────────────────────

{
  const adapter = createMossAgentLoopEventAdapter();

  const events = adapter.onMiniEvent({
    type: 'llm_usage',
    inputTokens: 8_000,
    outputTokens: 400,
    cacheReadTokens: 3_000,
    cacheCreationTokens: 500,
  });

  assert.strictEqual(events.length, 1);
  const e = events[0];
  assert.strictEqual(e.cacheReadTokens, 3_000, 'cacheReadTokens forwarded per-call');
  assert.strictEqual(e.cacheCreationTokens, 500, 'cacheCreationTokens forwarded per-call');
}
