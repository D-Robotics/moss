import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyPatchTool,
  listDirectoryTool,
  moveFileTool,
  searchCodeTool,
  searchFilesTool,
} from '../dist/tools/builtin.js';
import { codeDiagnosticsTool } from '../dist/tools/code-diagnostics.js';
import { execBackgroundTool, execLogsTool, execStopTool } from '../dist/tools/background-exec.js';
import { setKillEscalationMsForTests } from '../dist/core/tools/background-process-registry.js';
import { globalToolStateManager } from '../dist/tools/tool-helpers.js';
import { executeOneToolCall, outcomeToResult } from '../dist/core/tools/execute-tool-call.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { ErrorCode } from '../dist/errors.js';

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
  assert.match(
    await searchCodeTool.execute({ pattern: 'MOSS_MARKER' }, ctx(dir)),
    /^src\/sample\.js:1:/
  );
});

async function executeDirectory(workspaceDir, input) {
  return executeOneToolCall(
    { id: 'directory-call', name: 'list_directory', input },
    {
      toolsForRun: [listDirectoryTool],
      toolCtx: ctx(workspaceDir),
      sessionKey: 'directory-test',
      abortSignal: new AbortController().signal,
      toolTimeoutMs: 5_000,
      enableHeartbeat: false,
      heartbeatIntervalMs: 1_000,
      skipHeartbeatToolNames: new Set(),
      push() {},
    }
  );
}

function assertDirectoryFailure(outcome, failedPath, code) {
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.isError, true, 'an unreadable directory must not be reported as success');
  assert.equal(outcomeToResult(outcome).isError, true);
  assert.equal(outcome.error?.code, ErrorCode.TOOL_EXECUTION_FAILED);
  assert.ok(
    outcome.text.includes(failedPath),
    `failure should identify ${failedPath}: ${outcome.text}`
  );
  assert.match(outcome.text, new RegExp(`\\b${code}\\b`));
  assert.doesNotMatch(outcome.text, /\(empty directory\)/);
  let cause = outcome.error;
  while (cause && cause.code !== code) cause = cause.cause;
  assert.equal(cause?.code, code, 'the native filesystem error remains in the cause chain');
}

async function denyDirectoryRead(t, dir) {
  if (process.platform === 'win32') {
    t.skip('POSIX directory permission bits are not supported on Windows');
    return false;
  }
  try {
    await fs.chmod(dir, 0o000);
  } catch (err) {
    if (['EACCES', 'EPERM', 'ENOSYS', 'EOPNOTSUPP'].includes(err.code)) {
      t.skip(`filesystem does not support changing directory permissions: ${err.code}`);
      return false;
    }
    throw err;
  }
  try {
    await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') return err.code;
    await fs.chmod(dir, 0o700);
    throw err;
  }
  await fs.chmod(dir, 0o700);
  t.skip('current user/filesystem can still read a mode-000 directory');
  return false;
}

test('list_directory reports a genuinely empty directory as success', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const outcome = await executeDirectory(dir, {});
  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.isError, false);
  assert.equal(outcome.text, '(empty directory)');
});

for (const [target, code] of [
  ['missing', 'ENOENT'],
  ['file.txt', 'ENOTDIR'],
]) {
  test(`list_directory reports ${code} for an invalid root`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-invalid-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    await fs.writeFile(path.join(dir, 'file.txt'), 'not a directory');
    assertDirectoryFailure(
      await executeDirectory(dir, { path: target }),
      path.join(dir, target),
      code
    );
  });
}

test('list_directory reports an unreadable root', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-denied-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const blocked = path.join(dir, 'blocked');
  await fs.mkdir(blocked);
  const code = await denyDirectoryRead(t, blocked);
  if (!code) return;
  try {
    assertDirectoryFailure(await executeDirectory(dir, { path: 'blocked' }), blocked, code);
  } finally {
    await fs.chmod(blocked, 0o700);
  }
});

test('list_directory fails when a queued subtree disappears during traversal', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const vanished = path.join(dir, 'z-vanished');
  await fs.mkdir(vanished);
  await fs.writeFile(path.join(dir, 'a-visible.txt'), 'visible');
  const originalReaddir = fs.readdir;
  try {
    fs.readdir = async (...args) => {
      const entries = await originalReaddir(...args);
      if (args[0] === dir) await fs.rm(vanished, { recursive: true });
      return entries;
    };
    const outcome = await executeDirectory(dir, { depth: 2 });
    assertDirectoryFailure(outcome, vanished, 'ENOENT');
  } finally {
    fs.readdir = originalReaddir;
  }
});

