#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubAgentRunner } from '../dist/core/subagent/subagent-runner.js';

const modelDef = {
  id: 'test-model',
  name: 'test-model',
  api: 'openai-completions',
  provider: 'test',
  baseUrl: '',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32_000,
  maxTokens: 1024,
};

function completedStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'text_end', content: 'Implemented and verified.' };
      yield {
        type: 'done',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Implemented and verified.' }],
          stopReason: 'end_turn',
        },
      };
    },
    async result() {
      return {
        role: 'assistant',
        content: [{ type: 'text', text: 'Implemented and verified.' }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 },
      };
    },
    push() {},
    end() {},
  };
}

function runnerOptions(workspaceDir, workspaceLeaseAdapter) {
  return {
    parentTools: [],
    streamFn: completedStream,
    modelDef,
    systemPrompt: 'test',
    maxOutputTokens: 512,
    contextTokens: 32_000,
    workspaceDir,
    ...(workspaceLeaseAdapter ? { workspaceLeaseAdapter } : {}),
  };
}

test('full subagents fail closed without a lease adapter or declared write paths', async () => {
  const signal = new AbortController().signal;
  const noAdapter = await createSubAgentRunner(runnerOptions(process.cwd()))(
    {
      runId: 'parent/sub-no-adapter',
      parentRunId: 'parent',
      scope: 'full',
      task: 'implement',
      writePaths: ['src'],
    },
    signal
  );
  assert.equal(noAdapter.success, false);
  assert.match(noAdapter.error, /workspace lease adapter/i);

  const adapter = {
    create() {
      throw new Error('must not create');
    },
  };
  const noPaths = await createSubAgentRunner(runnerOptions(process.cwd(), adapter))(
    {
      runId: 'parent/sub-no-paths',
      parentRunId: 'parent',
      scope: 'full',
      task: 'implement',
    },
    signal
  );
  assert.equal(noPaths.success, false);
  assert.match(noPaths.error, /declared write path/i);
});

test('full subagents execute in a retained lease and return a durable patch reference', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-subagent-lease-'));
  const parent = path.join(temp, 'parent');
  const child = path.join(temp, 'lease', 'workspace');
  fs.mkdirSync(path.join(parent, 'src'), { recursive: true });
  fs.writeFileSync(path.join(parent, 'src', 'input.txt'), 'parent snapshot\n');
  fs.mkdirSync(path.join(child, 'src'), { recursive: true });
  fs.copyFileSync(path.join(parent, 'src', 'input.txt'), path.join(child, 'src', 'input.txt'));
  const calls = [];
  const adapter = {
    async create(input) {
      calls.push(['create', input]);
      return {
        ...input,
        kind: 'copy-snapshot',
        status: 'active',
        workspacePath: child,
        baseRef: 'base',
        baselineHashes: {},
        createdAt: 1,
        updatedAt: 1,
      };
    },
    load() {},
    list() {
      return [];
    },
    async createPatch(lease) {
      calls.push(['patch', lease.workspacePath]);
      const artifactRef = path.join(temp, 'lease', 'patch.diff');
      fs.writeFileSync(artifactRef, 'diff --git a/src/input.txt b/src/input.txt\n');
      return {
        id: 'patch-1',
        leaseId: lease.id,
        patch: fs.readFileSync(artifactRef, 'utf8'),
        artifactRef,
        digest: 'sha256:test',
        changedPaths: ['src/input.txt'],
        createdAt: 2,
      };
    },
    async merge() {
      throw new Error('parent orchestrator owns merge');
    },
    async release() {
      throw new Error('unmerged implementation lease must be retained');
    },
  };

  try {
    const result = await createSubAgentRunner(runnerOptions(parent, adapter))(
      {
        runId: 'parent/sub-implementation',
        parentRunId: 'parent',
        scope: 'full',
        task: 'implement within src',
        writePaths: ['src'],
        maxTurns: 1,
      },
      new AbortController().signal
    );
    assert.equal(result.success, true);
    assert.equal(result.workspaceLeaseId, calls[0][1].id);
    assert.deepEqual(calls[0][1].writePaths, ['src']);
    assert.equal(result.patchRef, path.join(temp, 'lease', 'patch.diff'));
    assert.equal(result.patchDigest, 'sha256:test');
    assert.deepEqual(result.changedPaths, ['src/input.txt']);
    assert.equal(calls[1][1], child);
    assert.equal(fs.existsSync(child), true, 'unmerged lease must survive the child run');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
