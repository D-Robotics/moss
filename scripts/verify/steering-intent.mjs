/** Exercise the late tool-start boundary and the corrected goal's lifecycle offline. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InMemorySessionStore, MossAgent, resumeTask, runTask } from '../../dist/index.js';

const correction = '改一下，只解释，别改代码';
const statusQuestion = '顺便问一下，进度怎么样？';
const readOnly = {
  intent: 'task_correction',
  probability: 0.97,
  editPolicy: { choice: 'read_only', probability: 0.98 },
};
const question = {
  intent: 'question',
  probability: 0.97,
  editPolicy: { choice: 'unchanged', probability: 0.97 },
};

async function runCase(workspaceDir, name, options) {
  const sessionKey = name;
  const input = options.message ?? correction;
  const initial = 'Fix the add function.';
  let agent;
  let approvals = 0;
  let executions = 0;
  let decisions = 0;
  let turns = 0;
  const outcomes = [];
  const toolResponse = () => ({
    stopReason: 'tool_use',
    content: [{ type: 'tool_use', id: 'edit-' + turns, name: 'edit_fixture', input: {} }],
  });
  agent = new MossAgent({
    workspaceDir,
    sessionStore: new InMemorySessionStore(),
    ...(options.shadow
      ? { observeUserIntent: async () => {} }
      : {
          decideSteeringIntent: async () => {
            decisions++;
            return options.decision;
          },
        }),
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    verificationGate: false,
    llmProvider: {
      id: 'fixture',
      capabilities: { streaming: false },
      async complete({ messages }) {
        turns++;
        if (turns === 1) return toolResponse();
        const history = JSON.stringify(messages);
        assert.ok(history.includes(input));
        assert.equal(history.includes('The prior plan is invalid'), options.block);
        if (turns === 2 && options.block) return toolResponse();
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'Done explaining.' }] };
      },
    },
    hooks: {
      async onBeforeToolExec() {
        approvals++;
        assert.ok(agent.steer(sessionKey, input));
        return { approved: true };
      },
    },
  });
  agent.tools.register({
    name: 'edit_fixture',
    description: 'A counted fixture mutation.',
    metadata: { sideEffectClass: 'local_write' },
    inputSchema: { type: 'object', additionalProperties: false },
    async execute() {
      executions++;
      return 'Executed fixture edit.';
    },
  });
  let done;
  try {
    for await (const event of agent.streamChat(sessionKey, initial, {
      userIntentText: initial,
      taskFlow: false,
      ...(options.goal ? { goalExecWait: true } : {}),
    })) {
      if (event.type === 'tool_end') outcomes.push(event);
      if (event.type === 'error') throw new Error(String(event.error));
      if (event.type === 'done') done = event.result;
    }
  } finally {
    await agent.close();
  }
  assert.equal(approvals, 1, 'the stale action already reached approval before steering');
  assert.equal(executions, options.block ? 0 : 1);
  assert.equal(decisions, options.shadow ? 0 : 1, 'classify each steering input once');
  if (options.block) {
    assert.match(outcomes[0].result, /new user instruction invalidated the pending plan/);
    assert.match(outcomes[1].result, /limits this run to read-only actions/);
  }
  assert.equal(done?.response, 'Done explaining.');
  if (options.goal) assert.equal(done?.stopReason, 'intent_revised');
  console.log('[steering-intent] PASS ' + name);
  return done?.stopReason;
}

const workspace = await mkdtemp(path.join(tmpdir(), 'moss-steering-intent-'));
try {
  const stopReason = await runCase(workspace, 'blocks a write approved under the old intent', {
    decision: readOnly,
    block: true,
    goal: true,
  });
  await runCase(workspace, 'keeps tools read-only when the judge is unavailable', { block: true });
  await runCase(workspace, 'lets a status question through without superseding the plan', {
    decision: question,
    message: statusQuestion,
    block: false,
  });
  await runCase(workspace, 'leaves execution unchanged in shadow mode', {
    shadow: true,
    block: false,
  });

  let turns = 0;
  const deps = {
    workspaceDir: workspace,
    async runTurn() {
      turns++;
      return { text: 'Intent revised.', stopReason };
    },
    verdictProvider: {
      source: 'command',
      async evaluate() {
        assert.fail('The superseded goal must not run the old acceptance.');
      },
    },
  };
  const task = await runTask(deps, 'Fix the add function.', { acceptanceCommand: 'echo old' });
  assert.equal(task.outcome, 'blocked');
  assert.match(task.blockedReason, /Start a new goal/);
  const resumed = await resumeTask(deps, task.snapshot.taskId);
  assert.equal(resumed.outcome, 'blocked');
  assert.equal(turns, 1, 'resume cannot start another turn for the old goal');
  console.log(
    '[steering-intent] PASS corrected goals skip old verification and refuse stale resume'
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
