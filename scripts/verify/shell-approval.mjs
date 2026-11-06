#!/usr/bin/env node
/**
 * Shell approval probe (offline, B175).
 *
 * Manual mode promises "mutations and device changes confirm one by one", yet a
 * read-only chain like `ls -l note.md && cat note.md` still opened an approval
 * dialog because the readonly tokenizer rejected operators. The fast path now
 * splits `&&`/`||`/`;`/`|` outside quotes and requires every segment to be
 * readonly; redirections, substitutions, absolute paths and background `&` stay
 * unclassified (and therefore still prompt).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { describeApprovalDialog, isReadonlyExecCommand } = await load('dist/cli/approval.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[shell-approval] ok ${name}`);
};

// 1. Read-only chains/pipelines skip the prompt.
for (const command of [
  'ls -l note.md && cat note.md',
  'git status && git diff',
  'cat note.md | head -3',
  'ls; pwd',
  'git log || pwd',
  'wc -l note.md && grep line note.md',
]) {
  assert.equal(isReadonlyExecCommand(command), true, `${command} should be readonly`);
}

// 2. Anything that can write, hide a write, or reach outside the workspace
//    still needs approval.
for (const command of [
  'echo hi > out.txt',
  'ls -l note.md && cat note.md > copy.md',
  'rm note.md',
  'ls /etc/passwd',
  'cat $(echo note.md)',
  'ls & cat note.md',
  'cat note.md; bash -c "rm note.md"',
  'cat note.md && python3 -c "print(1)"',
  'ls note.md && echo hi >> note.md',
]) {
  assert.equal(isReadonlyExecCommand(command), false, `${command} must still prompt`);
}
ok('readonly chains are trusted; writes, substitutions and absolute paths still prompt');

// 3. The approval subject keeps the first line of a multiline command (the
//    screenshot had a continuation fragment instead) and marks it multiline.
{
  const command = "cat <<'EOF' > note.md\nline one\nline two\nEOF";
  const dialog = describeApprovalDialog(
    { toolName: 'exec', sideEffect: 'local_write' },
    { command }
  );
  assert.match(dialog.subject ?? '', /^cat <<'EOF' > note\.md \(multiline\)$/);
  assert.doesNotMatch(dialog.subject ?? '', /^line two/);
  assert.equal(dialog.title, 'Bash command');
}
ok('a multiline exec keeps its first line as the approval subject');

console.log(`[shell-approval] ${checks}/${checks} checks passed`);
