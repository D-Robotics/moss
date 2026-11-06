#!/usr/bin/env node
/**
 * Shell-write sandbox regression probe (offline, B91).
 *
 * On macOS `/tmp` is a symlink to `/private/tmp`, so a workspace opened as
 * `/tmp/ws` and a shell target spelled `/private/tmp/ws/x` fail a lexical
 * containment check even though the write lands inside the workspace. The
 * sandbox now retries through realpath; a genuine escape still fails, and a
 * symlink inside the root that points outside is still refused.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { findShellWriteEscape, assertShellWritesWithinRoots } = await load(
  'dist/safety/shell-write-sandbox.js'
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[shell-write-sandbox] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-shell-write-'));
try {
  // A symlink in a *parent* component is the realistic macOS case
  // (`/tmp/ws` where `/tmp` is a link): the root path itself is not a symlink.
  const baseReal = path.join(tmp, 'real');
  const baseLink = path.join(tmp, 'link');
  const realWs = path.join(baseReal, 'ws');
  const linkWs = path.join(baseLink, 'ws');
  const outside = path.join(tmp, 'outside');
  await fs.mkdir(realWs, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(baseReal, baseLink, 'dir');
  await fs.symlink(outside, path.join(realWs, 'escape-link'), 'dir');

  const escape = (command, cwd, roots) =>
    findShellWriteEscape(command, { cwd, roots, extraRoots: [] });

  // 1. The workspace root is opened through the symlink; the write names the
  //    real path. This is the B91 bug: it used to be refused lexically.
  assert.equal(
    await escape(`echo inside > ${path.join(realWs, 'inside.txt')}`, linkWs, [linkWs]),
    null
  );
  // 2. The reverse spelling: root is the real path, the write names the link.
  assert.equal(
    await escape(`echo inside > ${path.join(linkWs, 'inside2.txt')}`, realWs, [realWs]),
    null
  );
  // 3. A relative write under the symlinked cwd is still allowed.
  assert.equal(await escape('echo inside > ./inside3.txt', linkWs, [linkWs]), null);
  // 4. A real escape is still refused.
  assert.notEqual(
    await escape(`echo nope > ${path.join(outside, 'nope.txt')}`, linkWs, [linkWs]),
    null
  );
  // 5. A symlink inside the root pointing outside is still refused after the
  //    realpath retry (the retry must not become a bypass).
  assert.notEqual(
    await escape(`echo nope > ${path.join(realWs, 'escape-link', 'nope2.txt')}`, linkWs, [linkWs]),
    null
  );
  // 6. The throwing variant matches: inside passes, outside raises the typed error.
  await assertShellWritesWithinRoots(`echo ok > ${path.join(realWs, 'inside4.txt')}`, {
    cwd: linkWs,
    roots: [linkWs],
  });
  await assert.rejects(
    () =>
      assertShellWritesWithinRoots(`echo nope > ${path.join(outside, 'nope3.txt')}`, {
        cwd: linkWs,
        roots: [linkWs],
      }),
    /escapes workspace|escapes sandbox/
  );
  ok('symlinked roots accept writes through either spelling and still refuse real escapes');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[shell-write-sandbox] ${checks}/${checks} checks passed`);
