#!/usr/bin/env node
/**
 * O128 (+ O122): the O97 partial-read edit gate must hold on retry.
 * Process-level: real `dist/cli.js -p` against the O121 fake server, with a
 * ~48k-char file (tool-loop-guard.ts, the O106 run2 file).
 *
 * A. After a partial read, the identical resend, changed params, multi_edit,
 *    apply_patch and write_file are all refused; file untouched; exit 9
 *    「被拦：局部读后编辑 `notes.txt`」. Every refusal carries the same next step.
 * B. After a real full read_file, the first edit succeeds — also when that
 *    full read repeats an earlier identical full read (O122: the loop's
 *    replay cache used to answer it, so the full read was never registered).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIG = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'o128-big-file.ts.txt'), 'utf8');
assert.ok(BIG.length > 40000, `fixture is large (${BIG.length})`);
const OLD = 'const refused = /You only read a partial window of /.test(text);';
assert.equal(BIG.split(OLD).length, 2, 'edit target is unique');
const NEW = 'const refused = /You only read a partial window of /u.test(text);';

const CLAIM = { zh: '全部完成，已经做好了。', en: 'All done, everything is finished.' };
const partialRead = { name: 'read_file', args: { path: 'notes.txt', offset: 1, limit: 20 } };
const fullRead = { name: 'read_file', args: { path: 'notes.txt' } };
const edit = { name: 'edit_file', args: { path: 'notes.txt', old_string: OLD, new_string: NEW } };
const NEXT = 'Next step: read `notes.txt` in full first, then edit';
const NEXT_ZH = '下一步：先完整读取 `notes.txt` 再编辑';

const REFUSED_CASES = [
  { id: 'identical-resend', steps: [partialRead, edit, edit, edit] },
  {
    id: 'changed-params+multi_edit',
    steps: [
      partialRead,
      edit,
      { name: 'edit_file', args: { path: 'notes.txt', old_string: 'O97', new_string: 'O97x' } },
      {
        name: 'multi_edit',
        args: {
          path: 'notes.txt',
          edits: [{ path: 'notes.txt', old_string: OLD, new_string: NEW }],
        },
      },
    ],
  },
  {
    id: 'apply_patch+write_file',
    steps: [
      partialRead,
      edit,
      {
        name: 'apply_patch',
        args: {
          patch: `*** Begin Patch\n*** Update File: notes.txt\n@@\n-  ${OLD}\n+  ${NEW}\n*** End Patch`,
        },
      },
      { name: 'write_file', args: { path: 'notes.txt', content: 'x\n' } },
    ],
  },
];

let pass = 0;
const failures = [];
async function check(fn, name) {
  try {
    await fn();
    pass += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`not ok - ${name}: ${err?.message ?? err}`);
  }
}

for (const c of REFUSED_CASES) {
  for (const lang of ['zh', 'en']) {
    await check(async () => {
      const r = await scenario({ lang, steps: c.steps, finalText: CLAIM[lang], notesBody: BIG });
      assert.equal(r.notes, BIG, 'file untouched');
      assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}\n${r.err.slice(-600)}`);
      assert.match(
        r.last,
        lang === 'zh'
          ? /被拦：局部读后编辑 `notes\.txt`/
          : /Blocked by: edit after partial read `notes\.txt`/,
        r.last
      );
      assert.doesNotMatch(r.last, /未知|unknown/i, r.last);
      const refusals = r.toolResults.slice(1);
      assert.equal(refusals.length, c.steps.length - 1, 'every edit got a result');
      for (const [i, t] of refusals.entries()) {
        assert.match(
          t,
          /You only read a partial window of notes\.txt/,
          `refusal ${i + 1}: ${t.slice(0, 200)}`
        );
        assert.ok(
          t.includes(NEXT) && t.includes(NEXT_ZH),
          `refusal ${i + 1} has the same next step`
        );
      }
    }, `[${lang}] ${c.id}: refused every time until a full read → exit 9 被拦`);
  }
}

// QA #118 repro: a small file (under the O97 attach cap) gets its body
// attached to the refusal. That attachment used to count as a full read, so
// the identical resend was written. It must not unlock editing.
const smallEdit = {
  name: 'edit_file',
  args: { path: 'notes.txt', old_string: 'line 30\n', new_string: 'LINE 30\n' },
};
for (const lang of ['zh', 'en']) {
  await check(async () => {
    const r = await scenario({
      lang,
      steps: [
        { name: 'read_file', args: { path: 'notes.txt', offset: 1, limit: 5 } },
        smallEdit,
        smallEdit,
      ],
      finalText: CLAIM[lang],
    });
    assert.match(r.notes, /^line 30$/m, 'file untouched');
    assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}`);
    assert.match(
      r.last,
      lang === 'zh'
        ? /被拦：局部读后编辑 `notes\.txt`/
        : /Blocked by: edit after partial read `notes\.txt`/,
      r.last
    );
    const [first, second] = r.toolResults.slice(1);
    for (const t of [first, second]) {
      assert.match(
        t ?? '',
        /^Error: You only read a partial window of notes\.txt/,
        (t ?? '').slice(0, 200)
      );
      assert.ok(t.includes(NEXT) && t.includes(NEXT_ZH), 'same next step');
    }
  }, `[${lang}] small file: identical resend after the attached-body refusal is refused`);
  await check(async () => {
    const r = await scenario({
      lang,
      steps: [
        { name: 'read_file', args: { path: 'notes.txt', offset: 1, limit: 5 } },
        smallEdit,
        { name: 'read_file', args: { path: 'notes.txt' } },
        smallEdit,
      ],
      finalText: CLAIM[lang],
    });
    assert.match(r.notes, /^LINE 30$/m, `edit applied; last=${r.last}`);
    assert.equal(r.code, 0, r.last);
  }, `[${lang}] small file: refused → full read → first edit succeeds`);
}

const RECOVER_CASES = [
  // O106 run2 shape: partial → refused → full read → edit
  { id: 'partial→refused→full→edit', steps: [partialRead, edit, fullRead, edit] },
  // O122: the full re-read is identical to an earlier full read
  { id: 'O122 repeated full read', steps: [fullRead, partialRead, edit, fullRead, edit] },
];
for (const c of RECOVER_CASES) {
  for (const lang of ['zh', 'en']) {
    await check(async () => {
      const r = await scenario({ lang, steps: c.steps, finalText: CLAIM[lang], notesBody: BIG });
      assert.equal(r.notes, BIG.replace(OLD, NEW), `edit applied; last=${r.last}`);
      const lastEdit = r.toolResults.at(-1) ?? '';
      assert.match(
        lastEdit,
        /^Edited/,
        `first edit after the full read succeeds: ${lastEdit.slice(0, 200)}`
      );
      assert.equal(
        r.toolResults.filter((t) => /^Error: You only read a partial window/.test(t)).length,
        1,
        'exactly one refusal (the edit before the full read)'
      );
      assert.equal(r.code, 0, `exit 0, got ${r.code}; last=${r.last}`);
      assert.doesNotMatch(r.last, /被拦|Blocked by/, r.last);
    }, `[${lang}] ${c.id}: first edit after a real full read succeeds`);
  }
}

console.log(`# pass ${pass}  fail ${failures.length}`);
if (failures.length) process.exit(1);
