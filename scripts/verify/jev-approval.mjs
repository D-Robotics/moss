import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCliToolApprovalHook } from '../../dist/cli/approval.js';
import { composePreToolUseGate } from '../../dist/cli/hook-ask.js';
import { createJevIntentRuntime } from '../../dist/cli/jev-intent.js';
import { parsePermissionRuleSpec } from '../../dist/cli/permission-rules.js';
import {
  runWithApprovalRequest,
  setPermissionRequestRunner,
  wrapApprovalAsker,
} from '../../dist/cli/permission-request.js';
import { RuntimeJudgeRun } from '../../dist/core/agent/runtime-judge.js';
import { InMemorySessionStore, MossAgent } from '../../dist/index.js';
import { writeFileTool, readFileTool } from '../../dist/tools/file-tools.js';

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'moss-jev-approval-')));
const goal = 'Create hello.txt in the current project containing exactly hello.';
const input = { path: 'hello.txt', content: 'hello' };
const live = process.argv.includes('--live');
let answers = { approval: { choice: 'needed', probability: 0.99 } };
let judgeCalls = 0;
let prompts = 0;
let vetoChecks = 0;
let veto = false;
let rules = [];
const env = {};
const options = {
  workspaceDir: root,
  interactionMode: () => 'manual',
  permissionRules: () => ({ rules, sources: {} }),
};
const gate = createCliToolApprovalHook('workspace-write', env, options);
gate.setAsker(
  wrapApprovalAsker(async () => {
    prompts++;
    return 'n';
  })
);
setPermissionRequestRunner(async () => {
  vetoChecks++;
  return { denied: veto, reason: 'permission hook veto' };
});

const remote = live
  ? createJevIntentRuntime({ ...process.env, MOSS_JEV_APPROVAL: 'active' }).runtimeJudge
  : undefined;