test('list_directory fails on an unreadable subtree but respects depth and limit', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-subtree-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const blocked = path.join(dir, 'z-blocked');
  await fs.mkdir(blocked);
  await fs.writeFile(path.join(dir, 'a-visible.txt'), 'visible');
  const code = await denyDirectoryRead(t, blocked);
  if (!code) return;
  try {
    const shallow = await executeDirectory(dir, { depth: 1 });
    assert.equal(shallow.isError, false);
    assert.equal(shallow.text, 'a-visible.txt\nz-blocked/');
    const limited = await executeDirectory(dir, { depth: 2, limit: 1 });
    assert.equal(limited.isError, false);
    assert.match(limited.text, /^Listed 1 entries \(limit reached, depth=2\):\na-visible\.txt$/);
    assertDirectoryFailure(await executeDirectory(dir, { depth: 2 }), blocked, code);
  } finally {
    await fs.chmod(blocked, 0o700);
  }
});

test('list_directory preserves sorting, ignores and head_limit', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'node_modules'));
  await fs.mkdir(path.join(dir, 'src', 'dist'));
  await fs.writeFile(path.join(dir, 'node_modules', 'hidden.txt'), 'ignored');
  await fs.writeFile(path.join(dir, 'src', 'dist', 'hidden.txt'), 'ignored');
  assert.equal(
    await listDirectoryTool.execute({ depth: 2 }, ctx(dir)),
    'alpha.txt\nsrc/\nzeta.txt\n  src/sample.js'
  );
  assert.equal(
    await listDirectoryTool.execute({ depth: 2, head_limit: 2 }, ctx(dir)),
    'Listed 2 entries (limit reached, depth=2):\nalpha.txt\nsrc/'
  );
});

test('list_directory marks symlinks without traversing them', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-link-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'target'));
  await fs.writeFile(path.join(dir, 'target', 'inside.txt'), 'visible');
  try {
    await fs.symlink('target', path.join(dir, 'link'), 'dir');
  } catch (err) {
    if (['EACCES', 'EPERM', 'ENOSYS', 'EOPNOTSUPP'].includes(err.code)) {
      t.skip(`directory symlinks are unavailable: ${err.code}`);
      return;
    }
    throw err;
  }
  assert.equal(
    await listDirectoryTool.execute({ depth: 2 }, ctx(dir)),
    'link@\ntarget/\n  target/inside.txt'
  );
});

async function assertModelDirectoryFailure(dir, input, failedPath, code) {
  let calls = 0;
  let modelMessages;
  const agent = new MossAgent({
    workspaceDir: dir,
    llmProvider: {
      id: 'directory-failure-fixture',
      capabilities: { streaming: false },
      async complete(options) {
        if (calls++ === 0) {
          return {
            stopReason: 'tool_use',
            content: [{ type: 'tool_use', id: 'list-target', name: 'list_directory', input }],
          };
        }
        modelMessages = structuredClone(options.messages);
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'Observed the failure.' }],
        };
      },
    },
    model: 'fixture',
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableCompaction: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
  });
  agent.tools.register(listDirectoryTool);
  try {
    await agent.chat('directory-test', 'Inspect the target directory.');
    const result = modelMessages
      ?.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === 'tool_result' && block.tool_use_id === 'list-target');
    assert.ok(result, 'the model must receive the tool result');
    assert.equal(result.is_error, true);
    assert.match(result.content, new RegExp(`\\b${code}\\b`));
    assert.ok(result.content.includes(failedPath));
    assert.doesNotMatch(result.content, /\(empty directory\)/);
  } finally {
    await agent.close();
  }
}

test('the model receives a missing directory as an error tool result', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-model-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assertModelDirectoryFailure(dir, { path: 'missing' }, path.join(dir, 'missing'), 'ENOENT');
});

test('the model receives an unreadable subtree as an error tool result', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-list-model-partial-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const blocked = path.join(dir, 'z-blocked');
  await fs.mkdir(blocked);
  await fs.writeFile(path.join(dir, 'a-visible.txt'), 'visible');
  const code = await denyDirectoryRead(t, blocked);
  if (!code) return;
  try {
    await assertModelDirectoryFailure(dir, { depth: 2 }, blocked, code);
  } finally {
    await fs.chmod(blocked, 0o700);
  }
});

