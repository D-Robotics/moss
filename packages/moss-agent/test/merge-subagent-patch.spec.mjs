#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { builtinTools } from '../dist/tools/builtin.js';

const tool = builtinTools.find(({ name }) => name === 'merge_subagent_patch');

test('merge_subagent_patch is approval-gated and delegates only opaque stored artifact IDs', async () => {
  assert.ok(tool);
  assert.equal(tool.metadata.sideEffectClass, 'local_write');
  assert.equal(tool.metadata.requiresApproval, true);
  const calls = [];
  const output = await tool.execute(
    { leaseId: 'lease-1', patchId: 'patch-1' },
    {
      workspaceDir: '/workspace',
      mergeWorkspacePatch: async (leaseId, patchId) => {
        calls.push({ leaseId, patchId });
        return { status: 'merged', conflictingPaths: [], changedPaths: ['src/a.ts'] };
      },
    }
  );
  assert.deepEqual(calls, [{ leaseId: 'lease-1', patchId: 'patch-1' }]);
  assert.match(output, /Merged sub-agent patch patch-1/);
});

test('merge_subagent_patch fails closed when the host does not expose merge authority', async () => {
  const output = await tool.execute(
    { leaseId: 'lease-1', patchId: 'patch-1' },
    { workspaceDir: '/workspace' }
  );
  assert.match(output, /unavailable/);
});
