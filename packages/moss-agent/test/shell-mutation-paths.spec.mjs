#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  extractShellMutationPaths,
  toolPathKeys,
  isFileMutationTool,
  invalidateStaleReadToolResults,
} from '../dist/context/stale-read-invalidate.js';

assert.deepEqual(extractShellMutationPaths('npm test'), []);
assert.deepEqual(extractShellMutationPaths('tsc -p tsconfig.json'), []);

const sedPaths = extractShellMutationPaths("sed -i '' 's/foo/bar/' src/a.ts");
assert.ok(
  sedPaths.some((p) => p.includes('src/a.ts')),
  `sed paths: ${sedPaths}`
);

const redir = extractShellMutationPaths('echo hi > out/log.txt');
assert.ok(
  redir.some((p) => p.includes('out/log.txt')),
  `redir: ${redir}`
);

assert.equal(isFileMutationTool('exec'), true);
assert.deepEqual(
  toolPathKeys('exec', { command: "sed -i 's/a/b/' packages/x/foo.ts" }).some((k) =>
    k.includes('packages/x/foo.ts')
  ),
  true
);

// npm test exec must not produce mutation keys
assert.deepEqual(toolPathKeys('exec', { command: 'npm test' }), []);

// invalidate stale reads after sed-like exec
{
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'src/a.ts' } }],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'r1',
          name: 'read_file',
          content: 'const x = 1;\n',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'e1',
          name: 'exec',
          input: { command: "sed -i '' 's/1/2/' src/a.ts" },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'e1',
          name: 'exec',
          content: 'ok',
        },
      ],
    },
  ];
  const inv = invalidateStaleReadToolResults(messages);
  assert.ok(inv.invalidatedCount >= 1, 'sed exec invalidates prior read_file body');
}

console.log('[PASS] shell-mutation-paths');
