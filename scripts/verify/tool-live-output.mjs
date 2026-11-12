#!/usr/bin/env node
/** Offline probe with a real foreground child process. Run after building dist/. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeOneToolCall } from '../../dist/core/tools/execute-tool-call.js';
import { createMossAgentLoopEventAdapter } from '../../dist/core/agent/moss-agent-loop-adapter.js';
import { execTool } from '../../dist/tools/builtin.js';
import { noteKnownSecret } from '../../dist/safety/known-secrets.js';

const workspace = await mkdtemp(join(tmpdir(), 'moss-tool-live-'));
const controller = new AbortController();
const deps = (tool, push, extra = {}) => ({
  toolsForRun: [tool],
  toolCtx: { workspaceDir: workspace, sessionKey: 'tool-live' },
  sessionKey: 'tool-live',
  abortSignal: controller.signal,
  toolTimeoutMs: 5000,
  enableHeartbeat: false,
  heartbeatIntervalMs: 1000,
  skipHeartbeatToolNames: new Set(),
  push,
  ...extra,
});
try {
  const script = join(workspace, 'output.mjs');
  await writeFile(
    script,
    `for (const line of ['first', 'second', 'third']) {
    process.stdout.write(line + '\\n');
    await new Promise(resolve => setTimeout(resolve, 150));
  }`
  );
  for (const eventMode of [false, true]) {
    const chunks = [];
    const arrivedAt = [];
    const adapter = createMossAgentLoopEventAdapter();
    let complete = false;
    const result = await executeOneToolCall(
      {
        id: `exec-${eventMode}`,
        name: 'exec',
        input: { command: `"${process.execPath}" "${script}"`, event: eventMode },
      },
      deps(execTool, (event) => {
        for (const output of adapter.onMiniEvent(event)) {
          if (output.type === 'tool_progress' && output.chunk) {
            assert.equal(complete, false);
            chunks.push(output.chunk);
            arrivedAt.push(Date.now());
          }
        }
      })
    );
    complete = true;
    assert.equal(result.kind, 'completed');
    assert.equal(result.isError, false, result.text);
    assert.equal(chunks.length, 3, `exec event=${eventMode} must emit three live lines`);
    assert.ok(arrivedAt[2] - arrivedAt[0] >= 150, 'lines must arrive while the child runs');
    for (const line of ['first', 'second', 'third']) assert.ok(chunks.join('').includes(line));
  }

  const known = 'sample-live-tool-secret';
  noteKnownSecret(known);
  const safeEvents = [];
  const hostOutput = [];
  let savedCallback;
  const tool = {
    name: 'stream_fixture',
    description: 'Exercise live output.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input, ctx) {
      savedCallback = ctx.onToolOutput;
      ctx.onToolOutput?.('visible line\n');
      ctx.onToolOutput?.(known.slice(0, 8));
      ctx.onToolOutput?.(known.slice(8) + '\n');
      ctx.onToolOutput?.('last partial line');
      return 'ok';
    },
  };
  await executeOneToolCall(
    { id: 'safe', name: tool.name, input: {} },
    deps(tool, (event) => safeEvents.push(event), {
      toolCtx: {
        workspaceDir: workspace,
        sessionKey: 'tool-live',
        onToolOutput: (chunk) => hostOutput.push(chunk),
      },
    })
  );
  const live = safeEvents
    .filter((event) => event.type === 'tool_execution_progress')
    .map((event) => event.chunk)
    .join('');
  assert.equal(live, 'visible line\n[REDACTED]\nlast partial line');
  assert.equal(hostOutput.join(''), live);
  savedCallback?.('late output\n');
  assert.equal(hostOutput.join(''), live, 'settled tools must ignore late callbacks');

  const cancelledEvents = [];
  const cancel = new AbortController();
  const cancelledTool = {
    ...tool,
    async execute(_input, ctx) {
      ctx.onToolOutput?.('visible line\n');
      ctx.onToolOutput?.(known.slice(0, 8));
      await Promise.resolve();
      cancel.abort();
      ctx.onToolOutput?.('late output\n');
      throw new Error('aborted');
    },
  };
  await executeOneToolCall(
    { id: 'cancel', name: tool.name, input: {} },
    deps(cancelledTool, (event) => cancelledEvents.push(event), { abortSignal: cancel.signal })
  );
  assert.equal(
    cancelledEvents
      .filter((event) => event.type === 'tool_execution_progress')
      .map((event) => event.chunk)
      .join(''),
    'visible line\n'
  );
  console.log(
    '[tool-live-output] real exec normal/event lines, split secrets, safe final tails and cancellation passed'
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
