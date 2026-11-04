/**
 * Oversized exec output keeps a recovery path: the tool drops the middle to
 * protect the context window, and the full text lands in `.moss/runtime/` so
 * the omitted region can be read back (Cursor `file_output_threshold_bytes`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execTool } from '../dist/tools/builtin.js';
import { SPILL_MAX_BYTES } from '../dist/tools/tool-output-spill.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'spill', abortSignal: new AbortController().signal };
}

test('truncated exec output spills the full text and names the file', async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-spill-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  // The runtime gitignore is only written inside a git work tree; a HEAD file
  // is enough for that check, so this needs no git binary.
  fs.mkdirSync(path.join(workspaceDir, '.git'));
  fs.writeFileSync(path.join(workspaceDir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const script = path.join(workspaceDir, 'emit.cjs');
  fs.writeFileSync(
    script,
    'const pad = (n, c) => c.repeat(n);\n' +
      "process.stdout.write(pad(30000, 'a') + 'MIDDLE-ONE' + pad(30000, 'b') + 'MIDDLE-TWO' + pad(30000, 'c'));\n"
  );

  const text = await execTool.execute(
    { command: `"${process.execPath}" "${script}"` },
    ctx(workspaceDir)
  );
  const match = text.match(/full output: (\S+\.txt)/);
  assert.ok(match, `the result names the spill file: ${text.slice(-300)}`);
  assert.match(text, /chars omitted/);
  assert.match(text, /read the omitted region/);

  const spilled = fs.readFileSync(path.join(workspaceDir, match[1]), 'utf8');
  assert.ok(spilled.length > 90_000, `spill holds the full output (${spilled.length} chars)`);
  assert.match(spilled, /MIDDLE-ONE/);
  assert.match(spilled, /MIDDLE-TWO/);
  assert.ok(
    !text.includes('MIDDLE-TWO') || text.length < spilled.length,
    'the result is shortened'
  );

  const ignore = fs.readFileSync(path.join(workspaceDir, '.moss', '.gitignore'), 'utf8');
  assert.match(ignore, /^runtime\/$/m, 'runtime artifacts stay out of git');
});

test('small output writes nothing', async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-spill-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const text = await execTool.execute(
    { command: `"${process.execPath}" -e "console.log('short')"` },
    ctx(workspaceDir)
  );
  assert.match(text, /short/);
  assert.doesNotMatch(text, /full output:/);
  assert.equal(
    fs.existsSync(path.join(workspaceDir, '.moss', 'runtime', 'tool-output')),
    false,
    'no spill directory for a small result'
  );
});

test('a spill larger than the cap is skipped instead of written', async (t) => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-spill-'));
  t.after(() => fs.rmSync(workspaceDir, { recursive: true, force: true }));
  const { spillToolOutput } = await import('../dist/tools/tool-output-spill.js');
  const tooBig = 'x'.repeat(SPILL_MAX_BYTES + 1);
  assert.equal(spillToolOutput({ workspaceDir, toolName: 'exec', text: tooBig }), null);
  assert.equal(
    fs.existsSync(path.join(workspaceDir, '.moss', 'runtime', 'tool-output')),
    false,
    'nothing is written past the cap'
  );
});
