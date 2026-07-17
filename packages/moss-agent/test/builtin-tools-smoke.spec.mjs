import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyPatchTool,
  installSkillTool,
  listDirectoryTool,
  moveFileTool,
  searchCodeTool,
  searchFilesTool,
} from '../dist/tools/builtin.js';
import { codeDiagnosticsTool } from '../dist/tools/code-diagnostics.js';
import {
  execBackgroundTool,
  execLogsTool,
  execStopTool,
  setKillEscalationMsForTests,
} from '../dist/tools/background-exec.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tools-'));
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'zeta.txt'), 'zeta');
  await fs.writeFile(path.join(dir, 'alpha.txt'), 'alpha');
  await fs.writeFile(path.join(dir, 'src', 'sample.js'), 'export const marker = "MOSS_MARKER";\n');
  return dir;
}

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function markRead(workspaceDir, rel) {
  await globalToolStateManager.recordFileState(path.join(workspaceDir, rel));
}

test('filesystem discovery tools return stable workspace-relative paths', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  assert.equal(await listDirectoryTool.execute({}, ctx(dir)), 'alpha.txt\nsrc/\nzeta.txt');
  assert.equal(
    await searchFilesTool.execute({ pattern: '*.js' }, ctx(dir)),
    'Found 1 file(s) (newest first):\nsrc/sample.js'
  );
  assert.match(await searchCodeTool.execute({ pattern: 'MOSS_MARKER' }, ctx(dir)), /^src\/sample\.js:1:/);
});

test('move_file changes the filesystem and protects existing destinations', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  assert.match(
    await moveFileTool.execute({ source: 'alpha.txt', destination: 'nested/moved.txt' }, ctx(dir)),
    /Moved/
  );
  assert.equal(await fs.readFile(path.join(dir, 'nested', 'moved.txt'), 'utf8'), 'alpha');
  await fs.writeFile(path.join(dir, 'target.txt'), 'target');
  assert.match(
    await moveFileTool.execute({ source: 'zeta.txt', destination: 'target.txt' }, ctx(dir)),
    /destination already exists/
  );
});

test('install_skill writes a discoverable SKILL.md and refuses accidental overwrite', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = { name: 'Review Helper', description: 'Review code safely', body: '# Workflow\nReview the diff.' };

  assert.match(await installSkillTool.execute(input, ctx(dir)), /Installed skill review-helper/);
  const skill = await fs.readFile(path.join(dir, '.moss', 'skills', 'review-helper', 'SKILL.md'), 'utf8');
  assert.match(skill, /name: review-helper/);
  assert.match(await installSkillTool.execute(input, ctx(dir)), /already exists/);
});

test('code_diagnostics runs a real workspace command and reports failures', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'ok.js'), "console.log('ok');\n");
  await fs.writeFile(path.join(dir, 'fail.js'), 'process.exit(2);\n');

  assert.match(await codeDiagnosticsTool.execute({ command: 'node ok.js' }, ctx(dir)), /ok/);
  assert.match(await codeDiagnosticsTool.execute({ command: 'node fail.js' }, ctx(dir)), /failed|exit/i);
});

test('apply_patch changes real files atomically and rejects workspace escape', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const patch = [
    '*** Begin Patch',
    '*** Update File: alpha.txt',
    '@@',
    '-alpha',
    '+alpha updated',
    '*** Add File: nested/new.txt',
    '+created',
    '*** End Patch',
  ].join('\n');
  // Update of existing file requires prior read_file (Claude FileEdit parity).
  assert.match(
    await applyPatchTool.execute({ patch }, ctx(dir)),
    /must call read_file|before editing/i,
  );
  await markRead(dir, 'alpha.txt');
  assert.match(await applyPatchTool.execute({ patch }, ctx(dir)), /Patch applied/);
  assert.equal(await fs.readFile(path.join(dir, 'alpha.txt'), 'utf8'), 'alpha updated');
  assert.equal(await fs.readFile(path.join(dir, 'nested', 'new.txt'), 'utf8'), 'created');

  const escaped = [
    '*** Begin Patch',
    '*** Add File: ../escaped.txt',
    '+must not exist',
    '*** End Patch',
  ].join('\n');
  assert.match(await applyPatchTool.execute({ patch: escaped }, ctx(dir)), /failed|outside|workspace|path/i);
  await assert.rejects(fs.access(path.join(dir, '..', 'escaped.txt')));
});

test('background process tools cover start, logs, and stop lifecycle', async (t) => {
  const dir = await fixture();
  await fs.writeFile(path.join(dir, 'background.js'), "console.log('READY');\nsetInterval(() => {}, 1000);\n");
  setKillEscalationMsForTests(50);
  let id;
  t.after(async () => {
    if (id) await execStopTool.execute({ id }, ctx(dir));
    setKillEscalationMsForTests(2000);
    await fs.rm(dir, { recursive: true, force: true });
  });

  assert.match(
    await execBackgroundTool.execute({ command: 'node -e "process.exit()"' }, ctx(dir)),
    /blocked/i,
    'inline interpreter execution is rejected by the safety boundary',
  );

  const started = await execBackgroundTool.execute({
    command: 'node background.js',
    label: 'smoke',
    settle_ms: 50,
  }, ctx(dir));
  id = /\b(bg_\d+)\b/.exec(started)?.[1];
  assert.ok(id, `background start returns a process id: ${started}`);

  let running = '';
  const logDeadline = Date.now() + 2000;
  while (Date.now() < logDeadline) {
    running = await execLogsTool.execute({ id, tail: 10 }, ctx(dir));
    if (running.includes('READY')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(running, /READY/);
  assert.match(running, /running/);

  assert.match(await execStopTool.execute({ id }, ctx(dir)), /Stopping/);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(await execLogsTool.execute({ id, tail: 10 }, ctx(dir)), /killed|exited/);
});
