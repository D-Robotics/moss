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
console.log('o110-zh-en-claim-parity: ok');
