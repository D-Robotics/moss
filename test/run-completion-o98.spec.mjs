#!/usr/bin/env node
/**
 * O98: a headless `moss -p` run must not end on a false success.
 * O14 run2 said "All checks are green" without running format:check (npm run
 * check was red); kimi-k3 r2 changed nothing and exited 0.
 *
 * Stable O99 surface is `run-outcome.ts` (`resolveRunOutcome` /
 * `formatOutcomeLine`); tracker logic stays in `run-completion.ts`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runOneShot } from '../dist/cli/oneshot.js';
import { ExitCode } from '../dist/cli/exit-codes.js';
import {
  createRunCompletionTracker,
  findUnverifiedCheckClaims,
  noteRunCompletionEvent,
} from '../dist/cli/run-completion.js';
import { formatOutcomeLine, resolveRunOutcome } from '../dist/cli/run-outcome.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

function execEvents(tracker, id, command, result, isError = false) {
  noteRunCompletionEvent(tracker, {
    type: 'tool_start',
    toolName: 'exec',
    toolCallId: id,
    input: { command },
  });
  noteRunCompletionEvent(tracker, {
    type: 'tool_end',
    toolName: 'exec',
    toolCallId: id,
    result,
    isError,
  });
}

// --- Unit: claims vs. real runs + stable RunOutcome ------------------------
{
  const t = createRunCompletionTracker();
  execEvents(t, '1', 'npm run lint', 'exit code 0');
  execEvents(t, '2', 'npm run typecheck', 'exit code 0');
  assert.deepEqual(findUnverifiedCheckClaims('All checks are green.', t), ['check']);
  assert.deepEqual(findUnverifiedCheckClaims('Lint passes and typecheck is clean.', t), []);
  assert.deepEqual(findUnverifiedCheckClaims('prettier --check passed', t), ['format']);
  assert.deepEqual(findUnverifiedCheckClaims('所有检查都通过了', t), ['check']);

  const outcome = resolveRunOutcome({ tracker: t, finalText: 'All checks are green.' });
  assert.equal(outcome.status, 'unverified');
  assert.equal(outcome.exitCode, ExitCode.INCOMPLETE);
  assert.notEqual(outcome.exitCode, 0);
  assert.match(outcome.reason, /npm run check/);
  assert.match(outcome.reasonZh, /npm run check/);
  assert.match(formatOutcomeLine(outcome, 'zh'), /^未核实：.*npm run check.*；卡在：/);
  assert.match(formatOutcomeLine(outcome, 'en'), /^Unverified: .*npm run check.*stuck at:/);
}
{
  // A failed `npm run check` does not back the claim either → unverified.
  const t = createRunCompletionTracker();
  execEvents(t, '1', 'npm run check', 'format:check failed\nexit code 1');
  assert.deepEqual(findUnverifiedCheckClaims('npm run check passes.', t), ['check']);
  const outcome = resolveRunOutcome({ tracker: t, finalText: 'npm run check passes.' });
  assert.equal(outcome.status, 'unverified');
  assert.match(formatOutcomeLine(outcome, 'zh'), /卡在：exec: npm run check/);
}
{
  // Really ran and passed: completed, exit 0, empty line.
  const t = createRunCompletionTracker();
  execEvents(t, '1', 'npm run check', 'exit code 0');
  noteRunCompletionEvent(t, {
    type: 'tool_start',
    toolName: 'edit_file',
    toolCallId: 'e',
    input: { path: 'src/a.ts' },
  });
  noteRunCompletionEvent(t, {
    type: 'tool_end',
    toolName: 'edit_file',
    toolCallId: 'e',
    result: 'ok',
    isError: false,
  });
  const outcome = resolveRunOutcome({
    tracker: t,
    finalText: 'All checks are green.',
    request: 'fix src/a.ts',
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.exitCode, 0);
  assert.equal(formatOutcomeLine(outcome, 'zh'), '');
  assert.deepEqual(
    findUnverifiedCheckClaims(
      'I did not run tests; checks not green yet.',
      createRunCompletionTracker()
    ),
    []
  );
}
{
  // Edit task, zero files changed → incomplete (not unverified).
  const outcome = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'Done.',
    request: '修复 src/cli/hooks.ts 的超时问题',
  });
  assert.equal(outcome.status, 'incomplete');
  assert.match(
    formatOutcomeLine(outcome, 'zh'),
    /^未完成：任务需要改动文件，但本次运行没有修改任何文件/
  );
  assert.match(formatOutcomeLine(outcome, 'en'), /^Incomplete: the task needed file changes/);
  assert.equal(
    resolveRunOutcome({
      tracker: createRunCompletionTracker(),
      finalText: 'x',
      request: '怎么修复这个问题？',
    }).status,
    'completed'
  );
}

// --- Integration: runOneShot text mode (what `moss -p` uses) --------------
async function runPrint(name, turns, prompt, registerTools) {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), `moss-o98-${name}-`));
  const agent = new MossAgent({
    llmProvider: createMockTranscriptProvider(name, 'O98', turns),
    sessionStore: new InMemorySessionStore(),
    model: name,
    workspaceDir: ws,
    baseSystemPrompt: 'Test.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 6,
  });
  registerTools?.(agent);
  let out = '';
  const previous = process.exitCode;
  process.exitCode = undefined;
  await runOneShot(agent, prompt, {
    sessionKey: `o98-${name}`,
    outputFormat: 'text',
    headless: true,
    cwd: ws,
    stdout: { write: (s) => ((out += s), true) },
  });
  const code = process.exitCode;
  process.exitCode = previous;
  await fs.rm(ws, { recursive: true, force: true });
  return { out, code };
}

const prevLang = process.env.MOSS_LANG;
process.env.MOSS_LANG = 'zh';
try {
  // O14 run2 shape: lint ran, format:check never ran, answer says "All checks are green".
  const r = await runPrint(
    'false-green',
    [
      { toolCalls: [{ name: 'shell_probe', input: { command: 'npm run lint' } }] },
      { text: 'Updated the hook. All checks are green.' },
    ],
    'Check the repo lint status and report.',
    (agent) =>
      agent.tools.register({
        name: 'shell_probe',
        description: 'probe',
        metadata: { sideEffectClass: 'readonly' },
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
        async execute() {
          return 'exit code 0';
        },
      })
  );
  assert.notEqual(r.code ?? 0, 0, `false "all green" must not exit 0 (got ${r.code})`);
  const last = r.out.trimEnd().split('\n').at(-1);
  assert.match(last, /^(未核实：|Unverified: )/, `last line must say unverified, got: ${last}`);
  assert.match(last, /npm run check/);

  // kimi-k3 r2 shape: edit task, no tool calls, "done" → non-zero + 未完成 line.
  const k = await runPrint(
    'no-edit',
    [{ text: 'Done, the fix is in place.' }],
    'Fix the timeout clamp in src/cli/hooks.ts'
  );
  assert.notEqual(k.code ?? 0, 0, 'edit task with zero changes must not exit 0');
  assert.match(k.out.trimEnd().split('\n').at(-1), /^(未完成：|Incomplete: )/);

  // Honest answer to a question: unchanged, exit 0, no incomplete/unverified line.
  const ok = await runPrint(
    'honest',
    [{ text: 'Lint was not run in this session.' }],
    'What does npm run check do?'
  );
  assert.equal(ok.code ?? 0, 0);
  assert.doesNotMatch(ok.out, /未完成：|未核实：|Incomplete: |Unverified: /);
} finally {
  if (prevLang === undefined) delete process.env.MOSS_LANG;
  else process.env.MOSS_LANG = prevLang;
}

console.log('run-completion-o98: ok');