test('move_file changes the filesystem and protects existing destinations', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const moved = await moveFileTool.execute(
    { source: 'alpha.txt', destination: 'nested/moved.txt' },
    ctx(dir)
  );
  assert.match(moved, /Moved/);
  assert.match(moved, /move preview/i, 'result embeds move preview for transcript visibility');
  assert.match(moved, /- alpha\.txt/);
  assert.match(moved, /\+ nested\/moved\.txt/);
  assert.equal(await fs.readFile(path.join(dir, 'nested', 'moved.txt'), 'utf8'), 'alpha');
  await fs.writeFile(path.join(dir, 'target.txt'), 'target');
  assert.match(
    await moveFileTool.execute({ source: 'zeta.txt', destination: 'target.txt' }, ctx(dir)),
    /destination already exists/
  );
  // overwrite without prior read of destination is rejected
  assert.match(
    await moveFileTool.execute(
      { source: 'zeta.txt', destination: 'target.txt', overwrite: true },
      ctx(dir)
    ),
    /must call read_file|before editing|Destination exists/i
  );
  await markRead(dir, 'target.txt');
  assert.match(
    await moveFileTool.execute(
      { source: 'zeta.txt', destination: 'target.txt', overwrite: true },
      ctx(dir)
    ),
    /Moved/
  );
  assert.equal(await fs.readFile(path.join(dir, 'target.txt'), 'utf8'), 'zeta');
});

test('code_diagnostics runs a real workspace command and reports failures', async (t) => {
  const dir = await fixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'ok.js'), "console.log('ok');\n");
  await fs.writeFile(path.join(dir, 'fail.js'), 'process.exit(2);\n');

  assert.match(await codeDiagnosticsTool.execute({ command: 'node ok.js' }, ctx(dir)), /ok/);
  assert.match(
    await codeDiagnosticsTool.execute({ command: 'node fail.js' }, ctx(dir)),
    /failed|exit/i
  );
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
    /must call read_file|before editing/i
  );
  await markRead(dir, 'alpha.txt');
  const applied = await applyPatchTool.execute({ patch }, ctx(dir));
  assert.match(applied, /Patch applied/);
  assert.match(
    applied,
    /patch preview/i,
    'success result embeds patch preview for transcript visibility'
  );
  assert.match(applied, /\+alpha updated|Update File: alpha/);
  assert.equal(await fs.readFile(path.join(dir, 'alpha.txt'), 'utf8'), 'alpha updated');
  assert.equal(await fs.readFile(path.join(dir, 'nested', 'new.txt'), 'utf8'), 'created');

  const escaped = [
    '*** Begin Patch',
    '*** Add File: ../escaped.txt',
    '+must not exist',
    '*** End Patch',
  ].join('\n');
  assert.match(
    await applyPatchTool.execute({ patch: escaped }, ctx(dir)),
    /failed|outside|workspace|path/i
  );
  await assert.rejects(fs.access(path.join(dir, '..', 'escaped.txt')));
});

test('background process tools cover start, logs, and stop lifecycle', async (t) => {
  const dir = await fixture();
  await fs.writeFile(
    path.join(dir, 'background.js'),
    "console.log('READY');\nsetInterval(() => {}, 1000);\n"
  );
  setKillEscalationMsForTests(50);
  let id;
  t.after(async () => {
    if (id) await execStopTool.execute({ id }, ctx(dir));
    setKillEscalationMsForTests(2000);
    await fs.rm(dir, { recursive: true, force: true });
  });

  // `node -e "..."` is a legitimate coding invocation and is no longer
  // hard-blocked (moss allows `node file.mjs` — the same arbitrary code under
  // a different invocation — so blocking -e was security theater). It now
  // runs like any exec_background command: starts (and exits 0 immediately
  // here). The approval hook gates it the same way as file-based execution.
  assert.doesNotMatch(
    await execBackgroundTool.execute({ command: 'node -e "process.exit()"' }, ctx(dir)),
    /blocked/i,
    'inline interpreter -e is no longer hard-blocked (consistent with node file.mjs)'
  );

  const started = await execBackgroundTool.execute(
    {
      command: 'node background.js',
      label: 'smoke',
      settle_ms: 50,
    },
    ctx(dir)
  );
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
