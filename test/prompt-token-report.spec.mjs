#!/usr/bin/env node
/**
 * cl100k budget for a fresh interactive turn and `moss -p`.
 * Baseline is this checkout before the prefix cut (tiktoken cl100k_base):
 * interactive 7676, moss -p 6354. Interactive must drop at least 35%.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { measurePromptTokens, smallPromptRepo } from '../scripts/prompt-token-report.mjs';

const BASELINE_INTERACTIVE = 7676;
const BASELINE_PRINT = 6354;

test('fresh interactive request is at least 35% under the cl100k baseline', async () => {
  const dir = smallPromptRepo();
  try {
    const measured = await measurePromptTokens(dir);
    const ceiling = Math.floor(BASELINE_INTERACTIVE * 0.65);
    assert.ok(
      measured.interactive.requestTokens <= ceiling,
      `interactive cl100k ${measured.interactive.requestTokens} exceeds ${ceiling} (35% under ${BASELINE_INTERACTIVE})`
    );
    assert.ok(
      measured.print.requestTokens <= BASELINE_PRINT,
      `moss -p cl100k ${measured.print.requestTokens} exceeds baseline ${BASELINE_PRINT}`
    );
    assert.match(measured.print.systemPrompt, /## MCP Tool Servers/);
    assert.match(measured.interactive.systemPrompt, /## MCP Tool Servers/);
    assert.ok(
      measured.print.toolRows.some((tool) => tool.name === 'mcp__rdk-docs__search'),
      '-p still sends the rdk-docs search tool'
    );
    assert.equal(
      measured.interactive.toolRows.some((tool) => tool.name === 'fan_out_subagents'),
      false,
      'fan_out_subagents stays deferred'
    );
    assert.ok(measured.interactive.toolRows.some((tool) => tool.name === 'tool_search'));
    assert.equal(
      measured.print.toolRows.some((tool) => tool.name === 'tool_search'),
      false,
      'coding -p does not pay for tool_search'
    );
    assert.equal(
      measured.print.toolRows.some((tool) => tool.name === 'ask_user_question'),
      false,
      'moss -p does not pay for ask_user_question'
    );
    assert.ok(
      measured.interactive.toolRows.some((tool) => tool.name === 'ask_user_question'),
      'interactive chat still offers ask_user_question'
    );
    assert.ok(measured.interactive.doingTasksTokens < 627);
    assert.ok(measured.interactive.mcpTokens < 306);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
