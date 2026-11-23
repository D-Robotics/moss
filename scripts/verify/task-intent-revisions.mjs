#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = process.env.MOSS_VERIFY_DIST_ROOT ?? path.join(root, 'dist');
const { MossAgent } = await import(pathToFileURL(path.join(dist, 'core/agent/moss-agent.js')).href);
const { InMemorySessionStore } = await import(
  pathToFileURL(path.join(dist, 'core/session/session.js')).href
);
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-intent-'));
const agents = [];

function frame(options) {
  const lines = options.systemPrompt.split('\n');
  const index = lines.lastIndexOf('[Runtime-owned current task intent]');
  return index < 0
    ? { revision: 0, inputSeq: 1, pendingInputs: [{ id: 'initial', text: '只读，查询设备' }] }
    : JSON.parse(lines[index + 1]);
}

function declaration(
  f,
  disposition = 'execute',
  changes = [],
  plan = ['Read the requested device information']
) {
  return {
    type: 'tool_use',
    id: `decision-${f.inputSeq}`,
    name: 'turn_decision',
    input: {
      baseRevision: f.revision,
      inputSeq: f.inputSeq,
      messageIds: f.pendingInputs.map((item) => item.id),
      changes,
      disposition,
      plan: disposition === 'execute' ? plan : [],
    },
  };
}

const toolCall = (name, id = name) => ({ type: 'tool_use', id, name, input: {} });
const response = (...content) => ({
  stopReason: content.some((item) => item.type === 'tool_use') ? 'tool_use' : 'end_turn',
  content,
});
const text = (value) => ({ type: 'text', text: value });

function createAgent(run, options = {}) {
  const provider = {
    id: 'scripted',
    displayName: 'offline intent probe',
    capabilities: { streaming: options.streaming === true },
    calls: 0,
    async complete(request) {
      return run(request, ++provider.calls);
    },
    async stream(request, onEvent) {
      const result = await this.complete(request);
      onEvent({ type: 'message_start' });
      for (const block of result.content) {
        onEvent({
          type: 'content_block_start',
          ...(block.type === 'tool_use' ? { toolUse: { id: block.id, name: block.name } } : {}),
        });
        onEvent(
          block.type === 'tool_use'
            ? { type: 'content_block_delta', partialJson: JSON.stringify(block.input) }
            : { type: 'content_block_delta', text: block.text }
        );
        onEvent({ type: 'content_block_stop' });
      }
      onEvent({ type: 'message_delta', stopReason: result.stopReason });
      onEvent({ type: 'message_stop' });
      return result;
    },
  };
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: options.sessionStore ?? new InMemorySessionStore(),
    workspaceDir: workspace,
    sessionInboxDir: options.inboxDir ?? path.join(workspace, `inbox-${agents.length}`),
    baseSystemPrompt: 'Follow the user. Never invent observations.',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    taskIntent: true,
    ...options,
  });
  agents.push(agent);
  return { agent, provider };
}

function register(agent, name, execute) {
  agent.tools.register({
    name,
    description: name,
    metadata: { sideEffectClass: 'local_write' },
    inputSchema: { type: 'object', properties: {} },
    execute,
  });
}

