#!/usr/bin/env node
/**
 * Real file/tool/agent-loop regression for the tool-loop-guard defaults.
 *
 * No limit is on by default: a wrong patch reaches the tool on every attempt
 * and the valid one applies in the same run. A host that sets the limits gets
 * the edit-thrash lock back. The read-scope lock is on in both modes.
 */
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
const ORIGINAL = 'def main():\n    return 1\n';
const PATCHED = 'def main():\n    return 2\n';

for (const name of ['MOSS_TOOL_LOOP_IDENTICAL_LIMIT', 'MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT']) {
  assert.equal(process.env[name], undefined, `${name} must not be set in the probe environment`);
}

const scriptProvider = (id, calls) => {
  let turn = 0;
  return {
    id,
    displayName: id,
    capabilities: { streaming: false },
    async complete() {
      const call = calls[turn++];
      return call
        ? {
            stopReason: 'tool_use',
            content: [{ type: 'tool_use', id: `${id}-${turn}`, name: call[0], input: call[1] }],
          }
        : {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: 'The tool sequence is finished.' }],
          };
    },
  };
};

const runPatches = async (key, calls) => {
  const agent = new MossAgent({
    llmProvider: scriptProvider(key, calls),
    sessionStore: new InMemorySessionStore(),
    workspaceDir,
    baseSystemPrompt: 'Perform the provided local editing sequence.',
    domainPrompt: false,
  });
  registerBuiltinTools(agent);
  try {
    return (await agent.chat(key, 'Update the local function.', { maxTurns: 12 })).toolResults;
  } finally {
    await agent.close();
  }
};

try {
  // --- Default: every attempt reaches the tool, the valid patch applies ---
  await fs.writeFile(fullPath, ORIGINAL);
  const wrong = patch('    return 101');
  const results = await runPatches('edit-defaults', [
    ['read_file', { path: file }],
    ...Array.from({ length: 4 }, () => ['apply_patch', wrong]),
    ['apply_patch', correct],
    ['read_file', { path: fullPath }],
  ]);
  assert.equal(results.length, 7);
  for (const result of results.slice(1, 5)) {
    assert.equal(result.isError, true, 'a wrong patch fails in the tool');
    assert.doesNotMatch(
      result.content,
      /loop guard|edit thrash|identical input/,
      'the failure is the tool result, not a guard stop'
    );
  }
  assert.equal(
    results[5].isError,
    false,
    'the valid patch applies on the fifth attempt at the path'
  );
  assert.equal(results[6].isError, false);
  assert.equal(await fs.readFile(fullPath, 'utf8'), PATCHED);
  console.log('[edit-recovery] ok default: 4 wrong patches reach the tool, the 5th applies');

  // --- Default: the read-scope lock still stops a shell write around it ---
  {
    const state = createToolLoopGuardState({ workspaceDir });
    recordToolLoopOutcome(
      state,
      'edit_file',
      true,
      `You only read a partial window of ${file}. Read the whole file, then edit again.`,
      { path: file, old_string: 'a', new_string: 'b' }
    );
    assert.match(
      shouldShortCircuitToolCall(state, 'exec', { command: `echo x > ${file}` }) ?? '',
      /^shell write to edit-locked file /,
      'a shell write to a read-scope-locked path is stopped by default'
    );
    recordToolLoopOutcome(state, 'read_file', false, 'full current content', { path: file });
    assert.equal(
      shouldShortCircuitToolCall(state, 'exec', { command: `echo x > ${file}` }),
      null,
      'a complete read releases the lock'
    );
  }
  console.log(
    '[edit-recovery] ok default: read-scope lock stops the shell detour until a full read'
  );

  process.env.MOSS_TOOL_LOOP_IDENTICAL_LIMIT = '3';
  process.env.MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT = '3';
  try {
    // --- Opt-in: the edit-thrash lock, unlocked by a complete read ---
    await fs.writeFile(fullPath, ORIGINAL);
    const locked = await runPatches('edit-recovery', [
      ['read_file', { path: file }],
      ...[101, 102, 103].map((n) => ['apply_patch', patch(`    return ${n}`)]),
      ['apply_patch', correct],
      ['read_file', { path: fullPath }],
      ['apply_patch', correct],
    ]);
    assert.equal(locked.length, 7);
    assert.ok(locked.slice(1, 4).every((r) => r.isError));
    assert.match(locked[4].content, /edit thrash on .*3 failed surgical edit/);
    assert.equal(locked[5].isError, false, 'absolute-path full re-read must execute');
    assert.equal(locked[6].isError, false, 'valid patch must recover in the same agent run');
    assert.equal(await fs.readFile(fullPath, 'utf8'), PATCHED);
    console.log(
      '[edit-recovery] ok opt-in: 3 failures -> blocked patch -> full read -> same patch applied'
    );

    // --- Opt-in: host-declared aliases go through the same guard ---
    await fs.writeFile(fullPath, ORIGINAL);
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
    const aliasAgent = new MossAgent({
      llmProvider: scriptProvider('offline-host-alias', aliasCalls),
      sessionStore: new InMemorySessionStore(),
      workspaceDir,
      domainPrompt: false,
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
      const aliased = await aliasAgent.chat('host-alias-recovery', 'Update the local file.', {
        maxTurns: 12,
      });
      assert.match(aliased.toolResults[4].content, /edit thrash/);
      assert.equal(aliased.toolResults[6].isError, false, aliased.toolResults[6].content);
      assert.equal(await fs.readFile(fullPath, 'utf8'), PATCHED);
      console.log(
        '[edit-recovery] ok host-declared aliases and file_path recover through normal tool registration'
      );
    } finally {
      await aliasAgent.close();
    }

    // --- Opt-in: only a complete read unlocks ---
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
      '[edit-recovery] ok opt-in: partial/failed/unrelated/truncated reads stay locked; full read recovers; protection re-arms'
    );
  } finally {
    delete process.env.MOSS_TOOL_LOOP_IDENTICAL_LIMIT;
    delete process.env.MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT;
  }
} finally {
  await fs.rm(workspaceDir, { recursive: true, force: true });
}
