import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubAgentRunner } from '../dist/core/subagent/subagent-runner.js';
import { mergeLeasePatch } from '../dist/core/subagent/worktree-isolation.js';
import { createSpawnProfileRegistryFromDefaults } from '../dist/core/subagent/spawn-profile.js';
import {
  createSubagentTool,
  fanOutSubagentsTool,
  subagentStatusTool,
  subagentStopTool,
} from '../dist/tools/create-subagent.js';
import { truncateToolOutput } from '../dist/context/tool-output-truncate.js';
import { createInMemoryMossAsyncTaskRegistry } from '../dist/contracts/async-task.js';
import { executeOneToolCall } from '../dist/core/tools/execute-tool-call.js';
import { execBackgroundTool, execWaitTool } from '../dist/tools/background-exec.js';
import {
  clearBackgroundRegistryForTests,
  listBackgroundProcessSnapshots,
  waitForBackgroundProcesses,
} from '../dist/core/tools/background-process-registry.js';

const modelDef = {
  id: 'test',
  name: 'test',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-child-save-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'core.eol', 'lf');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'before\n');
  git(repo, 'add', 'tracked.txt');
  git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'base'
  );
  return { root, repo };
}

const writeTool = {
  name: 'write_file',
  description: 'Write test changes in the child workspace',
  inputSchema: { type: 'object', properties: {} },
  metadata: { sideEffectClass: 'local_write' },
  async execute(_input, ctx) {
    fs.writeFileSync(path.join(ctx.workspaceDir, 'tracked.txt'), 'changed\n');
    fs.writeFileSync(path.join(ctx.workspaceDir, 'new.txt'), 'new work\n');
    return 'wrote tracked.txt and new.txt';
  },
};

function streamForWrite() {
  let calls = 0;
  return () => {
    const first = ++calls === 1;
    return {
      async *[Symbol.asyncIterator]() {
        if (first) {
          yield {
            type: 'toolcall_end',
            toolCall: { id: 'write', name: 'write_file', arguments: {} },
          };
        }
      },
      async result() {
        return first
          ? { stopReason: 'toolUse', usage: { input: 1, output: 1 } }
          : {
              stopReason: 'end',
              usage: { input: 1, output: 1 },
              content: [{ type: 'text', text: 'Finished writing.' }],
            };
      },
      push() {},
      end() {},
    };
  };
}

function childRunner(repo, options = {}) {
  return createSubAgentRunner({
    parentTools: [writeTool],
    streamFn: streamForWrite(),
    modelDef,
    systemPrompt: 'test',
    maxOutputTokens: 512,
    contextTokens: 32_000,
    spawnRegistry: createSpawnProfileRegistryFromDefaults(),
    workspaceDir: repo,
    ...options,
  });
}

function runConfig(runId = 'child') {
  return {
    runId,
    parentRunId: 'parent',
    scope: 'full',
    task: 'Write the requested files.',
    writePaths: ['tracked.txt', 'new.txt'],
    worktree: true,
    maxTurns: 3,
    timeoutMs: 30_000,
  };
}

for (const [key, value] of [
  ['diff.noprefix', 'true'],
  ['color.diff', 'always'],
  ['diff.context', '0'],
]) {
  test(`user ${key} does not make a handed-off patch unmergeable`, async (t) => {
    const { repo } = fixture(t);
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\ntwo\nthree\nbefore\nfive\nsix\nseven\n');
    git(repo, 'add', 'tracked.txt');
    git(
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'context'
    );
    git(repo, 'config', key, value);
    const runner = childRunner(repo, {
      parentTools: [
        {
          ...writeTool,
          async execute(_input, ctx) {
            fs.writeFileSync(
              path.join(ctx.workspaceDir, 'tracked.txt'),
              'one\ntwo\nthree\nchanged\nfive\nsix\nseven\n'
            );
            fs.writeFileSync(path.join(ctx.workspaceDir, 'new.txt'), 'new work\n');
            return 'wrote files';
          },
        },
      ],
    });
    const result = await runner(runConfig(), new AbortController().signal);
    assert.equal(result.success, true, result.summary);
    const merged = await mergeLeasePatch({
      parentWorkspace: repo,
      leaseId: result.workspaceLeaseId,
      patchId: result.patchId,
    });
    assert.equal(merged.status, 'merged');
    assert.equal(
      fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'),
      'one\ntwo\nthree\nchanged\nfive\nsix\nseven\n'
    );
    assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'new work\n');
  });
}

