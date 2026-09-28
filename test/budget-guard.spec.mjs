#!/usr/bin/env node
/**
 * Run-budget guardrails (v0.9 W3) — unattended ceilings stop the run
 * GRACEFULLY: a terminal result event with subtype error_budget_exceeded,
 * partial output preserved, never a hard crash.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOneShot } from '../dist/cli/oneshot.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

function loopingProvider(captured) {
  let round = 0;
  return {
    id: 'budget',
    displayName: 'budget',
    capabilities: { streaming: true },
    async complete(opts) {
      captured.push(opts);
      if (!opts.tools || opts.tools.length === 0) {
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'SUMMARY.' }],
          usage: { inputTokens: 100, outputTokens: 20 },
        };
      }
      round += 1;
      if (round <= 10) {
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: `round ${round}` },
            { type: 'tool_use', id: `tu_${round}`, name: 'spin', input: {} },
          ],
          usage: { inputTokens: 5_000, outputTokens: 100 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    async stream(opts, cb) {
      cb?.({ type: 'message_start' });
      return this.complete(opts);
    },
  };
}

function makeAgent(budget) {
  const captured = [];
  const agent = new MossAgent({
    llmProvider: loopingProvider(captured),
    sessionStore: new InMemorySessionStore(),
    model: 'm',
    workspaceDir: process.cwd(),
    baseSystemPrompt: 'You are Moss.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 40,
    ...(budget ? { budget } : {}),
  });
  agent.tools.register({
    name: 'spin',
    description: 'spin',
    metadata: { sideEffectClass: 'readonly' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return 'spun';
    },
  });
  return { agent, captured };
}

// runOneShot sets process.exitCode on error results (budget stops are
// errors by design); the spec process must not inherit that exit code.
function withExitCodeIsolated(fn) {
  return async () => {
    const saved = process.exitCode;
    try {
      await fn();
    } finally {
      process.exitCode = saved;
    }
  };
}

function writer() {
  let out = '';
  return {
    writer: { write: (c) => (out += c) },
    events: () =>
      out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

test(
  'maxToolCalls ceiling: graceful stop with error_budget_exceeded',
  withExitCodeIsolated(async () => {
    const { agent } = makeAgent({ maxToolCalls: 3 });
    const w = writer();
    await runOneShot(agent, 'run the spin tool repeatedly until the work is done', {
      sessionKey: 'budget-tools',
      outputFormat: 'stream-json',
      stdout: w.writer,
    });
    const events = w.events();
    const result = events[events.length - 1];
    assert.equal(result.type, 'result', 'terminal result event');
    assert.equal(result.subtype, 'error_budget_exceeded', 'budget subtype');
    assert.equal(result.is_error, true);
    assert.match(result.error, /tool.calls/, 'names the breached limit');
    const toolCalls = events.filter((e) => e.type === 'user').length;
    assert.ok(toolCalls <= 4, `stopped near the ceiling (tool results: ${toolCalls})`);
  })
);

test(
  'maxTokens ceiling: stops before burning the whole budget again',
  withExitCodeIsolated(async () => {
    const { agent, captured } = makeAgent({ maxTokens: 12_000 });
    const w = writer();
    await runOneShot(agent, 'run the spin tool repeatedly until the work is done', {
      sessionKey: 'budget-tokens',
      outputFormat: 'stream-json',
      stdout: w.writer,
    });
    const events = w.events();
    const result = events[events.length - 1];
    assert.equal(result.subtype, 'error_budget_exceeded');
    const totalIn = captured.reduce((n, o) => n + (o.messages ?? []).length, 0);
    assert.ok(
      captured.length < 10,
      `stopped early (${captured.length} model calls, ${totalIn} message-units)`
    );
  })
);

test(
  'no budget: the same loop runs to completion (no false trips)',
  withExitCodeIsolated(async () => {
    const { agent } = makeAgent(undefined);
    const w = writer();
    await runOneShot(agent, 'run the spin tool repeatedly until the work is done', {
      sessionKey: 'budget-none',
      outputFormat: 'stream-json',
      stdout: w.writer,
    });
    const events = w.events();
    const result = events[events.length - 1];
    assert.equal(result.subtype, 'success', 'unbudgeted run completes');
  })
);

console.log('[PASS] run-budget guardrails');
