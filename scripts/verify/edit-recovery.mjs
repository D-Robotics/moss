#!/usr/bin/env node
/** Real file/tool/agent-loop regression for recovery after repeated failed edits. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (file) => import(pathToFileURL(path.join(root, 'dist', file)).href);
const { MossAgent } = await load('core/agent/moss-agent.js');
const { InMemorySessionStore } = await load('core/session/session.js');
const { registerBuiltinTools } = await load('tools/builtin.js');
const { readFileTool, editFileTool } = await load('tools/file-tools.js');
const { createToolLoopGuardState, recordToolLoopOutcome, shouldShortCircuitToolCall } = await load(
  'core/tools/tool-loop-guard.js'
);
const { FILE_UNCHANGED_TRUNCATED_STUB } = await load('contracts/file-read-observation.js');
const workspaceDir = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), 'moss-edit-recovery-'))
);
const file = 'isp_node.py';
const fullPath = path.join(workspaceDir, file);
const patch = (line) => ({
  patch: `*** Begin Patch\n*** Update File: ${file}\n@@\n def main():\n-${line}\n+    return 2\n*** End Patch`,
});
const correct = patch('    return 1');

try {
  await fs.writeFile(fullPath, 'def main():\n    return 1\n');
  const calls = [
    ['read_file', { path: file }],
    ...[101, 102, 103].map((n) => ['apply_patch', patch(`    return ${n}`)]),
    ['apply_patch', correct],
    ['read_file', { path: fullPath }],
    ['apply_patch', correct],
  ];
  let turn = 0;
  const agent = new MossAgent({
    llmProvider: {
      id: 'offline-edit-recovery',
      displayName: 'Offline edit recovery',
      capabilities: { streaming: false },
      async complete() {
        const call = calls[turn++];
        return call
          ? {
              stopReason: 'tool_use',
              content: [{ type: 'tool_use', id: `edit-${turn}`, name: call[0], input: call[1] }],
            }
          : {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: 'The tool sequence is finished.' }],
            };
      },
    },
    sessionStore: new InMemorySessionStore(),
    workspaceDir,
    baseSystemPrompt: 'Perform the provided local editing sequence.',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  registerBuiltinTools(agent);
  try {
    const result = await agent.chat('edit-recovery', 'Update the local function.', {
      maxTurns: 12,
    });
    const results = result.toolResults;
    assert.equal(results.length, calls.length);
    assert.ok(results.slice(1, 4).every((r) => r.isError));
    assert.match(results[4].content, /edit thrash on .*3 failed surgical edit/);
    assert.equal(results[5].isError, false, 'absolute-path full re-read must execute');
    assert.equal(results[6].isError, false, 'valid patch must recover in the same agent run');
    assert.equal(await fs.readFile(fullPath, 'utf8'), 'def main():\n    return 2\n');
    console.log(
      '[edit-recovery] ok real agent: 3 failures -> blocked patch -> full read -> same patch applied'
    );
  } finally {
    await agent.close();
  }

  await fs.writeFile(fullPath, 'def main():\n    return 1\n');
  const aliasCalls = [
    ['host_read', { file_path: file }],
    ...[101, 102, 103, 1].map((n) => [
      'host_edit',
      {
        file_path: file,
        old_string: `    return ${n}`,
        new_string: '    return 2',
      },
    ]),
    ['host_read', { file_path: fullPath }],
    ['host_edit', { file_path: file, old_string: '    return 1', new_string: '    return 2' }],
  ];
  let aliasTurn = 0;
  const aliasAgent = new MossAgent({
    llmProvider: {
      id: 'offline-host-alias',
      displayName: 'Offline host alias',
      capabilities: { streaming: false },
      async complete() {
        const call = aliasCalls[aliasTurn++];
        return call
          ? {
              stopReason: 'tool_use',
              content: [
                { type: 'tool_use', id: `alias-${aliasTurn}`, name: call[0], input: call[1] },
              ],
            }
          : {
              stopReason: 'end_turn',
              content: [{ type: 'text', text: 'Alias sequence finished.' }],
            };
      },
    },
    sessionStore: new InMemorySessionStore(),
    workspaceDir,
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  const aliasSchema = {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path'],
  };
  aliasAgent.tools.register({
    ...readFileTool,
    name: 'host_read',
    inputSchema: aliasSchema,
    metadata: {
      ...readFileTool.metadata,
      classification: { ...readFileTool.metadata.classification, fileRead: true },
    },
    execute: (input, ctx) => readFileTool.execute({ path: input.file_path }, ctx),
  });
  aliasAgent.tools.register({
    ...editFileTool,
    name: 'host_edit',
    inputSchema: aliasSchema,
    execute: (input, ctx) => editFileTool.execute({ ...input, path: input.file_path }, ctx),
  });
  try {
    const result = await aliasAgent.chat('host-alias-recovery', 'Update the local file.', {
      maxTurns: 12,
    });
    assert.match(result.toolResults[4].content, /edit thrash/);
    assert.equal(result.toolResults[6].isError, false, result.toolResults[6].content);
    assert.equal(await fs.readFile(fullPath, 'utf8'), 'def main():\n    return 2\n');
    console.log(
      '[edit-recovery] ok host-declared aliases and file_path recover through normal tool registration'
    );
  } finally {
    await aliasAgent.close();
  }

  const state = createToolLoopGuardState({ workspaceDir });
  const fail = () => {
    for (let i = 0; i < 3; i++)
      recordToolLoopOutcome(state, 'apply_patch', true, 'Patch rejected', correct);
  };
  const blocked = () => shouldShortCircuitToolCall(state, 'apply_patch', correct);
  fail();
  for (const [input, isError, text, outputTruncated] of [
    [{ path: file, offset: 1, limit: 1 }, false, '1\tdef main():', false],
    [{ path: file }, true, 'Error: read failed', false],
    [{ path: 'other.py' }, false, 'unrelated file', false],
    [{ path: file }, false, FILE_UNCHANGED_TRUNCATED_STUB, false],
    [{ path: file }, false, '1\tdef main():\n\n[... truncated, total 200000 chars]', false],
    [{ path: file }, false, 'full raw text', true],
  ]) {
    recordToolLoopOutcome(state, 'read_file', isError, text, input, process.platform, {
      outputTruncated,
    });
    assert.match(
      blocked(),
      /^edit thrash/,
      'partial, failed, unrelated or truncated reads must not unlock edits'
    );
  }
  recordToolLoopOutcome(state, 'read_file', false, 'full current content', { path: fullPath });
  assert.equal(blocked(), null, 'a complete read unlocks matching relative-path edits');
  fail();
  assert.match(blocked(), /^edit thrash/, 'new failed edits must re-arm the protection');
  console.log(
    '[edit-recovery] ok partial/failed/unrelated/truncated reads stay locked; full read recovers; protection re-arms'
  );
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
