import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJevIntentRuntime } from '../../dist/cli/jev-intent.js';
import { RuntimeJudgeRun } from '../../dist/core/agent/runtime-judge.js';
import { InMemorySessionStore, MossAgent } from '../../dist/index.js';
import { execTool } from '../../dist/tools/builtin.js';
import { readFileTool, writeFileTool } from '../../dist/tools/file-tools.js';
import { runTestsTool } from '../../dist/tools/harness-tools.js';

const configured = {
  MOSS_JEV_SYSTEMONE_URL: 'https://jev.example.test/v1/systemone',
  MOSS_JEV_RELAY_KEY: 'fixture-jev-key',
};
const defaults = createJevIntentRuntime(configured, {
  async fetch(url, init) {
    assert.equal(url, configured.MOSS_JEV_SYSTEMONE_URL);
    assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer fixture-jev-key');
    assert.equal(JSON.parse(init.body).questions.completion.type, 'choice');
    return Response.json({
      answers: {
        completion: { type: 'choice', choice: 'verify', probabilities: { verify: 0.99 } },
      },
    });
  },
});
assert.deepEqual(defaults.runtimeJudge?.modes, {
  input: 'active',
  completion: 'active',
  approval: 'off',
  constraint: 'off',
  output: 'off',
  progress: 'off',
});
assert.equal(
  (
    await defaults.runtimeJudge.ask(
      {},
      {
        completion: {
          type: 'choice',
          instructions: 'Check completion',
          criteria: { verify: 'Verify' },
        },
      },
      new AbortController().signal
    )
  )?.completion?.choice,
  'verify'
);
assert.deepEqual(createJevIntentRuntime({}), {});
assert.deepEqual(
  createJevIntentRuntime({ ...configured, MOSS_JEV_ENABLED: '0', MOSS_JEV_INTENT: 'active' }),
  {}
);
assert.equal(
  createJevIntentRuntime({ ...configured, MOSS_JEV_INTENT: 'off' }).runtimeJudge?.modes.input,
  'off'
);
assert.equal(
  createJevIntentRuntime({ ...configured, MOSS_JEV_COMPLETION: 'shadow' }).runtimeJudge?.modes
    .completion,
  'shadow'
);

const live = process.argv.includes('--live');
const temp = await mkdtemp(path.join(os.tmpdir(), 'moss-jev-runtime-'));
const workspace = await realpath(temp);
const testFile = 'tests/login-timeout.test.mjs';
const targetFile = 'src/auth/login.mjs';
const goal = '修复登录超时，并运行 ' + testFile + ' 验证。';
const clue = 'Authentication callback trace: deadline budget 1000 ms, expected at least 5000 ms.';
const invalidAnswer = '登录超时已修复，回归测试已通过。';
const logLines = Array.from({ length: 120 }, (_, i) =>
  i === 60
    ? clue
    : 'ASSET_BANNER_' +
      String(i).padStart(3, '0') +
      ' unrelated dashboard localization bundle copied successfully for static assets.'
);
const decisions = [];
const holds = [];
const tools = [];
let turn = 0;
let visible = '';
let done;
let archivePath;
let agent;

function call(name, input) {
  return {
    stopReason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tool-' + turn, name, input }],
  };
}

