import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { CASES, runOracle } from '../scripts/lib/superagent-eval-oracle.mjs';
import { createRecordingRelay } from '../scripts/lib/superagent-eval-relay.mjs';
import { runProcess } from '../dist/utils/run-process.js';
import { runGit } from '../dist/utils/git-spawn.js';

test('control-plane receipt proof rejects missing output and changes outside its scope', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-eval-receipt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await runGit(['init', '-q'], { cwd: root, readOnly: false });
  await fs.writeFile(path.join(root, 'anchor.txt'), 'fixed scaffold\n');
  await runGit(['add', '--', 'anchor.txt'], { cwd: root, readOnly: false });
  await runGit(
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root, readOnly: false }
  );
  const script = fileURLToPath(
    new URL('../scripts/lib/superagent-receipt-oracle.mjs', import.meta.url)
  );
  const check = () =>
    runProcess(process.execPath, { args: [script, '--case', 'telemetry'], cwd: root });
  await assert.rejects(check());
  await fs.writeFile(path.join(root, 'receipt.txt'), 'RECEIVED\n');
  assert.equal(JSON.parse((await check()).stdout).passed, true);
  await fs.writeFile(path.join(root, 'anchor.txt'), 'out of scope\n');
  await assert.rejects(check());
});

test('unimplemented operations scaffold cannot pass any independent module oracle', async () => {
  const fixture = fileURLToPath(
    new URL('../bench/scenarios/superagent-operations', import.meta.url)
  );
  for (const id of CASES) {
    const result = await runOracle(id, fixture);
    assert.equal(result.passed, false, id);
    assert.equal(result.checks.length, 5);
    assert.ok(result.checks.every((check) => check.passed === false));
  }
  await assert.rejects(runOracle('invented-case', fixture), /Unknown oracle case/);
});

test('recording relay preserves streaming bytes, hides credentials and enforces global and per-arm request budgets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-eval-relay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const key = 'unit-private-provider-token';
  let calls = 0;
  const upstream = createServer(async (req, res) => {
    calls++;
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    let raw = '';
    for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    assert.equal(body.messages[0].content, '中文');
    assert.equal(body.max_tokens, 4096);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    const content =
      'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '你好' } }] }) + '\n\n';
    const bytes = Buffer.from(content);
    const split = bytes.indexOf(Buffer.from('你好')) + 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(bytes.subarray(0, split));
    res.write(bytes.subarray(split));
    res.end(
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const log = path.join(root, 'usage.jsonl');
  const relay = await createRecordingRelay({
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    model: 'unit-model',
    key,
    outputFile: log,
    maxRequests: 2,
    groupLimits: { 'baseline:coding': 1 },
    thinking: 'disabled',
  });
  t.after(() => relay.close());
  assert.equal((await fetch(relay.url + '/baseline/v1/models')).status, 401);
  const send = (arm = 'baseline') =>
    fetch(relay.url + `/${arm}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${relay.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'unit-model',
        stream: true,
        max_tokens: 9000,
        messages: [{ role: 'user', content: '中文' }],
      }),
    });
  const response = await send();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /你好/);
  assert.equal((await send()).status, 429);
  const second = await send('superagent');
  assert.equal(second.status, 200);
  await second.text();
  assert.equal((await send('superagent')).status, 429);
  assert.equal(calls, 2);
  assert.equal(relay.records()[0].inputTokens, 12);
  assert.equal(relay.records()[0].outputTokens, 3);
  assert.equal(JSON.stringify(relay.records()).includes(key), false);
  await relay.close();
  assert.equal((await fs.readFile(log, 'utf8')).includes(key), false);
});
