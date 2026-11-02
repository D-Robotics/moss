#!/usr/bin/env node
/**
 * O113: safety/approval incomplete last line → 「被拦：…」/`Blocked by: …`;
 * progress stderr must pass completionTracker so budget lines carry the tool step.
 * Spec: /workspace/specs/O113.md (A–D + UX/QA). Mislabel = BLOCK.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCliToolApprovalHook } from '../dist/cli/approval.js';
import { clearUiLanguage, setSessionUiLanguage } from '../dist/cli/cli-locale.js';
import { setCliApprovalViewAsker } from '../dist/cli/approval-view.js';
import { createConfiguredHookCallbacks } from '../dist/cli/hooks.js';
import {
  runWithApprovalDecision,
  setPermissionRequestRunner,
  wrapApprovalAsker,
  wrapApprovalViewAsker,
} from '../dist/cli/permission-request.js';
import {
  createRunCompletionTracker,
  isSafetyOrApprovalBlockResult,
  noteRunCompletionEvent,
} from '../dist/cli/run-completion.js';
import { formatOutcomeLine, resolveRunOutcome } from '../dist/cli/run-outcome.js';
import { createRunProgressTracker, formatProgressOutcomeLine } from '../dist/cli/run-progress.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { writeFileTool } from '../dist/tools/file-tools.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function banUnknown(line, label) {
  assert.doesNotMatch(line, /未知|unknown|Unknown/i, `${label}: no 未知/unknown — ${line}`);
  assert.doesNotMatch(line, /卡在：\s*(；|$)/, `${label}: empty 卡在 — ${line}`);
  assert.doesNotMatch(line, /stuck at:\s*(;|$)/, `${label}: empty stuck at — ${line}`);
}

function banBlockedMislabel(line, label) {
  assert.doesNotMatch(line, /被拦|Blocked by/i, `${label}: must NOT say 被拦/Blocked by — ${line}`);
}

function feedBlock(t, toolName, command, result) {
  noteRunCompletionEvent(t, {
    type: 'tool_start',
    toolName,
    toolCallId: 'b1',
    input: { command },
  });
  noteRunCompletionEvent(t, {
    type: 'tool_end',
    toolName,
    toolCallId: 'b1',
    result,
    isError: true,
  });
}

function feedFail(t, toolName, detail, result = 'Error: no such file') {
  const input = toolName === 'read_file' ? { path: detail } : { command: detail };
  noteRunCompletionEvent(t, {
    type: 'tool_start',
    toolName,
    toolCallId: 'f1',
    input,
  });
  noteRunCompletionEvent(t, {
    type: 'tool_end',
    toolName,
    toolCallId: 'f1',
    result,
    isError: true,
  });
}

// ── Detector ──────────────────────────────────────────────────────────────
{
  assert.equal(
    isSafetyOrApprovalBlockResult('Blocked dangerous command: 禁止递归删除根目录或用户目录'),
    true
  );
  assert.equal(
    isSafetyOrApprovalBlockResult(
      '已拦截：Blocked dangerous command: 禁止递归删除根目录或用户目录'
    ),
    true
  );
  assert.equal(isSafetyOrApprovalBlockResult('Tool execution denied: User denied exec.'), true);
  assert.equal(isSafetyOrApprovalBlockResult('Command blocked: rm -rf /'), true);
  assert.equal(
    isSafetyOrApprovalBlockResult(
      'Operation blocked by workspace policy. The tool did not inspect.'
    ),
    true
  );
  assert.equal(isSafetyOrApprovalBlockResult('Blocked by read-only safety mode.'), true);
  // Non-blocks
  assert.equal(isSafetyOrApprovalBlockResult('Error: ENOENT: no such file'), false);
  assert.equal(isSafetyOrApprovalBlockResult('exit_code: 1\nfailed'), false);
  assert.equal(isSafetyOrApprovalBlockResult('Command failed (exit 1)'), false);
  assert.equal(isSafetyOrApprovalBlockResult('failed'), false);
  assert.equal(isSafetyOrApprovalBlockResult(undefined), false);
}

// ── A. Safety block → 「被拦：」/`Blocked by:` + tool/command ──────────────
{
  const t = createRunCompletionTracker();
  feedBlock(t, 'exec', 'rm -rf /', 'Blocked dangerous command: 禁止递归删除根目录或用户目录');
  assert.equal(t.lastBlockedStep, 'exec: rm -rf /');
  const o = resolveRunOutcome({
    tracker: t,
    finalText: 'I cannot do that.',
    request: 'Fix src/cli/hooks.ts by cleaning /tmp',
  });
  assert.equal(o.status, 'incomplete');
  assert.equal(o.exitCode, 9);
  assert.equal(o.stuckWasBlocked, true);
  // O121 (UX): the stuck half names what was refused, not the bare step.
  assert.equal(o.stuckAt, 'dangerous command `rm -rf /`');
  const zh = formatOutcomeLine(o, 'zh');
  const en = formatOutcomeLine(o, 'en');
  assert.match(zh, /被拦：危险命令 `rm -rf \/`/);
  assert.match(en, /Blocked by: dangerous command `rm -rf \/`/);
  assert.doesNotMatch(zh, /卡在：/);
  assert.doesNotMatch(en, /stuck at:/);
  banUnknown(zh, 'A zh');
  banUnknown(en, 'A en');
  // Same structure EN/ZH
  assert.equal(/被拦：/.test(zh), /Blocked by:/.test(en));
}

// A2. ZH-prefixed block result still marks blocked
{
  const t = createRunCompletionTracker();
  feedBlock(
    t,
    'exec',
    'rm -rf /',
    '已拦截：Blocked dangerous command: 禁止递归删除根目录或用户目录'
  );
  const o = resolveRunOutcome({
    tracker: t,
    finalText: '不行',
    request: '删掉根目录下的危险脚本并修复 hooks.ts',
  });
  assert.equal(o.stuckWasBlocked, true);
  assert.match(formatOutcomeLine(o, 'zh'), /被拦：危险命令 `rm -rf \/`/);
  assert.match(formatOutcomeLine(o, 'en'), /Blocked by: dangerous command `rm -rf \/`/);
}

// A3. Revert-red: if stuckWasBlocked is ignored, line falls back to 卡在 only
{
  const fake = {
    status: 'incomplete',
    reason: 'no files were modified',
    reasonZh: '没有改动任何文件',
    exitCode: 9,
    stuckAt: 'exec: rm -rf /',
    stuckAtZh: 'exec: rm -rf /',
    stuckWasBlocked: true,
  };
  const withFix = formatOutcomeLine(fake, 'zh');
  assert.match(withFix, /被拦：/);
  // Simulate removing the blocked-half branch: appendStuckHalf without blocked → 卡在
  const withoutFix = `未完成：没有改动任何文件；卡在：exec: rm -rf /`;
  assert.doesNotMatch(withoutFix, /被拦：/);
  assert.notEqual(
    withFix,
    withoutFix,
    'A3: dropping stuckWasBlocked must change the line (revert-red)'
  );
}

// ── B. Non-block cases must NOT say 被拦 / Blocked by (mislabel = BLOCK) ──
{
  // B1 tool fail
  const tFail = createRunCompletionTracker();
  feedFail(tFail, 'read_file', 'src/nope.ts');
  const oFail = resolveRunOutcome({
    tracker: tFail,
    finalText: 'missing',
    request: 'Fix src/a.ts',
  });
  assert.equal(oFail.stuckWasBlocked, undefined);
  const zhFail = formatOutcomeLine(oFail, 'zh');
  const enFail = formatOutcomeLine(oFail, 'en');
  assert.match(zhFail, /卡在：read_file: src\/nope\.ts/);
  assert.match(enFail, /stuck at: read_file: src\/nope\.ts/);
  banBlockedMislabel(zhFail, 'B1 zh');
  banBlockedMislabel(enFail, 'B1 en');

  // B2 zero writes
  const oZero = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'Done.',
    request: 'Fix the timeout in src/cli/hooks.ts',
  });
  assert.equal(oZero.stuckAt, undefined);
  banBlockedMislabel(formatOutcomeLine(oZero, 'zh'), 'B2 zh');
  banBlockedMislabel(formatOutcomeLine(oZero, 'en'), 'B2 en');
  assert.doesNotMatch(formatOutcomeLine(oZero, 'zh'), /卡在：/);

  // B3 budget
  const tBudget = createRunCompletionTracker();
  noteRunCompletionEvent(tBudget, {
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'r1',
    input: { path: 'src/a.ts' },
  });
  const oBudget = resolveRunOutcome({
    tracker: tBudget,
    finalText: 'x',
    runError: 'run budget exceeded before finishing',
  });
  assert.equal(oBudget.stuckWasBlocked, undefined);
  const zhB = formatOutcomeLine(oBudget, 'zh');
  const enB = formatOutcomeLine(oBudget, 'en');
  assert.match(zhB, /卡在：运行预算（read_file: src\/a\.ts）/);
  assert.match(enB, /stuck at: run budget \(read_file: src\/a\.ts\)/);
  banBlockedMislabel(zhB, 'B3 zh');
  banBlockedMislabel(enB, 'B3 en');

  // B4 Q&A completed
  const oOk = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: '2+2=4',
    request: 'What is 2+2?',
  });
  assert.equal(oOk.status, 'completed');
  assert.equal(oOk.exitCode, 0);
  banBlockedMislabel(formatOutcomeLine(oOk, 'zh'), 'B4 zh');
  banBlockedMislabel(formatOutcomeLine(oOk, 'en'), 'B4 en');

  // B5 budget + prior block still uses 卡在 (class path; do not mislabel budget)
  const tMix = createRunCompletionTracker();
  feedBlock(tMix, 'exec', 'rm -rf /', 'Blocked dangerous command: nope');
  noteRunCompletionEvent(tMix, {
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'r2',
    input: { path: 'src/b.ts' },
  });
  const oMix = resolveRunOutcome({
    tracker: tMix,
    finalText: 'x',
    runError: 'run budget exceeded before finishing',
  });
  assert.equal(oMix.stuckWasBlocked, undefined);
  banBlockedMislabel(formatOutcomeLine(oMix, 'zh'), 'B5 zh');
  banBlockedMislabel(formatOutcomeLine(oMix, 'en'), 'B5 en');
  assert.match(formatOutcomeLine(oMix, 'zh'), /卡在：运行预算/);
}

// ── C. Budget: stdout ↔ stderr progress line share tracker step ───────────
{
  const mk = () => {
    const t = createRunCompletionTracker();
    noteRunCompletionEvent(t, {
      type: 'tool_start',
      toolName: 'read_file',
      toolCallId: 'r1',
      input: { path: 'src/a.ts' },
    });
    return t;
  };
  const stdoutO = resolveRunOutcome({
    tracker: mk(),
    finalText: 'x',
    runError: 'Run budget exceeded (tool_calls). Partial output above is the completed work.',
  });
  const withTracker = formatProgressOutcomeLine({
    stopReason: 'budget_tool_calls',
    finalText: 'x',
    tracker: mk(),
    zh: true,
  });
  const withoutTracker = formatProgressOutcomeLine({
    stopReason: 'budget_tool_calls',
    finalText: 'x',
    zh: true,
  });
  // With tracker: step present (matches stdout shape)
  assert.match(withTracker, /卡在：运行预算（read_file: src\/a\.ts）/);
  assert.match(formatOutcomeLine(stdoutO, 'zh'), /卡在：运行预算（read_file: src\/a\.ts）/);
  assert.equal(
    withTracker.includes('read_file: src/a.ts'),
    formatOutcomeLine(stdoutO, 'zh').includes('read_file: src/a.ts'),
    'C: stdout and stderr-with-tracker must both carry the tool step'
  );
  // Without tracker: class only — revert-red if someone drops tracker passing
  assert.match(withoutTracker, /卡在：运行预算/);
  assert.doesNotMatch(withoutTracker, /read_file/);
  assert.notEqual(
    withTracker,
    withoutTracker,
    'C revert-red: removing tracker from formatProgressOutcomeLine must change the line'
  );

  const enWith = formatProgressOutcomeLine({
    stopReason: 'budget_tool_calls',
    finalText: 'x',
    tracker: mk(),
    zh: false,
  });
  const enWithout = formatProgressOutcomeLine({
    stopReason: 'budget_tool_calls',
    finalText: 'x',
    zh: false,
  });
  assert.match(enWith, /stuck at: run budget \(read_file: src\/a\.ts\)/);
  assert.doesNotMatch(enWithout, /read_file/);
  banBlockedMislabel(withTracker, 'C zh');
  banBlockedMislabel(enWith, 'C en');
}

// C2. progress tracker from onEvent feeds completionTracker() (output.ts path)
{
  const lines = [];
  const prog = createRunProgressTracker({
    sink: {
      write(line) {
        lines.push(line);
      },
    },
    zh: true,
    emitToolBoundaries: false,
  });
  prog.onEvent({
    type: 'tool_start',
    toolName: 'read_file',
    toolCallId: 'r1',
    input: { path: 'src/a.ts' },
  });
  const tracked = prog.completionTracker();
  assert.equal(tracked.lastStep, 'read_file: src/a.ts');
  const line = formatProgressOutcomeLine({
    stopReason: 'budget_tool_calls',
    finalText: 'x',
    tracker: tracked,
    zh: true,
  });
  assert.match(line, /卡在：运行预算（read_file: src\/a\.ts）/);
  prog.dispose();
}

// C3. Source guard: output.ts must pass tracker: prog.completionTracker()
{
  const src = fs.readFileSync(path.join(ROOT, 'src/cli/output.ts'), 'utf8');
  assert.match(
    src,
    /formatProgressOutcomeLine\(\{[\s\S]*?tracker:\s*prog\.completionTracker\(\)/,
    'C3 revert-red: output.ts done branch must pass tracker: prog.completionTracker()'
  );
}

// C4. Source guard: stuckWasBlocked / Blocked by in run-outcome
{
  const src = fs.readFileSync(path.join(ROOT, 'src/cli/run-outcome.ts'), 'utf8');
  assert.match(src, /stuckWasBlocked/, 'A revert-red: stuckWasBlocked must exist');
  assert.match(src, /Blocked by:/, 'A revert-red: Blocked by: wording must exist');
  assert.match(src, /被拦：/, 'A revert-red: 被拦： wording must exist');
  const completion = fs.readFileSync(path.join(ROOT, 'src/cli/run-completion.ts'), 'utf8');
  assert.match(completion, /lastBlockedStep/, 'A revert-red: lastBlockedStep must exist');
  assert.match(completion, /isSafetyOrApprovalBlockResult/, 'A revert-red: detector must exist');
}

// ── D. Exit / O111 / Stop-hook blocked head unchanged ─────────────────────
{
  // Stop hook still uses status blocked head 「被拦：」/`Blocked:` (O98)
  const oStop = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'done',
    blocked: true,
    blockedReason: 'Stop hook wants more work',
  });
  assert.equal(oStop.status, 'blocked');
  assert.equal(oStop.exitCode, 9);
  assert.match(formatOutcomeLine(oStop, 'zh'), /^被拦：/);
  assert.match(formatOutcomeLine(oStop, 'en'), /^Blocked: /);
  // stuck half for Stop remains 卡在 (head already says 被拦)
  assert.match(formatOutcomeLine(oStop, 'zh'), /卡在：停止前钩子$/);

  // O111 omit empty stuck
  const bare = { status: 'incomplete', reason: '', reasonZh: '', exitCode: 9 };
  assert.equal(formatOutcomeLine(bare, 'zh'), '未完成');
  assert.equal(formatOutcomeLine(bare, 'en'), 'Incomplete');
  banUnknown(formatOutcomeLine(bare, 'zh'), 'D omit');
}

// A real CLI approval decision flows through the agent as a denied tool_end.
for (const lang of ['en', 'zh']) {
  test(`${lang}: user rejects write_file and the run reports the refusal`, async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o113-denied-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    setSessionUiLanguage(lang);
    t.after(clearUiLanguage);

    const approval = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: workspace,
        interactionMode: () => 'manual',
      }
    );
    let prompts = 0;
    const restoreAsker = approval.setAsker(async () => {
      prompts++;
      return 'n';
    });
    t.after(restoreAsker);

    const agent = new MossAgent({
      llmProvider: createMockTranscriptProvider('denied', 'denied', [
        { toolCalls: [{ name: 'write_file', input: { path: 'note.txt', content: 'hello' } }] },
        { text: 'The file was not written.' },
      ]),
      sessionStore: new InMemorySessionStore(),
      model: 'denied',
      workspaceDir: workspace,
      baseSystemPrompt: 'Test.',
      domainPrompt: false,
      includeAgentBehaviorPrompt: false,
      enableSteering: false,
      maxAgentTurns: 4,
      hooks: { onBeforeToolExec: approval },
    });
    agent.tools.register(writeFileTool);
    const tracker = createRunCompletionTracker();
    const events = [];
    for await (const event of agent.streamChat('o113-denied', 'Create note.txt.')) {
      events.push(event);
      noteRunCompletionEvent(tracker, event);
    }

    assert.equal(prompts, 1);
    assert.equal(fs.existsSync(path.join(workspace, 'note.txt')), false);
    const ended = events.find(
      (event) => event.type === 'tool_end' && event.toolName === 'write_file'
    );
    assert.ok(ended, 'the actual agent must emit a write_file tool_end');
    assert.equal(ended.outcome, 'denied');
    assert.equal(ended.isError, true);
    assert.equal(
      ended.result,
      lang === 'zh'
        ? '已拦截：User denied write_file.'
        : 'Tool execution denied: User denied write_file.'
    );

    const outcome = resolveRunOutcome({
      tracker,
      finalText: 'The file was not written.',
      request: 'What happened?',
    });
    assert.equal(outcome.status, 'incomplete');
    assert.equal(outcome.exitCode, 9);
    assert.match(
      formatOutcomeLine(outcome, 'en'),
      /Blocked by: denied by user `write_file: note\.txt`/
    );
    assert.match(formatOutcomeLine(outcome, 'zh'), /被拦：用户拒绝 `write_file: note\.txt`/);
  });
}

for (const surface of ['repl', 'tui']) {
  for (const hookDenied of [true, false]) {
    test(`${surface}: ${hookDenied ? 'permission hook' : 'user'} denial keeps its source`, async (t) => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o113-hook-denial-'));
      t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
      setSessionUiLanguage(surface === 'tui' ? 'zh' : 'en');
      t.after(clearUiLanguage);
      const hookSecret = 'moss-hook-secret-123456789';
      const previousSecret = process.env.MOSS_HOOK_TEST_SECRET;
      process.env.MOSS_HOOK_TEST_SECRET = hookSecret;
      t.after(() => {
        if (previousSecret === undefined) delete process.env.MOSS_HOOK_TEST_SECRET;
        else process.env.MOSS_HOOK_TEST_SECRET = previousSecret;
      });
      fs.writeFileSync(
        path.join(workspace, 'permission-hook.mjs'),
        `process.stdout.write(JSON.stringify({ decision: '${hookDenied ? 'deny' : 'allow'}', reason: 'fixture policy: protected path ${hookSecret}' }));\n`
      );
      const hooks = createConfiguredHookCallbacks(
        { PermissionRequest: [{ command: 'node permission-hook.mjs' }] },
        { workspaceDir: workspace }
      );
      setPermissionRequestRunner((request) =>
        hooks.runPermissionRequest({ toolName: request.tool.name, input: request.input })
      );
      t.after(() => setPermissionRequestRunner(undefined));
      const approval = createCliToolApprovalHook(
        'workspace-write',
        {},
        {
          workspaceDir: workspace,
          interactionMode: () => 'manual',
        }
      );
      let prompts = 0;
      const answer = async () => {
        prompts++;
        return 'n';
      };
      t.after(approval.setAsker(wrapApprovalAsker(answer)));
      if (surface === 'tui') t.after(setCliApprovalViewAsker(wrapApprovalViewAsker(answer)));

      const target = surface === 'tui' && hookDenied ? '.env' : 'note.txt';
      const agent = new MossAgent({
        llmProvider: createMockTranscriptProvider('hook-denied', 'hook-denied', [
          { toolCalls: [{ name: 'write_file', input: { path: target, content: 'hello' } }] },
          { text: 'The file was not written.' },
        ]),
        sessionStore: new InMemorySessionStore(),
        model: 'hook-denied',
        workspaceDir: workspace,
        baseSystemPrompt: 'Test.',
        domainPrompt: false,
        includeAgentBehaviorPrompt: false,
        enableSteering: false,
        maxAgentTurns: 4,
        hooks: {
          onBeforeToolExec: (request) => runWithApprovalDecision(request, () => approval(request)),
        },
      });
      agent.tools.register(writeFileTool);
      const tracker = createRunCompletionTracker();
      let ended;
      for await (const event of agent.streamChat('o113-hook-denial', 'Create note.txt.')) {
        noteRunCompletionEvent(tracker, event);
        if (event.type === 'tool_end' && event.toolName === 'write_file') ended = event;
      }
      assert.equal(prompts, hookDenied ? 0 : 1);
      assert.equal(fs.existsSync(path.join(workspace, target)), false);
      assert.equal(ended?.outcome, 'denied');
      assert.equal(tracker.safetyBlocks?.[0]?.kind, hookDenied ? 'hook' : 'denied');
      const outcome = resolveRunOutcome({ tracker, finalText: 'Not executed.' });
      assert.equal(outcome.status, 'incomplete');
      assert.match(
        formatOutcomeLine(outcome, 'en'),
        hookDenied ? /hook blocked/ : /denied by user/
      );
      if (hookDenied) {
        assert.match(ended.result, /PermissionRequest|权限请求时/i);
        assert.match(ended.result, /fixture policy/);
        assert.doesNotMatch(ended.result, /moss-hook-secret/, 'hook details must be redacted');
      }
    });
  }
}

for (const [surface, rtl] of [
  ['repl', 'מדיניות'],
  ['tui', 'سياسة'],
]) {
  test(`${surface}: truncated secret after RTL hook text stays redacted end to end`, async (t) => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o113-rtl-hook-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    setSessionUiLanguage('en');
    t.after(clearUiLanguage);
    const secret = 'moss-rtl-secret-982345678';
    const previous = process.env.MOSS_RTL_SYNTHETIC_SECRET;
    process.env.MOSS_RTL_SYNTHETIC_SECRET = secret;
    t.after(() => {
      if (previous === undefined) delete process.env.MOSS_RTL_SYNTHETIC_SECRET;
      else process.env.MOSS_RTL_SYNTHETIC_SECRET = previous;
    });
    const fragment = secret.slice(0, 14);
    const intro = `fixture policy ${rtl} `;
    const hookReason = intro + 'x'.repeat(500 - intro.length - fragment.length) + secret;
    const response = JSON.stringify({ decision: 'deny', reason: hookReason });
    fs.writeFileSync(
      path.join(workspace, 'permission-hook.mjs'),
      `process.stdout.write(${JSON.stringify(response)});\n`
    );
    const hooks = createConfiguredHookCallbacks(
      { PermissionRequest: [{ command: 'node permission-hook.mjs' }] },
      { workspaceDir: workspace }
    );
    setPermissionRequestRunner((request) =>
      hooks.runPermissionRequest({ toolName: request.tool.name, input: request.input })
    );
    t.after(() => setPermissionRequestRunner(undefined));
    const stderr = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = function (chunk, ...args) {
      if (typeof chunk === 'string' && chunk.startsWith('[hooks] ')) {
        stderr.push(chunk);
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    };
    t.after(() => {
      process.stderr.write = originalWrite;
    });

    const approval = createCliToolApprovalHook(
      'workspace-write',
      {},
      {
        workspaceDir: workspace,
        interactionMode: () => 'manual',
      }
    );
    let prompts = 0;
    const answer = async () => {
      prompts++;
      return 'n';
    };
    t.after(approval.setAsker(wrapApprovalAsker(answer)));
    if (surface === 'tui') t.after(setCliApprovalViewAsker(wrapApprovalViewAsker(answer)));

    const provider = createMockTranscriptProvider('rtl-hook', 'rtl-hook', [
      { toolCalls: [{ name: 'write_file', input: { path: 'note.txt', content: 'hello' } }] },
      { text: 'The file was not written.' },
    ]);
    const modelInputs = [];
    const complete = provider.complete;
    provider.complete = async function (options) {
      modelInputs.push(JSON.stringify(options.messages));
      return complete.call(this, options);
    };
    const agent = new MossAgent({
      llmProvider: provider,
      sessionStore: new InMemorySessionStore(),
      model: 'rtl-hook',
      workspaceDir: workspace,
      baseSystemPrompt: 'Test.',
      domainPrompt: false,
      includeAgentBehaviorPrompt: false,
      enableSteering: false,
      maxAgentTurns: 4,
      hooks: {
        onBeforeToolExec: (request) => runWithApprovalDecision(request, () => approval(request)),
      },
    });
    agent.tools.register(writeFileTool);
    const tracker = createRunCompletionTracker();
    let ended;
    for await (const event of agent.streamChat('o113-rtl-hook', 'Create note.txt.')) {
      noteRunCompletionEvent(tracker, event);
      if (event.type === 'tool_end' && event.toolName === 'write_file') ended = event;
    }
    assert.equal(prompts, 0);
    assert.equal(fs.existsSync(path.join(workspace, 'note.txt')), false);
    assert.equal(ended?.outcome, 'denied');
    assert.equal(tracker.safetyBlocks?.[0]?.kind, 'hook');
    const outcome = resolveRunOutcome({ tracker, finalText: 'Not executed.' });
    assert.equal(outcome.status, 'incomplete');
    assert.equal(outcome.exitCode, 9);
    assert.ok(stderr.length > 0, 'the hook refusal was written to stderr');
    assert.ok(modelInputs.some((input) => input.includes('PermissionRequest')));
    for (const text of [
      ended.result,
      ...stderr,
      ...modelInputs,
      JSON.stringify(outcome),
      formatOutcomeLine(outcome, 'en'),
    ]) {
      assert.equal(text.includes(fragment), false, 'no truncated synthetic secret in output');
    }
  });
}

test('permission hook denial without a standard reason remains a hook block', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-o113-hook-reason-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  t.after(() => setPermissionRequestRunner(undefined));
  setSessionUiLanguage('en');
  t.after(clearUiLanguage);
  const approval = createCliToolApprovalHook(
    'workspace-write',
    {},
    {
      workspaceDir: workspace,
      interactionMode: () => 'manual',
    }
  );
  let prompts = 0;
  t.after(
    approval.setAsker(
      wrapApprovalAsker(async () => {
        prompts++;
        return 'y';
      })
    )
  );
  const request = {
    tool: writeFileTool,
    input: { path: 'note.txt', content: 'hello' },
    sessionKey: 'hook-reason',
  };
  const secret = 'moss-truncated-secret-123456789';
  const overlap = 'moss-overlap-middle-moss-overlap';
  const previous = process.env.MOSS_TRUNCATED_TEST_SECRET;
  const previousOverlap = process.env.MOSS_OVERLAP_TEST_SECRET;
  process.env.MOSS_TRUNCATED_TEST_SECRET = secret;
  process.env.MOSS_OVERLAP_TEST_SECRET = overlap;
  t.after(() => {
    if (previous === undefined) delete process.env.MOSS_TRUNCATED_TEST_SECRET;
    else process.env.MOSS_TRUNCATED_TEST_SECRET = previous;
    if (previousOverlap === undefined) delete process.env.MOSS_OVERLAP_TEST_SECRET;
    else process.env.MOSS_OVERLAP_TEST_SECRET = previousOverlap;
  });
  for (const reason of [
    '',
    '[hooks] PermissionRequest failed: protected path',
    'policy denied',
    `policy ${secret.slice(0, 14)}`,
    `policy ${overlap}`,
  ]) {
    setPermissionRequestRunner(async () => ({ denied: true, reason }));
    const decision = await runWithApprovalDecision(request, () => approval(request));
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /^Blocked by PermissionRequest hook/);
    assert.doesNotMatch(decision.reason, /moss-truncated|moss-overlap/);
  }
  assert.equal(prompts, 0);
});

test('denied tool summaries redact secrets before truncation and remove terminal controls', (t) => {
  const secret = 'moss-denial-secret-123456789';
  const previous = process.env.MOSS_DENIAL_TEST_SECRET;
  process.env.MOSS_DENIAL_TEST_SECRET = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.MOSS_DENIAL_TEST_SECRET;
    else process.env.MOSS_DENIAL_TEST_SECRET = previous;
  });

  for (const [toolName, input] of [
    ['write_file', { path: `notes/${secret}\u001b[2J.txt` }],
    ['write_file', { path: `${'x'.repeat(105)}${secret}.txt` }],
    ['exec', { command: `deploy --token=${secret} \u001b]0;bad\u0007` }],
  ]) {
    const tracker = createRunCompletionTracker();
    noteRunCompletionEvent(tracker, { type: 'tool_start', toolName, toolCallId: 'secret', input });
    noteRunCompletionEvent(tracker, {
      type: 'tool_end',
      toolName,
      toolCallId: 'secret',
      result: `Tool execution denied: User denied ${toolName}.`,
      isError: true,
      outcome: 'denied',
    });
    const outcome = resolveRunOutcome({ tracker, finalText: 'Not executed.' });
    assert.equal(outcome.status, 'incomplete');
    for (const text of [
      JSON.stringify(outcome),
      formatOutcomeLine(outcome, 'en'),
      formatOutcomeLine(outcome, 'zh'),
    ]) {
      assert.doesNotMatch(text, /moss-denial-secret/, 'no full or truncated secret');
      assert.equal(text.includes('\u001b'), false, 'no terminal escape');
      assert.equal(text.includes('\u0007'), false, 'no terminal bell');
    }
  }
});

test('other blocked and denied outcomes keep their existing classifications', () => {
  const cases = [
    ['Tool execution denied by user.', 'denied', 'denied'],
    ['已拦截：用户拒绝了 write_file。', 'denied', 'denied'],
    ['Tool execution denied: PreToolUse hook rejected the call.', 'denied', 'hook'],
    ['Blocked by PermissionRequest hook: protected path denied.', 'denied', 'hook'],
    ['Tool execution denied: requires approval but cannot ask.', 'denied', 'approval'],
    ['Blocked: the user denied writing the protected path .env.', 'denied', 'protected'],
    ['Blocked dangerous command: rm -rf /', 'denied', 'dangerous'],
    ['Operation blocked by workspace policy. The tool did not inspect.', 'blocked', 'policy'],
    ['Blocked: shell write escapes the workspace sandbox', 'blocked', 'sandbox'],
    ['Stopped retrying: failed to start 2 times', 'blocked', 'loop-guard'],
    ['Tool budget reached', 'blocked', undefined],
    ['Unknown tool: write_file', 'blocked', undefined],
    ['Tool execution denied: access denied by policy.', 'denied', undefined],
    ['Tool execution denied: User denied write_file.', 'blocked', undefined],
    ['User denied write_file.', 'ok', undefined],
  ];
  for (const [result, toolOutcome, kind] of cases) {
    const tracker = createRunCompletionTracker();
    noteRunCompletionEvent(tracker, {
      type: 'tool_start',
      toolName: 'write_file',
      toolCallId: 'case',
      input: { path: 'note.txt' },
    });
    noteRunCompletionEvent(tracker, {
      type: 'tool_end',
      toolName: 'write_file',
      toolCallId: 'case',
      result,
      isError: toolOutcome !== 'ok',
      outcome: toolOutcome,
    });
    assert.equal(
      tracker.loopGuardStops?.length ? 'loop-guard' : tracker.safetyBlocks?.[0]?.kind,
      kind,
      `${toolOutcome}: ${result}`
    );
  }

  const outcome = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'The user denied write_file.',
  });
  assert.equal(outcome.status, 'completed', 'model prose alone is not a tool refusal event');
});