try {
  await mkdir(path.join(workspace, 'src/auth'), { recursive: true });
  await mkdir(path.join(workspace, 'tests'));
  await writeFile(path.join(workspace, targetFile), 'export const loginTimeout = 1000;\n');
  await writeFile(
    path.join(workspace, 'diagnose.mjs'),
    "import { loginTimeout } from './src/auth/login.mjs';\n" +
      'console.log(' +
      JSON.stringify(logLines.join('\n')) +
      ".replace('budget 1000 ms', 'budget ' + loginTimeout + ' ms'));\n"
  );
  await writeFile(
    path.join(workspace, testFile),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
      "import { loginTimeout } from '../src/auth/login.mjs';\n" +
      "test('login timeout budget', () => assert.equal(loginTimeout, 5000));\n"
  );

  const fixtureJudge = {
    modes: { output: 'active', completion: 'active' },
    async ask(state, questions) {
      if (state.chunks)
        return Object.fromEntries(
          Object.entries(state.chunks).map(([id, text]) => [id, text.includes(clue) ? 0.99 : 0.01])
        );
      if (questions.completion) return { completion: { choice: 'verify', probability: 0.99 } };
      return {};
    },
  };
  const transport = live
    ? createJevIntentRuntime({
        ...process.env,
        MOSS_JEV_OUTPUT: 'active',
        MOSS_JEV_COMPLETION: 'active',
      }).runtimeJudge
    : fixtureJudge;
  assert.ok(transport, 'Jev runtime adapter must be enabled');
  agent = new MossAgent({
    workspaceDir: workspace,
    sessionStore: new InMemorySessionStore(),
    runtimeJudge: {
      modes: transport.modes,
      async ask(state, questions, signal) {
        const started = performance.now();
        const answers = await transport.ask(state, questions, signal);
        if (state.chunks) {
          const clueId = Object.keys(state.chunks).find((id) => state.chunks[id].includes(clue));
          assert.ok(clueId, 'Jev received the failure clue in a candidate chunk');
          decisions.push({
            point: 'output',
            clueScore: answers?.[clueId],
            milliseconds: Math.round(performance.now() - started),
          });
        }
        if (questions.completion)
          decisions.push({
            point: 'completion',
            decision: answers?.completion,
            milliseconds: Math.round(performance.now() - started),
            status: state.requested_check?.status_after_last_edit,
          });
        return answers;
      },
    },
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    onCompletionGateBlocked(hold) {
      holds.push(hold);
    },
    llmProvider: {
      id: 'fixture',
      capabilities: { streaming: false },
      async complete({ messages }) {
        turn++;
        const history = JSON.stringify(messages);
        if (turn === 1) return call('exec', { command: 'node diagnose.mjs' });
        if (turn === 2) {
          assert.ok(
            history.includes(clue),
            'filtered model context retains diagnostic clue: ' +
              JSON.stringify({
                decisions,
                outcomes: tools.map(({ toolName, result, outcome }) => ({
                  toolName,
                  result: result.slice(0, 350),
                  outcome,
                })),
              })
          );
          archivePath = history.match(/Full output saved to ([^\]]+)\]/)?.[1];
          assert.ok(archivePath, 'model receives recoverable archive path');
          assert.ok(
            logLines.some((line) => !history.includes(line)),
            'unrelated output omitted from model context'
          );
          return call('read_file', { path: targetFile });
        }
        if (turn === 3)
          return call('write_file', {
            path: targetFile,
            content: 'export const loginTimeout = 5000;\n',
          });
        if (turn === 4) return call('read_file', { path: targetFile });
        if (turn === 5)
          return { stopReason: 'end_turn', content: [{ type: 'text', text: invalidAnswer }] };
        if (turn === 6) {
          assert.ok(
            history.includes('Run the verification requested by the user (' + testFile + ')')
          );
          return call('run_tests', { file: testFile });
        }
        assert.equal(turn, 7);
        assert.match(history, /tests_pass=true/);
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: '登录超时已修复，指定回归测试实际通过。' }],
        };
      },
    },
  });

  for (const tool of [execTool, readFileTool, writeFileTool, runTestsTool])
    agent.tools.register(tool);

  // Submit once. The tool result and attempted completion drive the remaining turns.
  for await (const event of agent.streamChat('jev-validation', goal, {
    userIntentText: goal,
    taskFlow: false,
  })) {
    if (event.type === 'text_delta') visible += event.delta;
    if (event.type === 'tool_end') tools.push(event);
    if (event.type === 'error') throw new Error(event.error);
    if (event.type === 'done') done = event.result;
  }
  assert.equal(
    await readFile(path.join(workspace, targetFile), 'utf8'),
    'export const loginTimeout = 5000;\n'
  );
  assert.ok(archivePath);
  const originalLog = await readFile(path.join(workspace, archivePath), 'utf8');
  assert.ok(
    logLines.every((line) => originalLog.includes(line)),
    'complete diagnostic log remains recoverable'
  );
  assert.equal(tools.filter(({ toolName }) => toolName === 'run_tests').length, 1);
  const verification = tools.find(({ toolName }) => toolName === 'run_tests');
  assert.match(verification?.content ?? verification?.result, /tests_pass=true/);
  assert.ok(holds.some(({ gate, kind }) => gate === 'jev-completion' && kind === 'verify'));
  assert.ok(!visible.includes(invalidAnswer), 'unverified reply was never published');
  assert.equal(done?.response, '登录超时已修复，指定回归测试实际通过。');
  assert.ok(
    decisions.some(({ point, clueScore }) => point === 'output' && clueScore >= 0.8),
    JSON.stringify(decisions)
  );
  assert.ok(
    decisions.some(({ decision, status }) => decision?.choice === 'verify' && status === 'not_run'),
    JSON.stringify(decisions)
  );
  console.log(
    JSON.stringify(
      {
        mode: live ? 'live gateway' : 'fixture judge',
        userInputs: 1,
        turns: turn,
        tools: tools.map(({ toolName }) => toolName),
        decisions,
        holds,
        final: done.response,
      },
      null,
      2
    )
  );
  if (!live) {
    const seen = [];
    const controller = new AbortController();
    const probe = new RuntimeJudgeRun(
      {
        modes: { constraint: 'active', progress: 'active', completion: 'active' },
        async ask(_state, questions) {
          seen.push(Object.keys(questions));
          if (questions.progress) {
            return { progress: { choice: 'change_approach', probability: 0.99 } };
          }
          return {};
        },
      },
      workspace,
      '修复登录超时，只改 src/auth/，并运行 ' + testFile,
      controller.signal,
      () => false,
      'offline-checks'
    );
    assert.equal(
      await probe.beforeTool('outside', writeFileTool, { path: testFile }),
      'This operation cannot be verified to stay within the user’s allowed path src/auth'
    );
    assert.equal(await probe.beforeTool('inside', writeFileTool, { path: targetFile }), undefined);
    probe.noteStart('check-before-write');
    probe.noteStart('later-write');
    probe.recordToolResult({
      id: 'later-write',
      name: 'write_file',
      input: { path: targetFile },
      output: 'Written',
      outcome: 'ok',
      failed: false,
      fileMutation: true,
    });
    probe.noteVerification('check-before-write', testFile, 'passed');
    assert.match(probe.verifiedAnswer(invalidAnswer), /not run after the last change/);
    const failure = {
      id: 'failure-1',
      name: 'run_tests',
      input: { file: testFile },
      output: 'FAIL login callback assertion',
      outcome: 'error',
      failed: true,
      started: true,
      fileMutation: false,
    };
    assert.equal(await probe.progress([failure]), undefined);
    assert.match(await probe.progress([{ ...failure, id: 'failure-2' }]), /change approach/);
    assert.equal(await probe.progress([{ ...failure, id: 'failure-3' }]), undefined);
    assert.equal(seen.filter((ids) => ids.includes('progress')).length, 1);
    console.log('[jev-runtime] PASS scope, stale evidence, and repeated failure deduplication');
  }
} finally {
  await agent?.close();
  await rm(temp, { recursive: true, force: true });
}
