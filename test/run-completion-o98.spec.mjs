#!/usr/bin/env node
/**
 * O98: a headless `moss -p` run must not end on a false success.
 * Spec: /workspace/specs/O98.md (A–E + completed line + VERIFY_CMD).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runOneShot } from '../dist/cli/oneshot.js';
import {
  createRunCompletionTracker,
  findUnverifiedCheckClaims,
  noteGoalVerifyResult,
  noteRunCompletionEvent,
} from '../dist/cli/run-completion.js';
import { formatOutcomeLine, resolveRunOutcome } from '../dist/cli/run-outcome.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';
import { setLifecycleHookRunner } from '../dist/cli/hooks.js';
import { renderRunSummary } from '../dist/cli/tui/transcript.js';

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

  // E: no VERIFY_CMD, false claim → unverified, exit 0,「未验证」
  const outcome = resolveRunOutcome({ tracker: t, finalText: 'All checks are green.' });
  assert.equal(outcome.status, 'unverified');
  assert.equal(outcome.exitCode, 0, 'soft unverified must not force non-zero');
  assert.match(formatOutcomeLine(outcome, 'zh'), /^未验证：/);
  assert.match(formatOutcomeLine(outcome, 'en'), /^Unverified: /);
  assert.doesNotMatch(formatOutcomeLine(outcome, 'zh'), /未核实/);
}

{
  // Failed npm run check + claim → still soft unverified (no VERIFY_CMD field)
  const t = createRunCompletionTracker();
  execEvents(t, '1', 'npm run check', 'format:check failed\nexit code 1');
  const outcome = resolveRunOutcome({ tracker: t, finalText: 'npm run check passes.' });
  assert.equal(outcome.status, 'unverified');
  assert.equal(outcome.exitCode, 0);
  assert.match(formatOutcomeLine(outcome, 'zh'), /未验证：/);
}

{
  // A-unit: VERIFY_CMD failed → verify_failed, non-0, never empty completed line
  const t = createRunCompletionTracker();
  noteGoalVerifyResult(t, {
    command: 'npm run check',
    passed: false,
    exitCode: 1,
    error: 'format:check failed',
  });
  const outcome = resolveRunOutcome({
    tracker: t,
    finalText: 'All checks are green.',
  });
  assert.equal(outcome.status, 'verify_failed');
  assert.notEqual(outcome.exitCode, 0);
  assert.match(formatOutcomeLine(outcome, 'zh'), /^验证失败：/);
  assert.match(
    formatOutcomeLine(outcome, 'zh'),
    /模型声称通过，但验证失败|format:check|npm run check/
  );
}

{
  // C-unit: verify timeout / spawn → verify_failed
  const timed = createRunCompletionTracker();
  noteGoalVerifyResult(timed, {
    command: 'sleep 999',
    passed: false,
    timedOut: true,
    error: 'timed out after 1000ms',
  });
  const to = resolveRunOutcome({ tracker: timed, finalText: 'done' });
  assert.equal(to.status, 'verify_failed');
  assert.notEqual(to.exitCode, 0);
  assert.match(formatOutcomeLine(to, 'zh'), /超时/);

  const spawn = createRunCompletionTracker();
  noteGoalVerifyResult(spawn, {
    command: 'no-such-verify-bin',
    passed: false,
    spawnFailed: true,
    error: 'ENOENT',
  });
  const sp = resolveRunOutcome({ tracker: spawn, finalText: 'done' });
  assert.equal(sp.status, 'verify_failed');
  assert.match(formatOutcomeLine(sp, 'zh'), /未能启动|ENOENT/);
}

{
  // Truly completed: line is「完成：…」, never empty
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
  assert.match(formatOutcomeLine(outcome, 'zh'), /^完成：/);
  assert.match(formatOutcomeLine(outcome, 'en'), /^Completed: /);
  assert.notEqual(formatOutcomeLine(outcome, 'zh'), '');
}

{
  // D: edit task, zero files → incomplete non-0「未完成：没有改动任何文件」
  const outcome = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'Done.',
    request: '修复 src/cli/hooks.ts 的超时问题',
  });
  assert.equal(outcome.status, 'incomplete');
  assert.notEqual(outcome.exitCode, 0);
  assert.match(formatOutcomeLine(outcome, 'zh'), /^未完成：没有改动任何文件/);
  assert.match(formatOutcomeLine(outcome, 'en'), /^Incomplete: no files were modified/);
  assert.equal(
    resolveRunOutcome({
      tracker: createRunCompletionTracker(),
      finalText: 'x',
      request: '怎么修复这个问题？',
    }).status,
    'completed'
  );
}

{
  // Blocked Stop hook
  const outcome = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'done',
    blocked: true,
    blockedReason: 'Stop hook wants more work',
  });
  assert.equal(outcome.status, 'blocked');
  assert.notEqual(outcome.exitCode, 0);
  assert.match(formatOutcomeLine(outcome, 'zh'), /^被拦：/);
}

{
  // TUI: outcome sits under the done stamp
  const lines = renderRunSummary(
    5000,
    false,
    80,
    undefined,
    new Date('2026-10-01T09:05:00'),
    '完成：运行结束'
  );
  const texts = lines.map((l) => l.text.trim()).filter(Boolean);
  assert.ok(texts.some((t) => /done|完成于/.test(t)));
  assert.ok(texts.some((t) => t === '完成：运行结束'));
  const halted = renderRunSummary(5000, true, 80, undefined, new Date(), '完成：运行结束');
  assert.ok(!halted.some((l) => l.text.includes('完成：运行结束')), 'halted runs omit outcome');
}

// --- Integration: runOneShot text mode (what `moss -p` uses) --------------
async function runPrint(name, turns, prompt, registerTools, env = {}) {
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
    maxAgentTurns: 8,
  });
  registerTools?.(agent);
  let out = '';
  const previous = process.exitCode;
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.exitCode = undefined;
  try {
    await runOneShot(agent, prompt, {
      sessionKey: `o98-${name}`,
      outputFormat: 'text',
      headless: true,
      cwd: ws,
      stdout: { write: (s) => ((out += s), true) },
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  const code = process.exitCode;
  process.exitCode = previous;
  await fs.rm(ws, { recursive: true, force: true });
  return { out, code };
}

const prevLang = process.env.MOSS_LANG;
process.env.MOSS_LANG = 'zh';
try {
  // E integration: no VERIFY_CMD, claim green without running check → 未验证, exit 0
  const soft = await runPrint(
    'soft-unverified',
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
  assert.equal(soft.code ?? 0, 0, 'soft unverified stays exit 0');
  assert.match(soft.out.trimEnd().split('\n').at(-1), /^(未验证：|Unverified: )/);

  // D integration: kimi-k3 r2 — edit task, no tools → non-0 + 未完成
  const k = await runPrint(
    'no-edit',
    [{ text: 'Done, the fix is in place.' }],
    'Fix the timeout clamp in src/cli/hooks.ts'
  );
  assert.notEqual(k.code ?? 0, 0, 'edit task with zero changes must not exit 0');
  assert.match(
    k.out.trimEnd().split('\n').at(-1),
    /^(未完成：没有改动任何文件|Incomplete: no files were modified)/
  );

  // Honest Q&A: completed line, exit 0
  const ok = await runPrint(
    'honest',
    [{ text: 'Lint was not run in this session.' }],
    'What does npm run check do?'
  );
  assert.equal(ok.code ?? 0, 0);
  assert.match(ok.out.trimEnd().split('\n').at(-1), /^(完成：|Completed: )/);

  // A: VERIFY_CMD fails + model says green → verify_failed non-0
  // depth starts 0 → one continuation; mock has a second turn that still claims green;
  // VERIFY_CMD stays failing → re-verify → verify_failed.
  const failScript = path.join(os.tmpdir(), `moss-o98-fail-${Date.now()}.mjs`);
  await fs.writeFile(failScript, 'process.exit(1);\n');
  const a = await runPrint(
    'verify-fail',
    [
      { text: 'All checks are green.' },
      // continuation turn after first verify failure
      { text: 'Fixed. All checks are green.' },
    ],
    'Ship the fix.',
    undefined,
    {
      MOSS_GOAL_VERIFY_LOOP: '1',
      MOSS_GOAL_VERIFY_CMD: `node ${failScript}`,
    }
  );
  assert.notEqual(a.code ?? 0, 0, 'A: VERIFY_CMD failure must exit non-zero');
  assert.match(a.out.trimEnd().split('\n').at(-1), /^(验证失败：|Verify failed: )/);
  await fs.rm(failScript, { force: true });

  // B: first VERIFY fails, continuation succeeds → exit 0 + 完成
  const flipScript = path.join(os.tmpdir(), `moss-o98-flip-${Date.now()}.mjs`);
  const flipState = path.join(os.tmpdir(), `moss-o98-flip-state-${Date.now()}.txt`);
  await fs.writeFile(
    flipScript,
    `
import fs from 'node:fs';
const p = ${JSON.stringify(flipState)};
if (!fs.existsSync(p)) { fs.writeFileSync(p, '1'); process.exit(1); }
process.exit(0);
`
  );
  const b = await runPrint(
    'verify-flip',
    [{ text: 'Working on it.' }, { text: 'Done now.' }],
    'Ship the fix.',
    undefined,
    {
      MOSS_GOAL_VERIFY_LOOP: '1',
      MOSS_GOAL_VERIFY_CMD: `node ${flipScript}`,
    }
  );
  assert.equal(b.code ?? 0, 0, 'B: re-verify success must exit 0');
  assert.match(b.out.trimEnd().split('\n').at(-1), /^(完成：|Completed: )/);
  await fs.rm(flipScript, { force: true });
  await fs.rm(flipState, { force: true });

  // B-fail: continue still fails → non-0
  const fail2 = path.join(os.tmpdir(), `moss-o98-fail2-${Date.now()}.mjs`);
  await fs.writeFile(fail2, 'process.exit(1);\n');
  const bFail = await runPrint(
    'verify-still-fail',
    [{ text: 'try 1' }, { text: 'try 2 still broken' }],
    'Ship the fix.',
    undefined,
    {
      MOSS_GOAL_VERIFY_LOOP: '1',
      MOSS_GOAL_VERIFY_CMD: `node ${fail2}`,
    }
  );
  assert.notEqual(bFail.code ?? 0, 0, 'B: re-verify still failing → non-0');
  assert.match(bFail.out.trimEnd().split('\n').at(-1), /^(验证失败：|Verify failed: )/);
  await fs.rm(fail2, { force: true });

  // C: VERIFY_CMD does not exist → non-0, reason visible
  const c = await runPrint('verify-missing', [{ text: 'All done.' }], 'Ship the fix.', undefined, {
    MOSS_GOAL_VERIFY_LOOP: '1',
    MOSS_GOAL_VERIFY_CMD: path.join(os.tmpdir(), `moss-o98-no-such-${Date.now()}`),
  });
  assert.notEqual(c.code ?? 0, 0, 'C: missing VERIFY_CMD must exit non-zero');
  assert.match(c.out.trimEnd().split('\n').at(-1), /^(验证失败：|Verify failed: )/);

  // Stop hook blocked in headless → non-0 + 被拦
  setLifecycleHookRunner({
    async runStop() {
      return { blocked: true, reason: 'tests still red' };
    },
    async runSubagentStop() {},
  });
  try {
    const blocked = await runPrint('stop-blocked', [{ text: 'Done.' }], 'What is 2+2?');
    assert.notEqual(blocked.code ?? 0, 0, 'Stop hook blocked must exit non-zero in headless');
    assert.match(blocked.out.trimEnd().split('\n').at(-1), /^(被拦：|Blocked: )/);
  } finally {
    setLifecycleHookRunner(undefined);
  }
} finally {
  if (prevLang === undefined) delete process.env.MOSS_LANG;
  else process.env.MOSS_LANG = prevLang;
}

console.log('run-completion-o98: ok');