for (const stopKind of ['stop', 'timeout']) {
  test(`background ${stopKind} exposes the retained child workspace through task tools`, async (t) => {
    const { repo } = fixture(t);
    const registry = createInMemoryMossAsyncTaskRegistry();
    let written;
    const filesWritten = new Promise((resolve) => {
      written = resolve;
    });
    let childSettled;
    const runner = childRunner(repo, {
      parentTools: [
        {
          ...writeTool,
          async execute(input, ctx) {
            await writeTool.execute(input, ctx);
            written();
            await new Promise((resolve) => {
              if (ctx.abortSignal.aborted) resolve();
              else ctx.abortSignal.addEventListener('abort', resolve, { once: true });
            });
            return 'stopped';
          },
        },
      ],
    });
    const ctx = {
      workspaceDir: repo,
      runId: 'parent',
      sessionKey: 'parent',
      abortSignal: new AbortController().signal,
      asyncTaskRegistry: registry,
      spawnSubagent: (params) => {
        childSettled = runner({ ...runConfig(), ...params }, params.abortSignal);
        return childSettled;
      },
    };
    const started = await createSubagentTool.execute(
      {
        task: 'Write files',
        scope: 'full',
        writePaths: ['tracked.txt', 'new.txt'],
        worktree: true,
        background: true,
        timeoutMs: stopKind === 'timeout' ? 2000 : 30_000,
      },
      ctx
    );
    const taskId = started.match(/\[Sub-agent task (.+?)\] STARTED/)?.[1];
    assert.ok(taskId, started);
    await filesWritten;
    if (stopKind === 'stop') {
      const stopped = await subagentStopTool.execute({ taskId }, ctx);
      assert.match(stopped, /STOPPED/);
    } else {
      assert.equal((await registry.wait(taskId)).status, 'timed_out');
    }
    await childSettled;
    const worktree = path.join(repo, '.moss', 'worktrees', 'child');
    const output = await subagentStatusTool.execute({ taskId, wait: true }, ctx);
    assert.ok(output.includes(worktree), output);
    assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
    assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
  });
}

test('an already-cancelled child does not execute tools after creating its worktree', async (t) => {
  const { repo } = fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('cancelled before startup'));
  let writes = 0;
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(input, ctx) {
          writes++;
          return writeTool.execute(input, ctx);
        },
      },
    ],
  });
  const result = await runner(runConfig(), controller.signal);
  assert.equal(result.success, false, result.summary);
  assert.equal(writes, 0);
  assert.ok(result.summary.includes(path.join(repo, '.moss', 'worktrees', 'child')));
});

test('synchronous tool timeout aborts the child and reports its recoverable workspace', async (t) => {
  const { repo } = fixture(t);
  let childSettled;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(input, ctx) {
          await writeTool.execute(input, ctx);
          await Promise.race([
            blocked,
            new Promise((resolve) => {
              if (ctx.abortSignal.aborted) resolve();
              else ctx.abortSignal.addEventListener('abort', resolve, { once: true });
            }),
          ]);
          return 'stopped';
        },
      },
    ],
  });
  const ctx = {
    workspaceDir: repo,
    sessionKey: 'parent',
    spawnSubagent: (params) => {
      childSettled = runner(
        { ...runConfig(), ...params },
        params.abortSignal ?? new AbortController().signal
      );
      return childSettled;
    },
  };
  try {
    const outcome = await executeOneToolCall(
      {
        id: 'call',
        name: 'create_subagent',
        input: {
          task: 'Write files',
          scope: 'full',
          writePaths: ['tracked.txt', 'new.txt'],
          worktree: true,
        },
      },
      {
        toolsForRun: [createSubagentTool],
        toolCtx: ctx,
        sessionKey: 'parent',
        abortSignal: new AbortController().signal,
        toolTimeoutMs: 1200,
        enableHeartbeat: false,
        heartbeatIntervalMs: 60_000,
        skipHeartbeatToolNames: new Set(),
        push() {},
      }
    );
    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.isError, true);
    assert.equal(outcome.aborted?.by, 'timeout');
    const worktree = path.join(repo, '.moss', 'worktrees', 'child');
    assert.ok(outcome.text.includes(worktree), outcome.text);
    const childResult = await childSettled;
    assert.equal(childResult.success, false, childResult.summary);
    assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
    assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
  } finally {
    release();
    if (childSettled) await childSettled;
  }
});

