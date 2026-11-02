import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  takeProtectedPathSnapshot,
  takeProtectedPathSnapshotAfter,
  diffProtectedPathSnapshots,
  restoreProtectedPathChanges,
  formatProtectedPathModifiedNotice,
} from '../dist/safety/protected-path-snapshot.js';
import { execTool } from '../dist/tools/builtin.js';
import { execBackgroundTool, execLogsTool } from '../dist/tools/background-exec.js';
import { getBackgroundProcessSnapshot } from '../dist/core/tools/background-process-registry.js';
import { createSubAgentRunner } from '../dist/core/subagent/subagent-runner.js';
import { createSpawnProfileRegistryFromDefaults } from '../dist/core/subagent/spawn-profile.js';
import { createRunCompletionTracker, noteRunCompletionEvent } from '../dist/cli/run-completion.js';
import { resolveRunOutcome } from '../dist/cli/run-outcome.js';
import { cleanupWorktree } from '../dist/core/subagent/worktree-isolation.js';
import {
  createSubagentTool,
  fanOutSubagentsTool,
  subagentStatusTool,
} from '../dist/tools/create-subagent.js';
import { runAgentLoop } from '../dist/core/loop/agent-loop.js';
import { createMossAgentLoopEventAdapter } from '../dist/core/agent/moss-agent-loop-adapter.js';
import { createInMemoryMossAsyncTaskRegistry } from '../dist/contracts/async-task.js';
import { mergeSubagentPatchTool } from '../dist/tools/merge-subagent-patch.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-config-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  return { root, workspace };
}

const quote = (value) =>
  process.platform === 'win32'
    ? `"${String(value).replaceAll('"', '""')}"`
    : `'${String(value).replaceAll("'", "'\\''")}'`;

test('fixed config files detect creation, deletion and symlink target edits without exposing contents', (t) => {
  const { root, workspace } = fixture(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const missing = path.join(root, 'explicit.json');
  const credentials = path.join(root, 'credentials');
  const target = path.join(root, 'target');
  const link = path.join(root, 'linked-config');
  const envConfig = path.join(root, '.env');
  fs.writeFileSync(credentials, 'original-private-content');
  fs.writeFileSync(target, 'original-link-content');
  fs.writeFileSync(envConfig, 'original-custom-config');
  let symlinkAvailable = true;
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    symlinkAvailable = false;
  }
  const configPaths = [missing, credentials, envConfig, ...(symlinkAvailable ? [link] : [])];
  const before = takeProtectedPathSnapshot(workspace, { home, configPaths });
  fs.writeFileSync(missing, 'new-private-content');
  fs.unlinkSync(credentials);
  fs.writeFileSync(target, 'changed-link-content');
  fs.writeFileSync(envConfig, 'changed-custom-config');
  // Runtime files are not among the fixed configuration targets.
  fs.writeFileSync(path.join(root, 'session.jsonl'), 'ordinary session update');
  const after = takeProtectedPathSnapshotAfter(before, { home });
  const changes = diffProtectedPathSnapshots(before, after);
  assert.ok(changes.some((c) => c.path === missing && c.kind === 'added'));
  assert.ok(changes.some((c) => c.path === credentials && c.kind === 'deleted'));
  assert.ok(changes.some((c) => c.path === envConfig && c.kind === 'modified'));
  if (symlinkAvailable) assert.ok(changes.some((c) => c.path === link && c.kind === 'modified'));
  assert.equal(changes.length, symlinkAvailable ? 4 : 3);
  assert.doesNotMatch(JSON.stringify(changes), /private-content|link-content/);
  assert.ok(
    restoreProtectedPathChanges(before, changes).every((r) => r.outcome === 'skipped-no-snapshot')
  );
  assert.equal(fs.readFileSync(envConfig, 'utf8'), 'changed-custom-config');
  for (const entry of before.entries.values()) {
    if (typeof entry === 'object') {
      assert.equal(entry.raw, undefined);
      assert.equal(entry.content, undefined);
    }
  }
});

