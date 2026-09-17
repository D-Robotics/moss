#!/usr/bin/env node
import assert from 'node:assert/strict';
import { evaluateSnapshotToolsNudge } from '../dist/core/loop/snapshot-tools-nudge.js';

// No tools yet
{
  const r = evaluateSnapshotToolsNudge({
    userText: 'please update the snapshots with vitest -u',
    toolCallsByName: {},
    totalToolCalls: 0,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Snapshot ask + tools without -u → fire
{
  const r = evaluateSnapshotToolsNudge({
    userText: 'please update the snapshots with vitest -u',
    toolCallsByName: { read_file: 1 },
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, true);
  assert.match(r.correction, /snapshot|vitest -u|jest -u/i);
}

// Snapshot exec present
{
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 's1',
          name: 'exec',
          input: { command: 'npx vitest -u' },
        },
      ],
    },
  ];
  const r = evaluateSnapshotToolsNudge({
    userText: 'update snapshots',
    toolCallsByName: { exec: 1 },
    messages,
    totalToolCalls: 1,
    attempts: 0,
  });
  assert.equal(r.fire, false);
}

// Once only
{
  const r = evaluateSnapshotToolsNudge({
    userText: '更新快照',
    toolCallsByName: { list_directory: 1 },
    totalToolCalls: 1,
    attempts: 1,
  });
  assert.equal(r.fire, false);
}

console.log('[PASS] snapshot-tools-nudge');