test('fan-out keeps each child handoff visible when long summaries are truncated', async (t) => {
  const { repo } = fixture(t);
  let n = 0;
  const output = await fanOutSubagentsTool.execute(
    {
      tasks: [1, 2, 3].map((id) => ({
        label: `task-${id}`,
        task: 'Write files',
        scope: 'full',
        writePaths: ['tracked.txt'],
        worktree: true,
      })),
    },
    {
      workspaceDir: repo,
      sessionKey: 'parent',
      spawnSubagent: async () => {
        const id = ++n;
        const workspacePath = path.join(repo, '.moss', 'worktrees', `child-${id}`);
        return {
          runId: `child-${id}`,
          sessionKey: `subagent:child-${id}`,
          success: id !== 2,
          workspaceLeaseId: `child-${id}`,
          workspacePath,
          ...(id !== 2 ? { patchId: `patch-${id}` } : {}),
          summary: `${'long child summary '.repeat(5000)}\n[worktree preserved: ${workspacePath}]`,
        };
      },
    }
  );
  const visible = truncateToolOutput('fan_out_subagents', output);
  for (const id of [1, 2, 3]) {
    assert.ok(
      visible.includes(JSON.stringify(path.join(repo, '.moss', 'worktrees', `child-${id}`))),
      visible.slice(0, 400)
    );
  }
  assert.ok(visible.includes('patch-1'));
  assert.ok(visible.includes('patch-3'));
});

for (const dirty of [false, true]) {
  test(`${dirty ? 'dirty' : 'clean'} initialized submodule ${dirty ? 'is retained' : 'does not block parent handoff'}`, async (t) => {
    const { root, repo } = fixture(t);
    const source = path.join(root, 'submodule-source');
    fs.mkdirSync(source);
    git(source, 'init', '-q');
    fs.writeFileSync(path.join(source, 'sub.txt'), 'clean\n');
    fs.writeFileSync(path.join(source, '.gitattributes'), '*.txt text eol=lf\n');
    git(source, 'add', 'sub.txt', '.gitattributes');
    git(
      source,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'submodule'
    );
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'nested');
    git(
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'add-submodule'
    );
    const runner = childRunner(repo, {
      parentTools: [
        {
          ...writeTool,
          async execute(input, ctx) {
            git(
              ctx.workspaceDir,
              '-c',
              'protocol.file.allow=always',
              'submodule',
              'update',
              '--init',
              '-q'
            );
            if (dirty)
              fs.writeFileSync(path.join(ctx.workspaceDir, 'nested', 'sub.txt'), 'dirty work\n');
            return writeTool.execute(input, ctx);
          },
        },
      ],
    });
    const result = await runner(runConfig(), new AbortController().signal);
    const worktree = path.join(repo, '.moss', 'worktrees', 'child');
    assert.equal(result.success, !dirty, result.summary);
    assert.ok(result.summary.includes(worktree));
    assert.equal(
      fs.readFileSync(path.join(worktree, 'nested', 'sub.txt'), 'utf8'),
      dirty ? 'dirty work\n' : 'clean\n'
    );
    if (!dirty) {
      const merged = await mergeLeasePatch({
        parentWorkspace: repo,
        leaseId: result.workspaceLeaseId,
        patchId: result.patchId,
      });
      assert.equal(merged.status, 'merged');
      assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), 'changed\n');
    }
  });
}

test('Git-normalized line-ending edits remain recoverable even if the patch is empty', async (t) => {
  const { repo } = fixture(t);
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt text\n');
  git(repo, 'add', '.gitattributes');
  git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'attributes'
  );
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(_input, ctx) {
          fs.writeFileSync(path.join(ctx.workspaceDir, 'tracked.txt'), 'before\r\n');
          return 'changed line endings';
        },
      },
    ],
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, true, result.summary);
  assert.match(result.summary, /patch reflects Git's view/i);
  assert.ok(result.summary.includes(worktree));
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'before\r\n');
});

test('index lock prevents a partial patch and retains tracked and new files', async (t) => {
  const { repo } = fixture(t);
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(input, ctx) {
          await writeTool.execute(input, ctx);
          fs.writeFileSync(
            git(ctx.workspaceDir, 'rev-parse', '--git-path', 'index.lock'),
            'locked'
          );
          return 'created both files';
        },
      },
    ],
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.ok(result.summary.includes(worktree));
  assert.equal(result.patchId, undefined);
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
});

