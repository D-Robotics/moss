#!/usr/bin/env node
/**
 * O128 (PM ruling): gate-type refusals (partial-read edit, truncated
 * write_file) go into the O121 block record as resolvable. Changing the same
 * file (realpath) later through the gate's prescribed tools resolves it → exit
 * 0. Unresolved at the end → 「还没改」 (not 「被拦」), exit 9. An exec write never resolves.
 * Process-level: real `dist/cli.js -p` against the O121 fake server.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIG = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'o128-big-file.ts.txt'), 'utf8');
const OLD = 'const refused = /You only read a partial window of /.test(text);';
const NEW = 'const refused = /You only read a partial window of /u.test(text);';
const CLAIM = { zh: '全部完成，已经做好了。', en: 'All done, everything is finished.' };
const exec = (command) => ({ name: 'exec', args: { command } });

const partialRead = { name: 'read_file', args: { path: 'notes.txt', offset: 1, limit: 5 } };
const fullRead = (p = 'notes.txt') => ({ name: 'read_file', args: { path: p } });
const smallEdit = (p = 'notes.txt') => ({
  name: 'edit_file',
  args: { path: p, old_string: 'line 30\n', new_string: 'LINE 30\n' },
});
const bigEdit = {
  name: 'edit_file',
  args: { path: 'notes.txt', old_string: OLD, new_string: NEW },
};
const overwrite = { name: 'write_file', args: { path: 'notes.txt', content: 'x\n' } };

const BLOCK = {
  partial: {
    zh: /^未完成：`notes\.txt` 还没改（先完整读取再编辑）/,
    en: /^Incomplete: `notes\.txt` not changed \(read in full first, then edit\)/,
  },
  truncated: {
    zh: /^未完成：`notes\.txt` 还没改（读取被截断，请改用 edit）/,
    en: /^Incomplete: `notes\.txt` not changed \(truncated when read; use edit\)/,
  },
};

const CASES = [
  // partial-read gate
  {
    id: 'partial: refuse → full read → edit',
    steps: [partialRead, smallEdit(), fullRead(), smallEdit()],
    exit: 0,
    file: (b) => /^LINE 30$/m.test(b),
  },
  {
    id: 'partial: refuse → full read via ./ → edit via ./ (realpath)',
    steps: [partialRead, smallEdit(), fullRead('./notes.txt'), smallEdit('./notes.txt')],
    exit: 0,
    file: (b) => /^LINE 30$/m.test(b),
  },
  { id: 'partial: refuse → finish', steps: [partialRead, smallEdit()], exit: 9, block: 'partial' },
  {
    id: 'partial: refuse → exec write',
    steps: [
      partialRead,
      smallEdit(),
      exec(`node -e "require('fs').writeFileSync('notes.txt','x')"`),
    ],
    exit: 9,
  },
  // truncated write_file gate
  {
    id: 'truncated: refuse → edit',
    big: true,
    steps: [fullRead(), overwrite, bigEdit],
    exit: 0,
    file: (b) => b === BIG.replace(OLD, NEW),
  },
  {
    id: 'truncated: refuse → finish',
    big: true,
    steps: [fullRead(), overwrite],
    exit: 9,
    block: 'truncated',
  },
  {
    id: 'truncated: refuse → exec write',
    big: true,
    steps: [fullRead(), overwrite, exec(`node -e "require('fs').writeFileSync('notes.txt','x')"`)],
    exit: 9,
  },
];

let pass = 0;
const failures = [];
for (const c of CASES) {
  for (const lang of ['zh', 'en']) {
    const name = `[${lang}] ${c.id} → exit ${c.exit}`;
    try {
      const r = await scenario({
        lang,
        steps: c.steps,
        finalText: CLAIM[lang],
        flags: ['--full-access'],
        ...(c.big ? { notesBody: BIG } : {}),
      });
      assert.equal(
        r.code,
        c.exit,
        `exit ${c.exit}, got ${r.code}; last=${r.last}\n${r.err.slice(-400)}`
      );
      if (c.exit === 0) {
        assert.doesNotMatch(r.last, /被拦|Blocked by|未完成|Incomplete/, r.last);
        assert.ok(c.file(r.notes), 'prescribed change landed');
      } else {
        assert.match(r.last, lang === 'zh' ? /^未完成/ : /^Incomplete/, r.last);
        assert.doesNotMatch(r.last, /未知|unknown|被拦|Blocked by/i, r.last);
        if (c.block) assert.match(r.last, BLOCK[c.block][lang], r.last);
        else if (c.id.includes('partial')) assert.match(r.last, BLOCK.partial[lang], r.last);
        else if (c.id.includes('truncated')) assert.match(r.last, BLOCK.truncated[lang], r.last);
      }
      pass += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      failures.push(name);
      console.log(`not ok - ${name}: ${err?.message ?? err}`);
    }
  }
}
console.log(`# pass ${pass}  fail ${failures.length}`);
if (failures.length) process.exit(1);
