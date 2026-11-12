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
import { suspendToolCall } from '../../dist/core/tools/tool-suspension.js';
import { resolveHostShell } from '../../dist/utils/host-shell.js';

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
        input: {
          command: `${resolveHostShell().kind === 'pwsh' ? '& ' : ''}"${process.execPath}" "${script}"`,
          event: eventMode,
        },
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

  for (const oversizedChunk of [false, true]) {
    const cappedEvents = [];
    const cappedTool = {
      ...tool,
      async execute(_input, ctx) {
        ctx.onToolOutput?.('visible line\n');
        if (oversizedChunk) {
          ctx.onToolOutput?.(known.slice(0, 8));
          ctx.onToolOutput?.(known.slice(8) + 'x'.repeat(300 * 1024));
        } else {
          for (let index = 0; index < 100; index++) ctx.onToolOutput?.('x'.repeat(4095) + '\n');
        }
        ctx.onToolOutput?.('late output after cap\n');
        return 'final receipt remains available';
      },
    };
    const result = await executeOneToolCall(
      { id: 'cap', name: tool.name, input: {} },
      deps(cappedTool, (event) => cappedEvents.push(event))
    );
    assert.equal(result.text, 'final receipt remains available');
    const preview = cappedEvents
      .filter((event) => event.type === 'tool_execution_progress')
      .map((event) => event.chunk)
      .join('');
    assert.ok(Buffer.byteLength(preview) < 257 * 1024, 'live preview must remain bounded');
    assert.equal(preview.split('[Live output limit reached; further output omitted.]').length, 2);
    assert.ok(!preview.includes('late output after cap'));
    if (oversizedChunk)
      assert.equal(
        preview,
        'visible line\n\n[Live output limit reached; further output omitted.]\n'
      );
  }

  const suspendedEvents = [];
  const suspendedTool = {
    ...tool,
    metadata: { canSuspend: true },
    async execute(_input, ctx) {
      savedCallback = ctx.onToolOutput;
      ctx.onToolOutput?.('before suspension\n');
      ctx.onToolOutput?.(known.slice(0, 8));
      suspendToolCall({ continuationId: 'live-wait' });
    },
  };
  const suspended = await executeOneToolCall(
    { id: 'suspend', name: tool.name, input: {} },
    deps(suspendedTool, (event) => suspendedEvents.push(event))
  );
  assert.equal(suspended.suspendedTool?.continuationId, 'live-wait');
  assert.equal(suspended.isError, false);
  savedCallback?.('after suspension\n');
  assert.equal(
    suspendedEvents
      .filter((event) => event.type === 'tool_execution_progress')
      .map((event) => event.chunk)
      .join(''),
    'before suspension\n'
  );

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
    '[tool-live-output] real exec lines, split secrets, bounded previews, safe final tails and cancellation passed'
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}