try {
  const workspaceSteps = [];
  const admittedWorkspace = path.join(workspace, 'admitted');
  const admitted = createAgent(
    (request, count) => {
      if (count > 1) return response(text('Workspace verified.'));
      return response(declaration(frame(request)), toolCall('workspace_probe'));
    },
    {
      hooks: {
        prepareToolBatch: async ({ calls, context, assertCurrent }) => {
          assertCurrent();
          assert.deepEqual(
            calls.map((call) => call.name),
            ['workspace_probe']
          );
          assert.equal(admitted.agent.getTaskIntent('workspace-admission').disposition, 'execute');
          assert.equal(
            admitted.agent.getTaskIntentReceipt('workspace-admission', 'workspace-input').status,
            'committed'
          );
          workspaceSteps.push('admit');
          admitted.agent.tools.remove('workspace_probe');
          register(admitted.agent, 'workspace_probe', async (_input, ctx) => {
            assert.equal(ctx.workspaceDir, admittedWorkspace);
            workspaceSteps.push('execute');
            return 'Verified the admitted workspace.';
          });
          return { ...context, workspaceDir: admittedWorkspace };
        },
      },
    }
  );
  register(admitted.agent, 'workspace_probe', async () => {
    workspaceSteps.push('stale tool');
    return 'This tool was replaced before dispatch.';
  });
  await admitted.agent.chat('workspace-admission', 'Verify the project', {
    userInput: { id: 'workspace-input' },
    taskFlow: false,
  });
  assert.deepEqual(workspaceSteps, ['admit', 'execute']);
  console.log(
    'PASS tool batch preparation observes committed intent and replaces dispatch context'
  );

  const starts = [];
  const { agent, provider } = createAgent((request, count) => {
    const f = frame(request);
    if (count >= 3) return response(text('Current task finished.'));
    if (count === 1)
      return response(
        declaration(f, 'execute', [
          {
            field: 'constraints',
            operation: 'add',
            value: '只读',
            messageId: f.pendingInputs[0].id,
            quote: '只读',
          },
        ]),
        toolCall('start_a'),
        toolCall('obsolete_b')
      );
    if (f.pendingInputs.length)
      return response(
        declaration(f, 'execute', [
          {
            field: 'executionSurface',
            operation: 'set',
            value: 'visible terminal',
            messageId: f.pendingInputs.at(-1).id,
            quote: '可见终端',
          },
        ]),
        toolCall('correct_c')
      );
    return response(text('Current task finished.'));
  });
  register(agent, 'start_a', async () => {
    starts.push('a');
    agent.steer('correction', '改用可见终端，其他要求保持', { id: 'correction-1' });
    return 'A completed before the correction; remaining old calls must stop.';
  });
  register(agent, 'obsolete_b', async () => {
    starts.push('b');
    return 'incorrect old action';
  });
  register(agent, 'correct_c', async () => {
    starts.push('c');
    return 'new action';
  });
  const result = await agent.chat('correction', '只读，查询设备', {
    userInput: { id: 'initial' },
    taskFlow: false,
    maxTurns: 5,
  });
  assert(!starts.includes('b'), 'old B started after a correction was received');
  assert.deepEqual(starts, ['a', 'c']);
  assert.equal(provider.calls, 3, 'a standalone intent LLM request was added');
  assert.equal(agent.getTaskIntent('correction').state.executionSurface, 'visible terminal');
  assert.deepEqual(agent.getTaskIntent('correction').state.constraints, ['只读']);
  assert.equal(agent.getTaskIntentReceipt('correction', 'correction-1').status, 'committed');
  assert(!result.toolResults.some((item) => item.name === 'obsolete_b' && !item.isError));
  console.log(
    'PASS same-response update, stale batch suppression, preserved constraint, no extra classifier call'
  );

  const qa = createAgent((request) =>
    response(declaration(frame(request), 'answer'), text('Yes, that terminal can be used.'))
  );
  const answer = await qa.agent.chat('question', '能用这个终端吗？', {
    userInput: { id: 'question-1' },
    taskFlow: false,
  });
  assert.equal(qa.provider.calls, 1, 'metadata-only Q&A created an unnecessary follow-up');
  assert.match(answer.response, /Yes/);
  console.log('PASS single-call capability question');
  const streamed = createAgent(
    (request) => response(declaration(frame(request), 'answer'), text('Yes, I can explain it.')),
    { streaming: true }
  );
  const streamedResult = await streamed.agent.chat('streamed', 'Can you explain it?', {
    userInput: { id: 'streamed-1' },
    taskFlow: false,
  });
  assert.equal(streamed.provider.calls, 1);
  assert.equal(streamedResult.response, 'Yes, I can explain it.');
  console.log('PASS streamed native tool declaration commits without an extra classifier');

  let planActionStarts = 0;
  const planOnly = createAgent((request, count) => {
    if (count === 1) return response(declaration(frame(request)), text('I will check the device.'));
    if (count === 2) return response(toolCall('plan_action'));
    return response(text('Device checked.'));
  });
  register(planOnly.agent, 'plan_action', async () => {
    planActionStarts++;
    return 'actual observation';
  });
  await planOnly.agent.chat('plan-only', 'Check the device', {
    userInput: { id: 'plan-only-1' },
    taskFlow: false,
    maxTurns: 4,
  });
  assert.equal(
    planActionStarts,
    1,
    'committed plan without same-response actions ended prematurely'
  );
  assert.equal(planOnly.provider.calls, 3);
  console.log('PASS plan-only decision continues into normal execution without another classifier');

  let publication;
  let injectAtReceipt = true;
  const store = new InMemorySessionStore();
  const append = store.appendMessage.bind(store);
  store.appendMessage = async (key, message) => {
    await append(key, message);
    if (
      injectAtReceipt &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === 'tool_result')
    ) {
      injectAtReceipt = false;
      publication.agent.steer('publication', '请按最新问题回答', { id: 'publication-2' });
    }
  };
  const visible = [];
  publication = createAgent(
    (request, count) =>
      response(
        declaration(frame(request), 'answer'),
        text(count === 1 ? 'OBSOLETE ANSWER' : 'Latest answer.')
      ),
    {
      sessionStore: store,
      onAgentLoopEvent: (event) => {
        if (event.type === 'message_delta') visible.push(event.delta);
      },
    }
  );
  const publicationResult = await publication.agent.chat('publication', 'Old question', {
    userInput: { id: 'publication-1' },
    taskFlow: false,
    maxTurns: 4,
  });
  assert(!visible.join('').includes('OBSOLETE ANSWER'));
  assert(visible.join('').includes('Latest answer.'));
  assert.match(publicationResult.response, /Latest answer/);
  console.log('PASS input during receipt persistence prevents stale answer publication');

  let illegalStarts = 0;
  const invalid = createAgent(() => response(toolCall('illegal')));
  register(invalid.agent, 'illegal', async () => {
    illegalStarts++;
    return 'should not execute';
  });
  const held = await invalid.agent.chat('invalid', 'Do the task', {
    userInput: { id: 'invalid-1' },
    taskFlow: false,
    maxTurns: 5,
  });
  assert.equal(illegalStarts, 0);
  assert.equal(invalid.provider.calls, 2, 'invalid declarations should have one bounded repair');
  assert.equal(held.stopReason, 'task_intent_hold');
  console.log('PASS missing declaration blocks all actions with bounded repair');

  const raceStarts = [];
  let race;
  race = createAgent((request, count) => {
    const f = frame(request);
    if (count === 1) {
      race.agent.steer('race', '改成新任务', { id: 'race-2' });
      return response(declaration(f), toolCall('stale_race'));
    }
    return response(declaration(f, 'answer'), text('Latest input applied.'));
  });
  register(race.agent, 'stale_race', async () => {
    raceStarts.push('bad');
    return 'bad';
  });
  await race.agent.chat('race', '原任务', {
    userInput: { id: 'race-1' },
    taskFlow: false,
    maxTurns: 4,
  });
  assert.deepEqual(raceStarts, []);
  assert.equal(race.agent.getTaskIntent('race').processedSeq, 2);
  console.log('PASS input arriving during model generation supersedes old response');

  let approval;
  let approvedStarts = 0;
  approval = createAgent(
    (request, count) => {
      const f = frame(request);
      if (count === 1) return response(declaration(f), toolCall('approval_action'));
      return response(declaration(f, 'answer'), text('New request applied.'));
    },
    {
      hooks: {
        async onBeforeToolExec() {
          approval.agent.steer('approval', '先不要执行', { id: 'approval-2' });
          return { approved: true };
        },
      },
    }
  );
  register(approval.agent, 'approval_action', async () => {
    approvedStarts++;
    return 'bad';
  });
  await approval.agent.chat('approval', '执行任务', {
    userInput: { id: 'approval-1' },
    taskFlow: false,
    maxTurns: 4,
  });
  assert.equal(approvedStarts, 0);
  console.log('PASS correction while awaiting approval prevents real invocation');

  const inboxDir = path.join(workspace, 'restart-inbox');
  const durable = createAgent(
    (request) => response(declaration(frame(request), 'answer'), text('Saved.')),
    { inboxDir }
  );
  await durable.agent.chat('durable', '保存这个理解', {
    userInput: { id: 'durable-1' },
    taskFlow: false,
  });
  const before = durable.agent.getTaskIntent('durable');
  await durable.agent.close();
  const restarted = createAgent(
    (request) => response(declaration(frame(request), 'answer'), text('Restored.')),
    { inboxDir }
  );
  assert.deepEqual(restarted.agent.getTaskIntent('durable'), before);
  restarted.agent.admitTaskInput('durable', { id: 'durable-1', text: '保存这个理解' });
  assert.deepEqual(
    restarted.agent.getTaskIntent('durable'),
    before,
    'same input re-applied after restart'
  );
  restarted.agent.admitTaskInput('durable', { id: 'durable-2', text: '纠正后的理解' });
  assert.throws(() => restarted.agent.assertTaskIntentCurrent('durable'));
  console.log('PASS restart persistence, receipt dedupe, pending-input barrier');
} finally {
  await Promise.allSettled(agents.map((agent) => agent.close()));
  await fs.rm(workspace, { recursive: true, force: true });
}
