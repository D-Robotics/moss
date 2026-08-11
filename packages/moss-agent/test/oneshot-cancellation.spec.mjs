#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';

import { withCliRunCancellation } from '../dist/cli/run-cancellation.js';
import { ExitCode } from '../dist/cli/exit-codes.js';
import { runOneShot } from '../dist/cli/oneshot.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { ErrorCode, MossError } from '../dist/errors.js';

function createBlockingAgent(onStart) {
  return new MossAgent({
    llmProvider: {
      id: 'blocking',
      displayName: 'Blocking provider',
      async complete() {
        throw new Error('not used');
      },
      async stream(options) {
        onStart();
        await new Promise((resolve, reject) => {
          const signal = options.abortSignal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    },
    sessionStore: new InMemorySessionStore(),
    baseSystemPrompt: 'test',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxLLMRetries: 0,
  });
}

{
  const signalTarget = new EventEmitter();
  let observedSignal;
  const run = withCliRunCancellation(async (signal) => {
    observedSignal = signal;
    signalTarget.emit('SIGINT');
    return 'cancelled';
  }, signalTarget);
  assert.equal(await run, 'cancelled');
  assert.equal(observedSignal.aborted, true);
  assert.ok(observedSignal.reason instanceof MossError);
  assert.equal(observedSignal.reason.code, ErrorCode.USER_ABORTED);
  assert.equal(signalTarget.listenerCount('SIGINT'), 0, 'SIGINT listener is always removed');
}

{
  const moduleUrl = new URL('../dist/cli/run-cancellation.js', import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { withCliRunCancellation } from ${JSON.stringify(moduleUrl)};
       process.on('message', (message) => {
         if (message === 'SIGINT') process.emit('SIGINT');
       });
       await withCliRunCancellation(() => {
         process.stdout.write('ready\\n');
         return new Promise(() => setInterval(() => {}, 1000));
       });`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  const sendSigInt = () => {
    if (process.platform === 'win32') {
      // child.kill('SIGINT') cannot synthesize a console Ctrl+C event on Windows.
      child.send('SIGINT');
    } else {
      child.kill('SIGINT');
    }
  };
  await once(child.stdout, 'data');
  sendSigInt();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(child.exitCode, null, 'first SIGINT gives the provider time to cancel');
  const exited = once(child, 'exit');
  sendSigInt();
  const [exitCode] = await exited;
  assert.equal(exitCode, 130, 'second SIGINT terminates an uncooperative run');
}

{
  const signalTarget = new EventEmitter();
  const forcedExitCodes = [];
  let resolveRun;
  const pending = withCliRunCancellation(
    () =>
      new Promise((resolve) => {
        resolveRun = resolve;
      }),
    signalTarget,
    { forceExit: (code) => forcedExitCodes.push(code) }
  );
  signalTarget.emit('SIGINT');
  assert.equal(forcedExitCodes.length, 0, 'first SIGINT remains graceful');
  signalTarget.emit('SIGINT');
  assert.deepEqual(forcedExitCodes, [130], 'second SIGINT forces the conventional shell exit');
  resolveRun('done');
  await pending;
  assert.equal(signalTarget.listenerCount('SIGINT'), 0);
}

{
  const originalExitCode = process.exitCode;
  const controller = new AbortController();
  let output = '';
  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  try {
    process.exitCode = undefined;
    const pending = runOneShot(createBlockingAgent(startedResolve), 'wait', undefined, {
      sessionKey: 'cancelled-oneshot',
      outputFormat: 'stream-json',
      stdout: {
        write(chunk) {
          output += chunk;
        },
      },
      abortSignal: controller.signal,
    });
    await started;
    controller.abort(
      new MossError({
        code: ErrorCode.USER_ABORTED,
        message: 'Run cancelled by user.',
        recoverable: true,
      })
    );
    await pending;
    assert.equal(process.exitCode, ExitCode.USER_ABORTED);
    const result = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'result');
    assert.equal(result?.error_code, ErrorCode.USER_ABORTED);
    assert.equal(result?.recoverable, true);
  } finally {
    process.exitCode = originalExitCode;
  }
}

{
  const originalExitCode = process.exitCode;
  let output = '';
  const controller = new AbortController();
  controller.abort(
    new MossError({
      code: ErrorCode.USER_ABORTED,
      message: 'Cancelled before start.',
      recoverable: true,
    })
  );
  try {
    process.exitCode = undefined;
    await runOneShot(
      createBlockingAgent(() => {}),
      'never starts',
      undefined,
      {
        sessionKey: 'pre-aborted',
        outputFormat: 'stream-json',
        stdout: {
          write: (chunk) => {
            output += chunk;
          },
        },
        abortSignal: controller.signal,
      }
    );
    const result = output
      .trim()
      .split('\n')
      .map(JSON.parse)
      .find((event) => event.type === 'result');
    assert.equal(result?.error_code, ErrorCode.USER_ABORTED);
    assert.equal(result?.recoverable, true);
    assert.equal(process.exitCode, ExitCode.USER_ABORTED);
  } finally {
    process.exitCode = originalExitCode;
  }
}

console.log('[PASS] oneshot SIGINT cancellation reaches the agent and exits predictably');