test('mixed config and workspace changes report only the workspace file as restored', (t) => {
  const { root, workspace } = fixture(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const credentials = path.join(root, 'credentials');
  const dotenv = path.join(workspace, '.env');
  fs.writeFileSync(credentials, 'original-credential');
  fs.writeFileSync(dotenv, 'original-environment');
  const before = takeProtectedPathSnapshot(workspace, { home, configPaths: [credentials] });
  fs.writeFileSync(credentials, 'modified-credential');
  fs.writeFileSync(dotenv, 'modified-environment');
  const changes = diffProtectedPathSnapshots(
    before,
    takeProtectedPathSnapshotAfter(before, { home })
  );
  const restores = restoreProtectedPathChanges(before, changes);
  assert.equal(restores.find((r) => r.path === credentials)?.outcome, 'skipped-no-snapshot');
  assert.equal(restores.find((r) => r.path === '.env')?.outcome, 'restored');
  assert.equal(fs.readFileSync(credentials, 'utf8'), 'modified-credential');
  assert.equal(fs.readFileSync(dotenv, 'utf8'), 'original-environment');
  const notice = formatProtectedPathModifiedNotice(changes, false, 'node edit.cjs', restores);
  assert.match(notice, /some restored/);
  assert.match(notice, /not restored/);
  assert.doesNotMatch(notice, /original-credential|modified-credential/);
});

test('an explicit config overlapping a watched .env symlink detects target edits without restoring through it', (t) => {
  const { root, workspace } = fixture(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const target = path.join(root, 'target.json');
  const link = path.join(workspace, '.env');
  fs.writeFileSync(target, 'before');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('file symlinks require Windows privileges');
    return;
  }
  const before = takeProtectedPathSnapshot(workspace, { home, configPaths: [link] });
  fs.writeFileSync(target, 'after');
  const changes = diffProtectedPathSnapshots(
    before,
    takeProtectedPathSnapshotAfter(before, { home })
  );
  assert.ok(changes.some((change) => change.path === '.env' && change.kind === 'modified'));
  const restores = restoreProtectedPathChanges(before, changes);
  assert.equal(restores.find((r) => r.path === '.env')?.outcome, 'skipped-no-snapshot');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(target, 'utf8'), 'after');
});

