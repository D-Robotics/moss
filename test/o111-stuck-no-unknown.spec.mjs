#!/usr/bin/env node
/**
 * O111: incomplete last line must never say 「卡在：未知」 / `stuck at: unknown`.
 * Fill a concrete stuck step when known; omit the stuck half when not.
 * Spec: /workspace/specs/O111.md (A–D + UX/QA).
 */
import assert from 'node:assert/strict';
import {
  createRunCompletionTracker,
  formatIncompleteLine,
  assessRunCompletion,
  noteRunCompletionEvent,
} from '../dist/cli/run-completion.js';
import {
  formatOutcomeLine,
  resolveRunOutcome,
  stuckClassFromUnfinished,
} from '../dist/cli/run-outcome.js';

function banUnknown(line, label) {
  assert.doesNotMatch(line, /未知|unknown|Unknown/i, `${label}: no 未知/unknown — got ${line}`);
  assert.doesNotMatch(line, /卡在：未知|stuck at: unknown/i, `${label}: no stuck-unknown`);
}

function failTool(t, name = 'exec', cmd = 'npm run check') {
  noteRunCompletionEvent(t, {
    type: 'tool_start',
    toolName: name,
    toolCallId: 'f1',
    input: { command: cmd },
  });
  noteRunCompletionEvent(t, {
    type: 'tool_end',
    toolName: name,
    toolCallId: 'f1',
    result: 'failed',
    isError: true,
  });
}

// A. Zero-write incomplete: omit stuck half; no 未知/unknown
{
  const o = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'Done.',
    request: 'Fix the timeout in src/cli/hooks.ts',
  });
  assert.equal(o.status, 'incomplete');
  assert.equal(o.exitCode, 9);
  assert.equal(o.stuckAt, undefined);
  const zh = formatOutcomeLine(o, 'zh');
  const en = formatOutcomeLine(o, 'en');
  assert.equal(zh, '未完成：没有改动任何文件');
  assert.equal(en, 'Incomplete: no files were modified');
  banUnknown(zh, 'A zh');
  banUnknown(en, 'A en');
  assert.doesNotMatch(zh, /卡在：/);
  assert.doesNotMatch(en, /stuck at:/);
}

// B1. Turn limit → concrete stuck class (EN/ZH)
{
  const o = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'still going',
    runError: 'hit the turn limit before finishing',
  });
  assert.equal(o.status, 'incomplete');
  assert.equal(o.exitCode, 9);
  assert.equal(o.stuckAt, 'turn limit');
  assert.equal(o.stuckAtZh, '回合上限');
  const zh = formatOutcomeLine(o, 'zh');
  const en = formatOutcomeLine(o, 'en');
  assert.match(zh, /^未完成：.*；卡在：回合上限$/);
  assert.match(en, /^Incomplete: .*stuck at: turn limit$/);
  banUnknown(zh, 'B1 zh');
  banUnknown(en, 'B1 en');
}

// B2. Tool budget / run budget / error_max_turns subtype
{
  for (const [runError, enStuck, zhStuck] of [
    ['tool budget reached before finishing', 'tool budget', '工具预算'],
    ['error_budget_exceeded', 'run budget', '运行预算'],
    ['error_max_turns', 'turn limit', '回合上限'],
    ['已到回合上限，任务暂停未完成', 'turn limit', '回合上限'],
  ]) {
    const o = resolveRunOutcome({
      tracker: createRunCompletionTracker(),
      finalText: 'x',
      runError,
    });
    assert.equal(o.stuckAt, enStuck, runError);
    assert.equal(o.stuckAtZh, zhStuck, runError);
    banUnknown(formatOutcomeLine(o, 'zh'), `B2 ${runError} zh`);
    banUnknown(formatOutcomeLine(o, 'en'), `B2 ${runError} en`);
  }
}

// B3. Failed tool + turn limit → prefer concrete tool step over class
{
  const t = createRunCompletionTracker();
  failTool(t);
  const o = resolveRunOutcome({
    tracker: t,
    finalText: 'trying',
    request: 'Fix src/cli/hooks.ts',
    runError: 'hit the turn limit before finishing',
  });
  assert.match(o.stuckAt ?? '', /exec/);
  const zh = formatOutcomeLine(o, 'zh');
  const en = formatOutcomeLine(o, 'en');
  banUnknown(zh, 'B3 zh');
  banUnknown(en, 'B3 en');
  assert.match(zh, /卡在：/);
  assert.match(en, /stuck at:/);
}

