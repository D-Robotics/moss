import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execTool } from '../dist/tools/builtin.js';

function ctx(workspaceDir, onToolOutput) {
  return {
    workspaceDir,
    sessionKey: 'exec-events',
    abortSignal: new AbortController().signal,
    ...(onToolOutput ? { onToolOutput } : {}),
  };
}

const EMITTER = [
  "const lines = ['alpha', 'beta', 'gamma'];",
  'let i = 0;',
  'const tick = () => {',
  '  if (i >= lines.length) {',
  "    console.error('boom');",
  '    return;',
  '  }',
  '  console.log(lines[i]);',
  '  i += 1;',
  '  setTimeout(tick, 140);',
  '};',
  'tick();',
  '',
].join('\n');

test('exec event mode emits one live event per stdout line, in order', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-events-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'emit.mjs');
  await fs.writeFile(script, EMITTER);

  const streamed = [];
  const text = await execTool.execute(
    { command: `"${process.execPath}" "${script}"`, event: true, timeout_ms: 20_000 },
    ctx(dir, (chunk) => streamed.push({ chunk, at: Date.now() }))
  );
  const finishedAt = Date.now();

  const live = streamed.map((s) => s.chunk);
  assert.deepEqual(live, [
    '[event 1] alpha\n',
    '[event 2] beta\n',
    '[event 3] gamma\n',
    '[event 4] (stderr) boom\n',
  ]);
  // The emitter sleeps 140ms between lines. Gaps between deliveries prove the
  // events were pushed as each line completed, not flushed once at exit.
  for (let i = 1; i < 3; i += 1) {
    assert.ok(
      streamed[i].at - streamed[i - 1].at >= 100,
      `event ${i + 1} arrived ${streamed[i].at - streamed[i - 1].at}ms after event ${i}`
    );
  }
  assert.ok(finishedAt - streamed[0].at >= 250, 'the first event arrived while the command ran');

  assert.match(text, /events: 4/);
  const order = ['[1] alpha', '[2] beta', '[3] gamma', '[4] (stderr) boom'].map((needle) =>
    text.indexOf(needle)
  );
  assert.ok(
    order.every((at, i) => at !== -1 && (i === 0 || at > order[i - 1])),
    `events appear one per line in order, got:\n${text}`
  );
});

test('exec event mode still returns numbered events with no live listener', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-events-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'emit.mjs');
  await fs.writeFile(script, EMITTER);

  const text = await execTool.execute(
    { command: `"${process.execPath}" "${script}"`, event: true, timeout_ms: 20_000 },
    ctx(dir)
  );
  assert.match(text, /events: 4\n\[1\] alpha\n\[2\] beta\n\[3\] gamma\n\[4\] \(stderr\) boom/);
});

test('exec without event keeps the buffered single-blob result', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exec-events-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'emit.mjs');
  await fs.writeFile(script, EMITTER);

  const streamed = [];
  const text = await execTool.execute(
    { command: `"${process.execPath}" "${script}"`, timeout_ms: 20_000 },
    ctx(dir, (chunk) => streamed.push(chunk))
  );
  assert.doesNotMatch(text, /events: \d/);
  assert.doesNotMatch(text, /^\[1\] /m);
  assert.match(text, /alpha\nbeta\ngamma/);
  assert.ok(streamed.length > 0, 'plain mode still streams raw chunks to the host');
});