test('an overlapping regular .env keeps safe restore behavior after a symlink swap', (t) => {
  const { root, workspace } = fixture(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const target = path.join(root, 'target.json');
  const envFile = path.join(workspace, '.env');
  fs.writeFileSync(target, 'external');
  fs.writeFileSync(envFile, 'original');
  const before = takeProtectedPathSnapshot(workspace, { home, configPaths: [envFile] });
  fs.unlinkSync(envFile);
  try {
    fs.symlinkSync(target, envFile, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    t.skip('file symlinks require Windows privileges');
    return;
  }
  const changes = diffProtectedPathSnapshots(
    before,
    takeProtectedPathSnapshotAfter(before, { home })
  );
  assert.equal(
    restoreProtectedPathChanges(before, changes).find((r) => r.path === '.env')?.outcome,
    'restored'
  );
  assert.equal(fs.readFileSync(envFile, 'utf8'), 'original');
  assert.equal(fs.readFileSync(target, 'utf8'), 'external');
  assert.ok(!fs.lstatSync(envFile).isSymbolicLink());
});

test('background exec reports a configuration change when the process exits', async (t) => {
  const { root, workspace } = fixture(t);
  const config = path.join(root, 'explicit.json');
  const script = path.join(workspace, 'edit.cjs');
  fs.writeFileSync(config, 'original-secret-value');
  fs.writeFileSync(
    script,
    `require('fs').writeFileSync(${JSON.stringify(config)}, 'new-secret-value');`
  );
  const ctx = {
    workspaceDir: workspace,
    sessionKey: 'config-background',
    protectedConfigPaths: [config],
  };
  const out = await execBackgroundTool.execute(
    { command: `node ${quote(script)}`, settle_ms: 50 },
    ctx
  );
  const id = String(out).match(/bg_\d+/)?.[0];
  assert.ok(id, out);
  let result;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    result = getBackgroundProcessSnapshot(id);
    if (result && ['exited', 'killed', 'error'].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(result?.status, 'exited');
  assert.ok(result.protectedPathChanges?.some((c) => c.path === config));
  const logs = await execLogsTool.execute({ id, tail: 100 }, ctx);
  assert.match(logs, /modified|已被修改/);
  assert.doesNotMatch(logs, /original-secret-value|new-secret-value|modified and restored|已还原/);
  assert.match(logs, /not restored|未还原/);
});

test('subagent exec inherits configuration detection', async (t) => {
  const { root, workspace } = fixture(t);
  const config = path.join(root, 'credentials');
  const script = path.join(workspace, 'edit.cjs');
  fs.writeFileSync(config, 'original-secret-value');
  fs.writeFileSync(
    script,
    `require('fs').writeFileSync(${JSON.stringify(config)}, 'new-secret-value');`
  );
  let toolResult;
  const tool = {
    ...execTool,
    async execute(input, ctx) {
      toolResult = await execTool.execute(input, ctx);
      return toolResult;
    },
  };
  let calls = 0;
  const streamFn = () => {
    const first = ++calls === 1;
    return {
      async *[Symbol.asyncIterator]() {
        if (first)
          yield {
            type: 'toolcall_end',
            toolCall: { id: 'edit', name: 'exec', arguments: { command: `node ${quote(script)}` } },
          };
      },
      async result() {
        return first
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
  const modelDef = {
    id: 'test',
    name: 'test',
    api: 'openai-completions',
    provider: 'test',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000,
    maxTokens: 1024,
  };
  const runner = createSubAgentRunner({
    parentTools: [tool],
    streamFn,
    modelDef,
    systemPrompt: 'test',
    maxOutputTokens: 512,
    contextTokens: 32000,
    spawnRegistry: createSpawnProfileRegistryFromDefaults(),
    workspaceDir: workspace,
    protectedConfigPaths: [config],
  });
  const result = await runner(
    {
      runId: 'sub-config',
      parentRunId: 'parent-config',
      scope: 'full',
      task: 'run the test',
      maxTurns: 2,
      timeoutMs: 30000,
    },
    new AbortController().signal
  );
  assert.match(toolResult, /modified|已被修改/);
  assert.doesNotMatch(
    toolResult,
    /original-secret-value|new-secret-value|modified and restored|已还原/
  );
  assert.match(toolResult, /not restored|未还原/);
  assert.equal(result.success, false);
  assert.match(result.summary, /Protected paths modified by subagent/);
  assert.match(result.summary, /\[moss-o101-protected-path-modified\]/);
  const tracker = createRunCompletionTracker();
  noteRunCompletionEvent(tracker, {
    type: 'tool_end',
    toolCallId: 'sub',
    toolName: 'create_subagent',
    result: result.summary,
    isError: true,
  });
  const outcome = resolveRunOutcome({ tracker, finalText: 'done', request: 'run the test' });
  assert.equal(outcome.status, 'incomplete');
});

for (const throwAfterChange of [false, true]) {
  test(`isolated subagent preserves legitimate edits when protected changes are detected${throwAfterChange ? ' and reporting throws' : ''}`, async (t) => {
    const { root, workspace } = fixture(t);
    // git resolves worktree paths to their real path on macOS.
    const repo = fs.realpathSync(workspace);
    const config = path.join(root, 'credentials');
    fs.writeFileSync(config, 'original-secret-value');
    fs.writeFileSync(path.join(repo, 'legitimate.txt'), 'before\n');
    fs.writeFileSync(
      path.join(repo, 'edit.cjs'),
      `const fs = require('fs'); fs.writeFileSync('legitimate.txt', 'after\\n'); fs.writeFileSync(${JSON.stringify(config)}, 'changed');`
    );
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    git('init', '-q');
    git('add', '--', 'legitimate.txt', 'edit.cjs');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-q',
      '-m',
      'initial'
    );
    let calls = 0;
    const streamFn = () => {
      const first = ++calls === 1;
      return {
        async *[Symbol.asyncIterator]() {
          if (first)
            yield {
              type: 'toolcall_end',
              toolCall: { id: 'edit', name: 'exec', arguments: { command: 'node edit.cjs' } },
            };
        },
        async result() {
          return first
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
    const modelDef = {
      id: 'test',
      name: 'test',
      api: 'openai-completions',
      provider: 'test',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 1024,
    };
    const runner = createSubAgentRunner({
      parentTools: [execTool],
      streamFn,
      modelDef,
      systemPrompt: 'test',
      maxOutputTokens: 512,
      contextTokens: 32000,
      spawnRegistry: createSpawnProfileRegistryFromDefaults(),
      workspaceDir: repo,
      protectedConfigPaths: [config],
    });
    const runId = `sub-isolated-${throwAfterChange ? 'error' : 'normal'}`;
    const expectedWorktree = path.join(repo, '.moss', 'worktrees', runId);
    try {
      const result = await runner(
        {
          runId,
          parentRunId: 'parent',
          scope: 'full',
          task: 'edit both files',
          worktree: true,
          maxTurns: 2,
          timeoutMs: 30000,
          ...(throwAfterChange
            ? {
                onProgress(progress) {
                  if (
                    (progress.phase === 'tool' && progress.toolResults === 1) ||
                    progress.status === 'failed'
                  )
                    throw new Error('observer failed after change');
                },
              }
            : {}),
        },
        new AbortController().signal
      );
      assert.equal(result.success, false);
      assert.match(result.summary, /\[moss-o101-protected-path-modified\]/);
      assert.ok(result.summary.includes(expectedWorktree), result.summary);
      if (throwAfterChange) assert.match(result.summary, /observer failed after change/);
      assert.equal(
        fs.readFileSync(path.join(expectedWorktree, 'legitimate.txt'), 'utf8'),
        'after\n'
      );
      assert.equal(fs.readFileSync(path.join(repo, 'legitimate.txt'), 'utf8'), 'before\n');
    } finally {
      if (fs.existsSync(expectedWorktree))
        await cleanupWorktree({ parentWorkspace: repo, worktreePath: expectedWorktree });
    }
  });
}

for (const tool of [createSubagentTool, fanOutSubagentsTool]) {
  test(`${tool.name} propagates protected changes through the real tool event even when its preview is truncated`, async (t) => {
    const { root, workspace } = fixture(t);
    const protectedPath = path.join(root, 'credentials');
    const changes = [{ path: protectedPath, kind: 'modified' }];
    const summary = `${'long result '.repeat(100)}\n[moss-o101-protected-path-modified] paths=${protectedPath}`;
    const input =
      tool.name === 'create_subagent'
        ? { task: 'review this', scope: 'explore' }
        : {
            tasks: [
              { task: 'review first', scope: 'explore' },
              { task: 'review second', scope: 'explore' },
            ],
          };
    let requests = 0;
    const sessionKey = `test-${tool.name}`;
    const stream = runAgentLoop({
      runId: sessionKey,
      sessionKey,
      agentId: 'test',
      currentMessages: [{ role: 'user', content: 'run the task', timestamp: 1 }],
      systemPrompt: 'test',
      toolsForRun: [tool],
      toolCtx: {
        workspaceDir: workspace,
        sessionKey,
        spawnSubagent: async () => ({
          runId: 'child',
          sessionKey: 'child',
          summary,
          success: false,
          protectedPathChanges: changes,
        }),
      },
      modelDef: { api: 'openai-completions', provider: 'test', id: 'test-model' },
      streamFn: () => {
        const first = ++requests === 1;
        const toolCall = { id: 'call', name: tool.name, arguments: input };
        return {
          async *[Symbol.asyncIterator]() {
            if (first) yield { type: 'toolcall_end', toolCall };
          },
          async result() {
            return first
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
      },
      maxTurns: 2,
      contextTokens: 32000,
      appendMessage: async () => {},
      prepareCompaction: async () => ({}),
      abortSignal: new AbortController().signal,
    });
    const events = [];
    for await (const event of stream) events.push(event);
    await stream.result();
    const end = events.find(
      (event) => event.type === 'tool_execution_end' && event.toolName === tool.name
    );
    assert.ok(end, `missing end event for ${tool.name}`);
    assert.ok(
      !end.result.includes('[moss-o101-protected-path-modified]'),
      'marker is outside the preview'
    );
    assert.ok(end.protectedPathChanges?.some((change) => change.path === protectedPath));
    const tracker = createRunCompletionTracker();
    const adapter = createMossAgentLoopEventAdapter();
    for (const event of events) {
      for (const publicEvent of adapter.onMiniEvent(event))
        noteRunCompletionEvent(tracker, publicEvent);
    }
    assert.equal(
      resolveRunOutcome({ tracker, finalText: 'done', request: 'run the task' }).status,
      'incomplete'
    );
  });
}

for (const wait of [true, false]) {
  test(`background subagent ${wait ? 'wait' : 'completed status'} preserves protected changes across the actual event chain`, async (t) => {
    const { root, workspace } = fixture(t);
    const protectedPath = path.join(root, 'credentials');
    const changes = [{ path: protectedPath, kind: 'modified' }];
    const summary = `${'long result '.repeat(100)}\n[moss-o101-protected-path-modified] paths=${protectedPath}`;
    const registry = createInMemoryMossAsyncTaskRegistry();
    const ctx = {
      workspaceDir: workspace,
      sessionKey: `async-${wait}`,
      asyncTaskRegistry: registry,
      spawnSubagent: async () => ({
        runId: 'child',
        sessionKey: 'child',
        summary,
        success: false,
        protectedPathChanges: changes,
      }),
    };
    const started = await createSubagentTool.execute(
      { task: 'review this', scope: 'explore', background: true },
      ctx
    );
    const taskId = started.match(/\[Sub-agent task (.+?)\] STARTED/)?.[1];
    assert.ok(taskId, started);
    if (!wait) await registry.wait(taskId);
    let requests = 0;
    const stream = runAgentLoop({
      runId: ctx.sessionKey,
      sessionKey: ctx.sessionKey,
      agentId: 'test',
      currentMessages: [{ role: 'user', content: 'check the task', timestamp: 1 }],
      systemPrompt: 'test',
      toolsForRun: [subagentStatusTool],
      toolCtx: ctx,
      modelDef: { api: 'openai-completions', provider: 'test', id: 'test-model' },
      streamFn: () => {
        const first = ++requests === 1;
        const toolCall = { id: 'status', name: 'subagent_status', arguments: { taskId, wait } };
        return {
          async *[Symbol.asyncIterator]() {
            if (first) yield { type: 'toolcall_end', toolCall };
          },
          async result() {
            return first
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
      },
      maxTurns: 2,
      contextTokens: 32000,
      appendMessage: async () => {},
      prepareCompaction: async () => ({}),
      abortSignal: new AbortController().signal,
    });
    const events = [];
    for await (const event of stream) events.push(event);
    await stream.result();
    const end = events.find(
      (event) => event.type === 'tool_execution_end' && event.toolName === 'subagent_status'
    );
    assert.ok(end, 'missing status event');
    assert.ok(
      !end.result.includes('[moss-o101-protected-path-modified]'),
      'marker is outside the preview'
    );
    assert.ok(end.protectedPathChanges?.some((change) => change.path === protectedPath));
    const tracker = createRunCompletionTracker();
    const adapter = createMossAgentLoopEventAdapter();
    for (const event of events) {
      for (const publicEvent of adapter.onMiniEvent(event))
        noteRunCompletionEvent(tracker, publicEvent);
    }
    assert.equal(
      resolveRunOutcome({ tracker, finalText: 'done', request: 'check the task' }).status,
      'incomplete'
    );
  });
}

for (const leaf of ['config.json', 'mcp.json']) {
  test(`isolated subagent detects its own newly created .moss/${leaf}`, async (t) => {
    const { workspace } = fixture(t);
    const repo = fs.realpathSync(workspace);
    fs.writeFileSync(
      path.join(repo, 'edit.cjs'),
      `const f=require('fs'); f.mkdirSync('.moss',{recursive:true}); f.writeFileSync('.moss/${leaf}','{}');`
    );
    for (const args of [
      ['init', '-q'],
      ['add', '--', 'edit.cjs'],
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '-q',
        '-m',
        'initial',
      ],
    ]) {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    let calls = 0;
    const streamFn = () => {
      const first = ++calls === 1;
      return {
        async *[Symbol.asyncIterator]() {
          if (first)
            yield {
              type: 'toolcall_end',
              toolCall: { id: 'edit', name: 'exec', arguments: { command: 'node edit.cjs' } },
            };
        },
        async result() {
          return first
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
    const modelDef = {
      id: 'test',
      name: 'test',
      api: 'openai-completions',
      provider: 'test',
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32000,
      maxTokens: 1024,
    };
    const runner = createSubAgentRunner({
      parentTools: [execTool],
      streamFn,
      modelDef,
      systemPrompt: 'test',
      maxOutputTokens: 512,
      contextTokens: 32000,
      spawnRegistry: createSpawnProfileRegistryFromDefaults(),
      workspaceDir: repo,
      protectedConfigPaths: [
        path.join(repo, '.moss', 'config.json'),
        path.join(repo, '.moss', 'mcp.json'),
      ],
    });
    const runId = `sub-local-${leaf.replace('.', '-')}`;
    const child = path.join(repo, '.moss', 'worktrees', runId);
    try {
      const result = await runner(
        {
          runId,
          parentRunId: 'parent',
          scope: 'full',
          task: 'run test',
          worktree: true,
          maxTurns: 2,
        },
        new AbortController().signal
      );
      assert.equal(result.success, false, result.summary);
      assert.ok(result.protectedPathChanges?.some((change) => change.path.includes(leaf)));
      assert.ok(result.summary.includes(child));
      assert.equal(fs.readFileSync(path.join(child, '.moss', leaf), 'utf8'), '{}');
      assert.equal(fs.existsSync(path.join(repo, '.moss', leaf)), false);
    } finally {
      if (fs.existsSync(child))
        await cleanupWorktree({ parentWorkspace: repo, worktreePath: child });
    }
  });
}

test('create_subagent forwards explicit worktree isolation to the synchronous child', async (t) => {
  const { workspace } = fixture(t);
  let received;
  await createSubagentTool.execute(
    { task: 'edit', scope: 'full', writePaths: ['safe.txt'], worktree: true },
    {
      workspaceDir: workspace,
      sessionKey: 'parent',
      spawnSubagent: async (request) => {
        received = request;
        return { runId: 'child', sessionKey: 'child', summary: 'done', success: true };
      },
    }
  );
  assert.equal(received?.worktree, true);
});

test('subagent tool descriptions identify writePaths as an unenforced coordination hint', () => {
  const descriptions = [
    createSubagentTool.inputSchema.properties.writePaths.description,
    fanOutSubagentsTool.inputSchema.properties.tasks.items.properties.writePaths.description,
  ];
  for (const description of descriptions) assert.match(description, /coordination.*not enforced/i);
  assert.doesNotMatch(mergeSubagentPatchTool.description, /declared write paths/);
});
