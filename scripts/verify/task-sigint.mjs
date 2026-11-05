#!/usr/bin/env node
/**
 * Headless Ctrl+C probe (offline, B121).
 *
 * A long `moss task run` is a turn loop; before this change SIGINT killed the
 * process outright — no `task_failed{detail:"aborted"}`, no pause hint, no exit
 * code a script can distinguish from a failure. Now the first Ctrl+C aborts the
 * in-flight turn, records the pause, prints `/goal resume` + the headless resume
 * command, and exits 130; the second Ctrl+C still hard-exits.
 *
 * The provider is a local HTTP server that never answers, so this is a real
 * end-to-end signal test with no model call and no network.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { taskOutcomeExitCode } = await load('dist/cli/task-run.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[task-sigint] ok ${name}`);
};

// 1. Exit-code contract: 0 pass, 130 interrupted, 1 everything else.
{
  assert.equal(taskOutcomeExitCode('pass'), 0);
  assert.equal(taskOutcomeExitCode('aborted'), 130);
  assert.equal(taskOutcomeExitCode('fail'), 1);
  assert.equal(taskOutcomeExitCode('blocked'), 1);
  ok('outcome -> exit code (interrupted is 130, not 1)');
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-sigint-'));
const workspace = path.join(tmp, 'ws');
const configDir = path.join(tmp, 'config');
await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
await fs.writeFile(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
await fs.mkdir(configDir, { recursive: true });

// A provider that answers the startup reachability probe, then never answers:
// the first task turn hangs inside the provider, exactly like a slow model.
// (Hanging the probe too would hide the planning turn behind the probe timeout.)
let requests = 0;
const sockets = new Set();
const server = http.createServer((req, res) => {
  requests += 1;
  req.resume();
  if (requests === 1) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [] }));
    return;
  }
  // Every later request (the task turn) hangs; the probe aborts it.
  res.on('close', () => {});
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();
const port = server.address().port;
await fs.writeFile(
  path.join(configDir, 'config.json'),
  JSON.stringify({
    provider: 'openai-compatible',
    model: 'slow-test-model',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-key',
    permissions: { defaultMode: 'full' },
  }),
  'utf8'
);

const child = spawn(
  process.execPath,
  [
    path.join(root, 'dist/cli.js'),
    'task',
    'run',
    'Slow goal that never finishes.',
    '--accept',
    'test -f never.txt',
  ],
  {
    cwd: workspace,
    env: {
      ...process.env,
      MOSS_CONFIG_DIR: configDir,
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_TUI: '1',
      MOSS_LANG: 'en',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const waitFor = async (predicate, timeoutMs, label) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `timed out waiting for ${label}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
  );
};

const exitPromise = new Promise((resolve) => {
  child.on('exit', (code, signal) => resolve({ code, signal }));
});

// 2. Ctrl+C while a turn is in flight pauses the task instead of killing it.
{
  // Startup issues its own provider probe; the task turn starts after that.
  // Wait until the engine says it is planning, so the cancel handler owns the
  // signal and a real turn is in flight.
  await waitFor(() => /(Planning|Working out the steps)/.test(stderr), 30_000, 'the planning turn');
  const abortedAt = Date.now();
  child.kill('SIGINT');
  let exitTimer;
  const { code, signal } = await Promise.race([
    exitPromise,
    new Promise((resolve) => {
      exitTimer = setTimeout(() => resolve({ code: 'timeout', signal: 'timeout' }), 20_000);
    }),
  ]);
  clearTimeout(exitTimer);
  if (code === 'timeout') child.kill('SIGKILL');
  assert.notEqual(code, 'timeout', `process did not exit after SIGINT\n${stderr}`);
  assert.equal(signal, null, 'a handled SIGINT is an exit code, not a signal death');
  assert.equal(
    code,
    130,
    `exit code after Ctrl+C\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
  );
  assert.ok(Date.now() - abortedAt < 15_000, 'abort settles promptly');
  assert.match(stdout, /ABORTED/, stdout);
  assert.match(stdout, /^\/goal resume$/m, stdout);
  assert.match(stdout, /next: moss task resume task_/, stdout);
  ok('Ctrl+C exits 130 and prints the pause/resume hint');
}

// 3. The pause is durable: phase failed with detail aborted, and resumable.
{
  const status = spawnSyncCli(['task', 'status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.phase, 'failed', JSON.stringify(snapshot));
  assert.equal(snapshot.engineFailure, 'aborted', JSON.stringify(snapshot));
  assert.equal(snapshot.resumable, true, JSON.stringify(snapshot));
  ok('the interrupted task is recorded as an aborted, resumable pause');
}

// 4. The run ledger records the pause too, so `task list` is not blank.
{
  const list = spawnSyncCli(['task', 'list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  const rows = JSON.parse(list.stdout);
  const row = rows.find((candidate) => candidate.outcome === 'aborted');
  assert.ok(row, `no aborted row in the ledger:\n${list.stdout}`);
  ok('`task list --json` shows the interrupted run');
}

function spawnSyncCli(args) {
  return spawnSync(process.execPath, [path.join(root, 'dist/cli.js'), ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      MOSS_CONFIG_DIR: configDir,
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_TUI: '1',
      MOSS_LANG: 'en',
    },
    encoding: 'utf8',
  });
}

for (const socket of sockets) socket.destroy();
child.stdout.destroy();
child.stderr.destroy();
server.closeAllConnections?.();
await new Promise((resolve) => server.close(resolve));
await fs.rm(tmp, { recursive: true, force: true });
console.log(`[task-sigint] ${checks}/${checks} checks passed`);
