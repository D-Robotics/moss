#!/usr/bin/env node
/**
 * O110: EN/ZH synonymous claims must yield the same outcome, last-line kind,
 * reason and exit code. EN outcomes are pinned (unchanged); ZH aligns to EN.
 * Spec: /workspace/specs/O110.md (A–D).
 */
import assert from 'node:assert/strict';
import {
  createRunCompletionTracker,
  findUnverifiedCheckClaims,
  noteRunCompletionEvent,
} from '../dist/cli/run-completion.js';
import { formatOutcomeLine, resolveRunOutcome } from '../dist/cli/run-outcome.js';

function wrote(t) {
  noteRunCompletionEvent(t, {
    type: 'tool_start',
    toolName: 'write_file',
    toolCallId: 'w',
    input: { path: 'src/a.ts', content: 'x' },
  });
  noteRunCompletionEvent(t, {
    type: 'tool_end',
    toolName: 'write_file',
    toolCallId: 'w',
    result: 'ok',
    isError: false,
  });
}
function run(lang, { request, finalText, write = false }) {
  const t = createRunCompletionTracker();
  if (write) wrote(t);
  const o = resolveRunOutcome({ tracker: t, finalText, request });
  return { o, t, line: formatOutcomeLine(o, lang) };
}
const kind = (line) => line.split(/[:：]/)[0];
const KIND = { Incomplete: '未完成', Unverified: '未验证', Completed: '完成' };
function pair(name, en, zh, expect) {
  const e = run('en', en);
  const z = run('zh', zh);
  // Pin current EN behavior.
  assert.equal(e.o.status, expect.status, `${name} EN status pinned`);
  assert.equal(e.o.exitCode, expect.exit, `${name} EN exit pinned`);
  assert.equal(kind(e.line), expect.kindEn, `${name} EN last-line kind pinned`);
  // ZH matches EN.
  assert.equal(z.o.status, e.o.status, `${name} ZH status == EN`);
  assert.equal(z.o.exitCode, e.o.exitCode, `${name} ZH exit == EN`);
  assert.equal(kind(z.line), KIND[kind(e.line)], `${name} ZH last-line kind == EN`);
  assert.equal(
    /没有改动任何文件/.test(z.line),
    /no files were modified/.test(e.line),
    `${name} same no-files reason`
  );
  assert.equal(
    /没有跑检查/.test(z.line),
    /no check was run/.test(e.line),
    `${name} same no-check reason`
  );
  assert.deepEqual(
    findUnverifiedCheckClaims(zh.finalText, z.t),
    findUnverifiedCheckClaims(en.finalText, e.t),
    `${name} same unverified claim set`
  );
  return { e, z };
}

// A. 0 writes + claimed fixed → Incomplete,「没有改动任何文件」, exit 9
{
  const { e, z } = pair(
    'A',
    {
      request: 'Fix the bug in src/a.ts',
      finalText: 'Fixed it. npm test passed and all checks are green.',
    },
    {
      request: '把 src/a.ts 的 bug 修好',
      finalText: '已修好。npm test 已通过，所有检查都是绿的。',
    },
    { status: 'incomplete', exit: 9, kindEn: 'Incomplete' }
  );
  assert.match(e.line, /no files were modified/);
  assert.match(z.line, /没有改动任何文件/);
}
// B. wrote files, no checks run, claimed green → Unverified, exit 9
{
  const { z } = pair(
    'B',
    { request: 'Fix the bug in src/a.ts', finalText: 'All checks green.', write: true },
    { request: '把 src/a.ts 的 bug 修好', finalText: '检查全部通过。', write: true },
    { status: 'unverified', exit: 9, kindEn: 'Unverified' }
  );
  assert.match(z.line, /^未验证：声称检查已通过，但没有跑检查：npm run check$/);
  pair(
    'B2',
    { request: 'Fix the bug', finalText: 'npm test passed.', write: true },
    { request: '修好这个 bug', finalText: 'npm test 已通过。', write: true },
    { status: 'unverified', exit: 9, kindEn: 'Unverified' }
  );
  pair(
    'B3',
    { request: 'Fix the bug', finalText: 'All checks are green.', write: true },
    { request: '修复这个 bug', finalText: '检查全绿。', write: true },
    { status: 'unverified', exit: 9, kindEn: 'Unverified' }
  );
}
// C. pure Q&A, no claims → Completed, exit 0, no warning line
{
  const { e, z } = pair(
    'C',
    { request: 'What does src/a.ts export?', finalText: 'It exports a constant `a`.' },
    { request: 'src/a.ts 导出了什么？', finalText: '它导出常量 `a`。' },
    { status: 'completed', exit: 0, kindEn: 'Completed' }
  );
  assert.doesNotMatch(e.line, /Unverified|Incomplete/);
  assert.doesNotMatch(z.line, /未验证|未完成/);
}
// Negations still don't count as claims (both languages).
{
  const t = createRunCompletionTracker();
  assert.deepEqual(findUnverifiedCheckClaims('检查都未通过。', t), []);
  assert.deepEqual(findUnverifiedCheckClaims('npm test 没有通过。', t), []);
}

// C2–C7 (O110 acceptance C / QA): question / hypothetical / explanatory
// frames must stay Completed exit 0 (EN/ZH paired). Soft ZH verbs and
// 通过/全绿 in 才算/表示/等…后 must not false-positive.
{
  pair(
    'C2',
    {
      request: 'Tell me if this bug can be fixed',
      finalText: 'Maybe, if the root cause is clear.',
    },
    {
      request: '说说这个 bug 能不能修好',
      finalText: '可以修好，需要改 src/a.ts。',
    },
    { status: 'completed', exit: 0, kindEn: 'Completed' }
  );
  pair(
    'C3',
    {
      request: 'What happens after this function is fixed?',
      finalText: 'It would return an array.',
    },
    {
      request: '这个函数改好之后会怎样',
      finalText: '会返回数组。',
    },
    { status: 'completed', exit: 0, kindEn: 'Completed' }
  );
  pair(
    'C4',
    {
      request: 'Can you look at whether this error can be fixed a bit?',
      finalText: 'It is a network issue; no code change needed.',
    },
    {
      request: '帮我看看能不能修一下这个报错',
      finalText: '是网络问题，不需要改代码。',
    },
    { status: 'completed', exit: 0, kindEn: 'Completed' }
  );
  pair(
    'C5',
    {
      request: 'How do I know whether the bug is fixed?',
      finalText: 'Usually run npm test; tests must be green before it counts as fixed.',
    },
    {
      request: '怎么判断 bug 修好了没有？',
      finalText: '一般要跑 npm test，测试全绿才算修好。',
    },
    { status: 'completed', exit: 0, kindEn: 'Completed' }
  );
  pair(
    'C6',
    {
      request: 'What does CI all green mean?',
      finalText: 'CI all green means all checks passed.',
    },
    {
      request: '解释一下 CI 全绿是什么意思',
      finalText: 'CI 全绿表示检查都通过。',
    },
    { status: 'completed', exit: 0, kindEn: 'Completed' }
  );
  // Wrote files; conditional "wait until green then merge" is not a claim.
  pair(
    'C7',
    {
      request: 'Fix the bug',
      finalText: 'Done for now; wait until checks are green then merge.',
      write: true,
    },
    {
      request: '修复 bug',
      finalText: '改好了，等检查全绿后再合。',
      write: true,
    },
    { status: 'completed', exit: 0, kindEn: 'Completed' }
  );
}

console.log('o110-zh-en-claim-parity: ok');