if (live) assert.ok(remote, 'configure the Jev gateway before running --live');
const config = {
  modes: { approval: 'active' },
  async ask(state, questions, signal) {
    judgeCalls++;
    assert.equal(state.goal, goal);
    assert.equal(state.where, root);
    assert.deepEqual(JSON.parse(state.arguments), input);
    return remote ? remote.ask(state, questions, signal) : answers;
  },
};
let turn = 0;
const agent = new MossAgent({
  workspaceDir: root,
  sessionStore: new InMemorySessionStore(),
  runtimeJudge: config,
  hooks: { onBeforeToolExec: (req) => runWithApprovalRequest(req, () => gate(req)) },
  llmProvider: {
    id: 'scripted',
    capabilities: { streaming: false },
    async complete() {
      if (++turn === 1)
        return {
          stopReason: 'tool_use',
          content: [{ type: 'tool_use', id: 'write', name: 'write_file', input }],
        };
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] };
    },
  },
});
try {
  agent.tools.register(writeFileTool);
  for await (const event of agent.streamChat('approval', goal, {
    userIntentText: goal,
    taskFlow: false,
  })) {
    if (event.type === 'error') throw new Error(event.error);
  }
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), 'hello');
  assert.deepEqual([judgeCalls, prompts, vetoChecks], [1, 0, 1]);
  console.log('[jev-approval] PASS scoped one-call approval executed the requested write');

  if (!live) {
    const controller = new AbortController();
    const run = new RuntimeJudgeRun(config, root, goal, controller.signal, () => false, 'test');
    const req = {
      tool: writeFileTool,
      input,
      sessionKey: 'approval',
      runId: 'test',
      toolCallId: 'next',
      abortSignal: controller.signal,
      judgeApproval: (args, where) =>
        run.judgeApproval('next', 'write_file', args, where, controller.signal),
    };
    async function check(label, request, ctx, expected, checkGate = gate) {
      const before = [judgeCalls, prompts];
      const result = await runWithApprovalRequest(request, () => checkGate(request, ctx));
      assert.deepEqual(
        [result.approved, judgeCalls - before[0], prompts - before[1]],
        expected,
        label
      );
    }
    for (const answer of [
      { choice: 'needed', probability: 0.79 },
      { choice: 'unrelated', probability: 1 },
      { choice: 'unclear', probability: 1 },
    ]) {
      answers = { approval: answer };
      const before = vetoChecks;
      await check('ask on uncertain or unrelated', req, undefined, [false, 1, 1]);
      assert.equal(vetoChecks - before, 1);
    }
    answers = {};
    await check('missing verdict', req, undefined, [false, 1, 1]);
    answers = { approval: { choice: 'needed', probability: 0.99 } };
    config.modes.approval = 'shadow';
    await check('shadow only observes', req, undefined, [false, 1, 1]);
    config.modes.approval = 'active';
    const slow = new RuntimeJudgeRun(
      {
        modes: { approval: 'active' },
        ask: async (_state, _questions, signal) => {
          judgeCalls++;
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        },
      },
      root,
      goal,
      controller.signal,
      () => false,
      'unavailable'
    );
    const keepAlive = setTimeout(() => {}, 3000);
    try {
      await check(
        'judge deadline returns to human',
        {
          ...req,
          judgeApproval: (args, where) =>
            slow.judgeApproval('slow', 'write_file', args, where, controller.signal),
        },
        undefined,
        [false, 1, 1]
      );
    } finally {
      clearTimeout(keepAlive);
    }
    veto = true;
    await check('PermissionRequest veto precedes judge', req, undefined, [false, 0, 0]);
    veto = false;
    await check(
      'already allowed read',
      { ...req, tool: readFileTool, input: { path: 'hello.txt' } },
      undefined,
      [true, 0, 0]
    );
    await check('protected path', { ...req, input: { ...input, path: '.env' } }, undefined, [
      false,
      0,
      1,
    ]);
    await check(
      'explicit tool confirmation',
      {
        ...req,
        tool: { ...writeFileTool, metadata: { ...writeFileTool.metadata, requiresApproval: true } },
      },
      undefined,
      [false, 0, 1]
    );
    await check(
      'sensitive device operation',
      {
        ...req,
        tool: { ...readFileTool, name: 'device_file_read' },
        input: { path: '/etc/shadow' },
      },
      undefined,
      [false, 0, 1]
    );
    await check('PreToolUse asks', req, { hookAsks: [{ command: 'manual-review' }] }, [
      false,
      0,
      1,
    ]);
    rules = [parsePermissionRuleSpec('write_file', 'policy', 'ask')];
    await check('policy ask', req, undefined, [false, 0, 1]);
    rules = [parsePermissionRuleSpec('write_file', 'policy', 'deny')];
    await check('policy deny', req, undefined, [false, 0, 0]);
    rules = [];
    const rewritten = composePreToolUseGate(
      async () => ({ approved: true, updatedInput: input }),
      gate
    );
    await check(
      'post-hook arguments',
      { ...req, input: { path: 'other.txt', content: 'other' } },
      undefined,
      [true, 1, 0],
      rewritten
    );
    await check(
      'changed task',
      {
        ...req,
        judgeApproval: async (...args) => {
          const grant = await req.judgeApproval(...args);
          run.noteApprovalUpdate('Stop writing.');
          return grant;
        },
      },
      undefined,
      [false, 1, 1]
    );
    await check(
      'policy changes during judgment',
      {
        ...req,
        judgeApproval: async (...args) => {
          const grant = await req.judgeApproval(...args);
          rules = [parsePermissionRuleSpec('write_file', 'policy', 'deny')];
          return grant;
        },
      },
      undefined,
      [false, 1, 0]
    );
    rules = [];
    const headless = createCliToolApprovalHook('workspace-write', env, {
      ...options,
      printMode: true,
      detailMode: 'quiet',
    });
    await check('no interactive prompt', req, undefined, [false, 0, 0], headless);
    console.log(
      '[jev-approval] PASS human fallback, mandatory prompts, vetoes, final arguments and stale verdicts'
    );
  }
} finally {
  setPermissionRequestRunner(undefined);
  await agent.close();
  await rm(root, { recursive: true, force: true });
}