test('diff larger than the capture limit is not handed off as a complete patch', async (t) => {
  const { repo } = fixture(t);
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(_input, ctx) {
          fs.writeFileSync(
            path.join(ctx.workspaceDir, 'new.txt'),
            `${'x'.repeat(11 * 1024 * 1024)}\n`
          );
          return 'wrote large file';
        },
      },
    ],
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.match(result.summary, /truncat|too large|exceeds/i);
  assert.ok(result.summary.includes(worktree));
  assert.equal(result.patchId, undefined);
  assert.equal(fs.statSync(path.join(worktree, 'new.txt')).size, 11 * 1024 * 1024 + 1);
});

test('cancelled child reports the retained workspace after writing files', async (t) => {
  const { repo } = fixture(t);
  const controller = new AbortController();
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(input, ctx) {
          await writeTool.execute(input, ctx);
          controller.abort(new Error('cancelled by parent'));
          return 'wrote files before cancellation';
        },
      },
    ],
  });
  const result = await runner(runConfig(), controller.signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.ok(result.summary.includes(worktree), result.summary);
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
});

function backgroundStream(settleMs, wait) {
  let calls = 0;
  return () => {
    const turn = ++calls;
    const toolCall =
      turn === 1
        ? {
            id: 'background',
            name: 'exec_background',
            arguments: { command: 'node worker.cjs', settle_ms: settleMs },
          }
        : turn === 2 && wait
          ? { id: 'wait', name: 'exec_wait', arguments: { ids: ['bg_1'], timeout_ms: 5000 } }
          : undefined;
    return {
      async *[Symbol.asyncIterator]() {
        if (toolCall) yield { type: 'toolcall_end', toolCall };
      },
      async result() {
        return toolCall
          ? { stopReason: 'toolUse', usage: { input: 1, output: 1 } }
          : {
              stopReason: 'end',
              usage: { input: 1, output: 1 },
              content: [{ type: 'text', text: 'done' }],
            };
      },
      push() {},
      end() {},
    };
  };
}

test('completed background work reports protected changes to the parent and retains the child worktree', async (t) => {
  const { root, repo } = fixture(t);
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  const credentials = path.join(root, 'credentials');
  fs.writeFileSync(credentials, 'before');
  fs.writeFileSync(
    path.join(repo, 'worker.cjs'),
    `const fs = require('node:fs'); fs.writeFileSync('tracked.txt', 'changed\\n'); fs.writeFileSync(${JSON.stringify(credentials)}, 'changed');\n`
  );
  git(repo, 'add', 'worker.cjs');
  git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'worker'
  );
  const runner = childRunner(repo, {
    parentTools: [execBackgroundTool, execWaitTool],
    streamFn: backgroundStream(2000, false),
    protectedConfigPaths: [credentials],
  });
  const reports = [];
  const output = await createSubagentTool.execute(
    { task: 'Run worker', scope: 'full', writePaths: ['tracked.txt'], worktree: true },
    {
      workspaceDir: repo,
      sessionKey: 'parent',
      reportProtectedPathChanges: (changes) => reports.push(...changes),
      spawnSubagent: async (params) => ({
        ...(await runner({ ...runConfig(), ...params }, new AbortController().signal)),
        sessionKey: 'subagent:child',
      }),
    }
  );
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.match(output, /FAILED/);
  assert.ok(reports.some((change) => change.path === credentials.replaceAll('\\', '/')));
  assert.ok(output.includes(worktree));
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
});

