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

// Item 1: empty reason → omit, never 未知原因 / unknown reason
{
  const bare = { status: 'incomplete', reason: '', reasonZh: '', exitCode: 9 };
  assert.equal(formatOutcomeLine(bare, 'zh'), '未完成');
  assert.equal(formatOutcomeLine(bare, 'en'), 'Incomplete');
  banUnknown(formatOutcomeLine(bare, 'zh'), 'empty reason zh');
  banUnknown(formatOutcomeLine(bare, 'en'), 'empty reason en');
  const withStuck = { ...bare, stuckAt: 'turn limit', stuckAtZh: '回合上限' };
  assert.equal(formatOutcomeLine(withStuck, 'zh'), '未完成；卡在：回合上限');
  assert.equal(formatOutcomeLine(withStuck, 'en'), 'Incomplete; stuck at: turn limit');
  for (const status of ['completed', 'unverified', 'verify_failed', 'blocked']) {
    banUnknown(formatOutcomeLine({ ...bare, status }, 'zh'), `${status} zh`);
    banUnknown(formatOutcomeLine({ ...bare, status }, 'en'), `${status} en`);
  }
}

// Item 2: budget class + last tool step combined (stdout/stderr agree)
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
    runError: 'Run budget exceeded (tokens). Partial output above is the completed work.',
  });
  const stderrO = resolveRunOutcome({
    tracker: mk(),
    finalText: 'x',
    runError: '运行预算用尽，任务未完成',
  });
  assert.match(stdoutO.stuckAt ?? '', /^run budget \(read_file.*src\/a\.ts\)$/);
  assert.match(stdoutO.stuckAtZh ?? '', /^运行预算（read_file.*src\/a\.ts）$/);
  assert.equal(stderrO.stuckAt, stdoutO.stuckAt);
  assert.equal(stderrO.stuckAtZh, stdoutO.stuckAtZh);
}

// QA item 1: formatOutcomeLine with missing / unmapped reason → no 未知/unknown,
// no empty 「卡在：」 / `stuck at:` fragment, every status, EN and ZH.
{
  const noEmptyStuck = (line, label) => {
    assert.doesNotMatch(line, /卡在：\s*(；|$)/, `${label}: empty 卡在 — ${line}`);
    assert.doesNotMatch(line, /stuck at:\s*(;|$)/, `${label}: empty stuck at — ${line}`);
  };
  const cases = [
    { reason: undefined, reasonZh: undefined },
    { reason: '', reasonZh: '' },
    { reason: '   ', reasonZh: '   ' },
    { reason: 'gateway said ¯\\_(ツ)_/¯', reasonZh: '网关返回了无法识别的结果' },
  ];
  for (const status of ['completed', 'unverified', 'verify_failed', 'blocked', 'incomplete']) {
    for (const c of cases) {
      for (const stuck of [
        {},
        { stuckAt: '', stuckAtZh: '' },
        { stuckAt: 'exec: x', stuckAtZh: 'exec: x' },
      ]) {
        const o = { status, exitCode: 9, ...c, ...stuck };
        for (const lang of ['zh', 'en']) {
          const line = formatOutcomeLine(o, lang);
          const label = `${status}/${JSON.stringify(c.reason)}/${lang}`;
          banUnknown(line, label);
          noEmptyStuck(line, label);
          assert.ok(line.length > 0, `${label} non-empty`);
        }
      }
    }
  }
}

console.log('[PASS] o111-stuck-no-unknown');
