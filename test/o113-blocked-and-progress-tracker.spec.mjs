#!/usr/bin/env node
/**
 * O113: safety/approval incomplete last line → 「被拦：…」/`Blocked by: …`;
 * progress stderr must pass completionTracker so budget lines carry the tool step.
 * Spec: /workspace/specs/O113.md (A–D + UX/QA). Mislabel = BLOCK.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRunCompletionTracker,
  isSafetyOrApprovalBlockResult,
  noteRunCompletionEvent,
} from '../dist/cli/run-completion.js';
import { formatOutcomeLine, resolveRunOutcome } from '../dist/cli/run-outcome.js';
import { createRunProgressTracker, formatProgressOutcomeLine } from '../dist/cli/run-progress.js';

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
  assert.equal(o.stuckAt, 'exec: rm -rf /');
  const zh = formatOutcomeLine(o, 'zh');
  const en = formatOutcomeLine(o, 'en');
  assert.match(zh, /被拦：exec: rm -rf \//);
  assert.match(en, /Blocked by: exec: rm -rf \//);
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
  assert.match(formatOutcomeLine(o, 'zh'), /被拦：exec: rm -rf \//);
  assert.match(formatOutcomeLine(o, 'en'), /Blocked by: exec: rm -rf \//);
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
  assert.match(formatOutcomeLine(oStop, 'zh'), /卡在：Stop 钩子/);

  // O111 omit empty stuck
  const bare = { status: 'incomplete', reason: '', reasonZh: '', exitCode: 9 };
  assert.equal(formatOutcomeLine(bare, 'zh'), '未完成');
  assert.equal(formatOutcomeLine(bare, 'en'), 'Incomplete');
  banUnknown(formatOutcomeLine(bare, 'zh'), 'D omit');
}

console.log('[PASS] o113-blocked-and-progress-tracker');
