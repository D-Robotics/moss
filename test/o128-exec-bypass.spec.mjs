#!/usr/bin/env node
/**
 * O128 QA point 4: after a partial-read edit refusal, the same file must not
 * be writable through exec — sed -i, cat >, python open().write — nor via a
 * symlink alias or `./x` / `../dir/x` spellings (lock keyed by realpath).
 * Process-level: real `dist/cli.js -p` against the O121 fake server.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { scenario } from './o121-safety-block-outcome.spec.mjs';

if (process.platform === 'win32') {
  console.log(
    '# skip: posix shell commands (sed/cat/ln); Windows covered by exec-write-lock unit tests'
  );
  process.exit(0);
}
const HAS_PY = spawnSync('python3', ['-c', 'pass']).status === 0;

const partialRead = { name: 'read_file', args: { path: 'notes.txt', offset: 1, limit: 5 } };
const edit = {
  name: 'edit_file',
  args: { path: 'notes.txt', old_string: 'line 30\n', new_string: 'LINE 30\n' },
};
const exec = (command) => ({ name: 'exec', args: { command } });
const link = exec('ln -s notes.txt alias.txt');

const CASES = [
  { id: 'sed -i', cmd: "sed -i 's/line 30/LINE 30/' notes.txt" },
  { id: 'cat > ./x', cmd: 'echo pwned | cat > ./notes.txt' },
  { id: 'cat > ../dir/x', cmd: 'echo pwned | cat > ../proj/notes.txt' },
  { id: 'redirect absolute', cmd: 'echo pwned > "$PWD/notes.txt"' },
  { id: 'tee -a', cmd: 'echo pwned | tee -a notes.txt' },
  { id: 'var-built path $D/x', cmd: 'D=.; echo pwned > $D/notes.txt' },
  { id: 'command substitution $(pwd)/x', cmd: 'echo pwned > "$(pwd)/notes.txt"' },
  { id: 'backtick `pwd`/x', cmd: 'echo pwned > `pwd`/notes.txt' },
  ...(HAS_PY
    ? [{ id: 'python open().write', cmd: `python3 -c "open('notes.txt','w').write('pwned')"` }]
    : []),
  { id: 'symlink alias sed -i', pre: [link], cmd: "sed -i 's/line 30/LINE 30/' alias.txt" },
  { id: 'symlink alias cat >', pre: [link], cmd: 'echo pwned | cat > ./alias.txt' },
];

let pass = 0;
const failures = [];
for (const c of CASES) {
  for (const lang of ['zh', 'en']) {
    const name = `[${lang}] ${c.id}: exec write after partial-read refusal is blocked`;
    try {
      const r = await scenario({
        lang,
        steps: [...(c.pre ?? []), partialRead, edit, exec(c.cmd)],
        finalText: lang === 'zh' ? '全部完成。' : 'All done.',
        flags: ['--full-access'],
      });
      assert.match(r.notes, /^line 30$/m, `file untouched; got ${r.notes.slice(0, 40)}`);
      assert.doesNotMatch(r.notes, /pwned|LINE 30/);
      const execResult = r.toolResults.at(-1) ?? '';
      assert.match(
        execResult,
        /edit tools just refused|edit-locked file/,
        execResult.slice(0, 200)
      );
      assert.equal(r.code, 9, `exit 9, got ${r.code}; last=${r.last}`);
      pass += 1;
      console.log(`ok - ${name}`);
    } catch (err) {
      failures.push(name);
      console.log(`not ok - ${name}: ${err?.message ?? err}`);
    }
  }
}
if (!HAS_PY) console.log('# note: python3 not found, python case skipped');
console.log(`# pass ${pass}  fail ${failures.length}`);
if (failures.length) process.exit(1);