test('background change found after exec_wait also propagates to the child result', async (t) => {
  const { root, repo } = fixture(t);
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  const credentials = path.join(root, 'credentials');
  fs.writeFileSync(credentials, 'before');
  fs.writeFileSync(
    path.join(repo, 'worker.cjs'),
    `const fs = require('node:fs'); setTimeout(() => { fs.writeFileSync('tracked.txt', 'changed\\n'); fs.writeFileSync(${JSON.stringify(credentials)}, 'changed'); }, 250);\n`
  );
  git(repo, 'add', 'worker.cjs');
  git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'worker'
  );
  const runner = childRunner(repo, {
    parentTools: [execBackgroundTool, execWaitTool],
    streamFn: backgroundStream(25, true),
    protectedConfigPaths: [credentials],
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.ok(
    result.protectedPathChanges?.some((change) => change.path === credentials.replaceAll('\\', '/'))
  );
  assert.ok(result.summary.includes(worktree));
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
});

test('running child background process prevents cleanup until its changes can be recovered', async (t) => {
  const { root, repo } = fixture(t);
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  const credentials = path.join(root, 'credentials');
  const releaseFile = path.join(root, 'release');
  fs.writeFileSync(credentials, 'before');
  fs.writeFileSync(
    path.join(repo, 'worker.cjs'),
    `const fs = require('node:fs'); fs.writeFileSync('tracked.txt', 'changed\\n'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(releaseFile)})) { fs.writeFileSync(${JSON.stringify(credentials)}, 'changed'); clearInterval(timer); } }, 20);\n`
  );
  git(repo, 'add', 'worker.cjs');
  git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'worker'
  );
  const runner = childRunner(repo, {
    parentTools: [execBackgroundTool, execWaitTool],
    streamFn: backgroundStream(150, false),
    protectedConfigPaths: [credentials],
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  const snapshots = listBackgroundProcessSnapshots();
  assert.equal(result.success, false, result.summary);
  assert.match(result.summary, /still running/i);
  assert.ok(result.summary.includes(worktree));
  assert.equal(snapshots[0].status, 'running');
  const deadline = Date.now() + 5000;
  while (
    fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8') !== 'changed\n' &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
  fs.writeFileSync(releaseFile, 'continue');
  const waited = await waitForBackgroundProcesses([snapshots[0].id], 'wait_all', 5000);
  assert.equal(waited.completed, true);
  assert.ok(
    waited.snapshots[0].protectedPathChanges?.some(
      (change) => change.path === credentials.replaceAll('\\', '/')
    )
  );
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
});

test('ignored child files do not disappear behind an incomplete successful patch', async (t) => {
  const { repo } = fixture(t);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
  git(repo, 'add', '.gitignore');
  git(
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'ignore'
  );
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(input, ctx) {
          await writeTool.execute(input, ctx);
          fs.writeFileSync(path.join(ctx.workspaceDir, 'ignored.log'), 'untracked ignored work\n');
          return 'wrote files';
        },
      },
    ],
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.match(result.summary, /ignored/i);
  assert.ok(result.summary.includes(worktree));
  assert.equal(
    fs.readFileSync(path.join(worktree, 'ignored.log'), 'utf8'),
    'untracked ignored work\n'
  );
});

test('non-UTF-8 text diffs are retained instead of being corrupted as strings', async (t) => {
  const { repo } = fixture(t);
  const bytes = Buffer.from([0x66, 0x80, 0x0a]);
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(_input, ctx) {
          fs.writeFileSync(path.join(ctx.workspaceDir, 'new.txt'), bytes);
          return 'wrote byte sequence';
        },
      },
    ],
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.match(result.summary, /encoding|utf-8/i);
  assert.ok(result.summary.includes(worktree));
  assert.deepEqual(fs.readFileSync(path.join(worktree, 'new.txt')), bytes);
});