// Prefer lastFailedStep over class when no runError class consumed stuck first.
// Separate case: tool fail + no files, no runError → stuck = lastFailedStep
{
  const t = createRunCompletionTracker();
  failTool(t, 'exec', 'npm test');
  const o = resolveRunOutcome({
    tracker: t,
    finalText: 'not done',
    request: 'Fix src/a.ts',
  });
  assert.equal(o.status, 'incomplete');
  assert.ok(o.stuckAt, 'stuck from failed tool');
  assert.match(o.stuckAt, /exec/);
  const zh = formatOutcomeLine(o, 'zh');
  const en = formatOutcomeLine(o, 'en');
  assert.match(zh, /卡在：/);
  assert.match(en, /stuck at:/);
  banUnknown(zh, 'B3b zh');
  banUnknown(en, 'B3b en');
}

// B4. Stop hook → stuck Stop hook / Stop 钩子
{
  const o = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'done',
    blocked: true,
    blockedReason: 'Stop hook wants more work',
  });
  assert.equal(o.status, 'blocked');
  assert.equal(o.stuckAt, 'Stop hook');
  assert.equal(o.stuckAtZh, 'Stop 钩子');
  const zh = formatOutcomeLine(o, 'zh');
  const en = formatOutcomeLine(o, 'en');
  assert.match(zh, /^被拦：.*；卡在：Stop 钩子$/);
  assert.match(en, /^Blocked: .*stuck at: Stop hook$/);
  banUnknown(zh, 'B4 zh');
  banUnknown(en, 'B4 en');
}

// C. EN/ZH same structure for omit vs fill
{
  const omit = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'x',
    request: '修复 hooks.ts',
  });
  assert.equal(
    /卡在：/.test(formatOutcomeLine(omit, 'zh')),
    /stuck at:/.test(formatOutcomeLine(omit, 'en'))
  );
  const fill = resolveRunOutcome({
    tracker: createRunCompletionTracker(),
    finalText: 'x',
    runError: 'error_max_turns',
  });
  assert.equal(
    /卡在：/.test(formatOutcomeLine(fill, 'zh')),
    /stuck at:/.test(formatOutcomeLine(fill, 'en'))
  );
  assert.ok(/卡在：/.test(formatOutcomeLine(fill, 'zh')));
}

// formatIncompleteLine mirrors omit/fill
{
  const empty = createRunCompletionTracker();
  const v = assessRunCompletion({
    tracker: empty,
    finalText: 'Done.',
    request: 'Fix src/cli/hooks.ts',
    zh: true,
  });
  assert.equal(v.status, 'incomplete');
  const line = formatIncompleteLine(v, { zh: true });
  assert.equal(line, '未完成：没有改动任何文件');
  banUnknown(line, 'formatIncompleteLine zh');
  const ven = assessRunCompletion({
    tracker: createRunCompletionTracker(),
    finalText: 'Done.',
    request: 'Fix src/cli/hooks.ts',
  });
  assert.equal(formatIncompleteLine(ven), 'Incomplete: no files were modified');
}

// stuckClassFromUnfinished helper
{
  assert.deepEqual(stuckClassFromUnfinished('error_max_turns'), {
    en: 'turn limit',
    zh: '回合上限',
  });
  assert.equal(stuckClassFromUnfinished('something else'), undefined);
}

// D guard: re-introduce unknown fallback must fail — simulated expectation
{
  // Current formatter never emits unknown for missing stuck.
  const fake = {
    status: 'incomplete',
    reason: 'no files were modified',
    reasonZh: '没有改动任何文件',
    exitCode: 9,
  };
  banUnknown(formatOutcomeLine(fake, 'zh'), 'D omit zh');
  banUnknown(formatOutcomeLine(fake, 'en'), 'D omit en');
}

console.log('[PASS] o111-stuck-no-unknown');
