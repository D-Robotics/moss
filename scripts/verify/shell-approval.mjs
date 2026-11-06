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
const { protectedPathView } = await load('dist/cli/protected-path-prompt.js');

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

// 4. B192: the dialog body shows the full command; the 80-char subject clip is
//    no longer the only place a long chain appears, and the redundant
//    "(try to save in user config)" suffix is gone.
{
  const long = 'ls -l note.md && diff note.md copy.md && echo finished-with-a-long-tail';
  const dialog = describeApprovalDialog(
    { toolName: 'exec', sideEffect: 'local_write' },
    { command: long }
  );
  const detail = dialog.detail.join('\n');
  assert.match(
    detail,
    /^\$ ls -l note\.md && diff note\.md copy\.md && echo finished-with-a-long-tail$/m
  );
  assert.doesNotMatch(dialog.trustOptionLabel ?? '', /try to save in user config/);
  const approvalView = (await load('dist/cli/approval-view.js')).buildCliApprovalView(dialog);
  assert.match(approvalView.footer, /press 1\/2\/3/);
  assert.match(approvalView.footer, /Esc to deny/);
  assert.equal(approvalView.options.map((option) => option.key).join(''), '123');
  const multiline = describeApprovalDialog(
    { toolName: 'exec', sideEffect: 'local_write' },
    { command: 'cat <<EOF > n.txt\nhi\nEOF' }
  );
  assert.match(multiline.detail.join('\n'), /\$ cat <<EOF > n\.txt/);
  assert.match(multiline.detail.join('\n'), /\$ EOF/);

  const hit = {
    kind: 'exec-capable',
    operation: 'shell',
    category: 'unresolved',
    raw: 'non-literal command name',
    resolved: '/tmp/secret',
    reason: 'x',
  };
  const view = protectedPathView('exec', [hit], false, {
    command: 'echo x && curl http://example.test/secret',
  });
  assert.doesNotMatch(view.title, /non-literal command name/);
  assert.match(view.subject ?? '', /echo x && curl/);
  assert.match(view.preview.join('\n'), /echo x && curl http:\/\/example\.test\/secret/);
}
ok('approval dialog shows the full command (subject clip is not the only view)');

console.log(`[shell-approval] ${checks}/${checks} checks passed`);