test('an embedded repository with uncommitted work is not deleted with its worktree', async (t) => {
  const { repo } = fixture(t);
  const runner = childRunner(repo, {
    parentTools: [
      {
        ...writeTool,
        async execute(_input, ctx) {
          const nested = path.join(ctx.workspaceDir, 'nested');
          fs.mkdirSync(nested);
          git(nested, 'init', '-q');
          fs.writeFileSync(path.join(nested, 'file.txt'), 'original\n');
          git(nested, 'add', 'file.txt');
          git(
            nested,
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '-qm',
            'nested'
          );
          fs.writeFileSync(path.join(nested, 'file.txt'), 'uncommitted nested work\n');
          return 'wrote nested repo';
        },
      },
    ],
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.ok(result.summary.includes(worktree));
  assert.equal(
    fs.readFileSync(path.join(worktree, 'nested', 'file.txt'), 'utf8'),
    'uncommitted nested work\n'
  );
});

test('an existing lease patch is not overwritten when a run id is reused', async (t) => {
  const { repo } = fixture(t);
  const patchDir = path.join(repo, '.moss', 'patches');
  fs.mkdirSync(patchDir, { recursive: true });
  fs.writeFileSync(path.join(patchDir, 'child.patch'), 'previous work');
  const result = await childRunner(repo)(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.ok(result.summary.includes(worktree));
  assert.equal(fs.readFileSync(path.join(patchDir, 'child.patch'), 'utf8'), 'previous work');
  assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
});

test('provider failure cannot be converted into success by a later synthesis answer', async (t) => {
  const { repo } = fixture(t);
  const normalStream = streamForWrite();
  let calls = 0;
  const runner = childRunner(repo, {
    streamFn: (...args) => {
      calls++;
      if (calls === 2) throw new Error('authentication failed: invalid API key');
      return normalStream(...args);
    },
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.ok(result.summary.includes(worktree));
  assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
});

test('successful child hands off both files and preserves its worktree', async (t) => {
  const { repo } = fixture(t);
  const result = await childRunner(repo)(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, true, result.summary);
  assert.equal(fs.existsSync(worktree), true);
  assert.ok(result.summary.includes(worktree));
  assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), 'before\n');
  assert.ok(result.patchId);
  const merged = await mergeLeasePatch({
    parentWorkspace: repo,
    leaseId: result.workspaceLeaseId,
    patchId: result.patchId,
  });
  assert.equal(merged.status, 'merged');
  assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'new work\n');
});

test('provider failure after edits retains both files and reports their location', async (t) => {
  const { repo } = fixture(t);
  const normalStream = streamForWrite();
  let calls = 0;
  const runner = childRunner(repo, {
    streamFn: (...args) => {
      if (++calls === 1) return normalStream(...args);
      throw new Error('authentication failed: invalid API key');
    },
  });
  const result = await runner(runConfig(), new AbortController().signal);
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.ok(result.summary.includes(worktree));
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
});

test('another session’s running background command does not prevent this child handoff', async (t) => {
  const { repo } = fixture(t);
  clearBackgroundRegistryForTests();
  t.after(() => clearBackgroundRegistryForTests());
  fs.writeFileSync(path.join(repo, 'foreign.cjs'), 'setTimeout(() => {}, 1200);\n');
  const output = await execBackgroundTool.execute(
    { command: 'node foreign.cjs', settle_ms: 50 },
    { workspaceDir: repo, sessionKey: 'another-session' }
  );
  assert.match(output, /Still running/i);
  const foreign = listBackgroundProcessSnapshots()[0];
  assert.equal(foreign.status, 'running');
  const result = await childRunner(repo)(runConfig(), new AbortController().signal);
  assert.equal(result.success, true, result.summary);
  assert.equal(fs.existsSync(path.join(repo, '.moss', 'worktrees', 'child')), true);
  const waited = await waitForBackgroundProcesses([foreign.id], 'wait_all', 5000);
  assert.equal(waited.completed, true);
});

test('cancellation at handoff does not report success or remove the child workspace', async (t) => {
  const { repo } = fixture(t);
  const controller = new AbortController();
  const result = await childRunner(repo)(
    {
      ...runConfig(),
      onProgress(progress) {
        if (progress.status === 'completed')
          controller.abort(new Error('cancelled during handoff'));
      },
    },
    controller.signal
  );
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.equal(result.success, false, result.summary);
  assert.ok(result.summary.includes(worktree));
  assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
});

test('synchronous child reports failure and preserves both edits when patch directory is blocked', async (t) => {
  const { repo } = fixture(t);
  fs.mkdirSync(path.join(repo, '.moss'));
  fs.writeFileSync(path.join(repo, '.moss', 'patches'), 'occupied');
  const runner = childRunner(repo);
  const output = await createSubagentTool.execute(
    { task: 'Write files', scope: 'full', writePaths: ['tracked.txt', 'new.txt'], worktree: true },
    {
      workspaceDir: repo,
      sessionKey: 'parent',
      spawnSubagent: (params) =>
        runner({ ...runConfig(), ...params }, new AbortController().signal),
    }
  );
  const worktree = path.join(repo, '.moss', 'worktrees', 'child');
  assert.match(output, /FAILED/);
  assert.ok(output.includes(worktree), 'failure reports the recovery location');
  assert.equal(fs.readFileSync(path.join(worktree, 'tracked.txt'), 'utf8'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(worktree, 'new.txt'), 'utf8'), 'new work\n');
  assert.equal(fs.readFileSync(path.join(repo, 'tracked.txt'), 'utf8'), 'before\n');
  assert.equal(fs.readFileSync(path.join(repo, '.moss', 'patches'), 'utf8'), 'occupied');
});
