import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../dist/utils/run-process.js';
import { isolatedCliEnv } from './helpers/isolated-cli-env.mjs';
import { createMossSuperagent } from '../dist/index.js';
import { NativeMossWorker } from '../dist/core/superagent/worker.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const accept =
  "node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('answer.txt','utf8')==='42'?0:1)\"";
async function project(t) {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'moss native superagent '))
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await runProcess('git', { cwd: dir, args: ['init', '-q'] });
  await fs.writeFile(path.join(dir, 'answer.txt'), '0');
  await runProcess('git', { cwd: dir, args: ['add', 'answer.txt'] });
  await runProcess('git', {
    cwd: dir,
    args: [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'baseline',
    ],
  });
  return dir;
}
async function model(t) {
  const seen = [];
  const hooks = {};
  const server = createServer(async (req, res) => {
    if (req.url.endsWith('/models')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 32768 }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    seen.push(body);
    await hooks.onRequest?.(body);
    const calls = (body.messages ?? []).flatMap((m) => m.tool_calls ?? []);
    let message = {
      role: 'assistant',
      content:
        'The requested change is complete. The external command remains the only acceptance authority.',
    };
    const names = (body.tools ?? []).map((tool) => tool.function?.name);
    if (names.includes('read_file') && !calls.some((c) => c.function?.name === 'read_file'))
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'read-answer',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'answer.txt' }) },
          },
        ],
      };
    else if (names.includes('write_file') && !calls.some((c) => c.function?.name === 'write_file'))
      message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'write-answer',
            type: 'function',
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'answer.txt', content: '42' }),
            },
          },
        ],
      };
    const finish = message.tool_calls ? 'tool_calls' : 'stop';
    if (body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      const delta = message.tool_calls
        ? {
            role: 'assistant',
            tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })),
          }
        : { role: 'assistant', content: message.content };
      res.write(
        `data: ${JSON.stringify({ id: 'offline', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      );
      res.write(
        `data: ${JSON.stringify({ id: 'offline', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 200, completion_tokens: 30 } })}\n\n`
      );
      res.end('data: [DONE]\n\n');
    } else {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'offline',
          model: 'fixture-model',
          choices: [{ index: 0, message, finish_reason: finish }],
          usage: { prompt_tokens: 200, completion_tokens: 30 },
        })
      );
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { seen, hooks, url: `http://127.0.0.1:${server.address().port}/v1` };
}

async function cliFixture(t, allowWrite = true) {
  const dir = await project(t);
  const fixture = await model(t);
  const env = isolatedCliEnv({
    overrides: {
      MOSS_PROVIDER: 'openai-compatible',
      MOSS_MODEL: 'fixture-model',
      MOSS_BASE_URL: fixture.url,
      MOSS_API_KEY: 'offline-fixture-key',
      MOSS_CONTEXT_TOKENS: '32768',
      MOSS_LANG: 'en',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
  });
  env.FIXTURE_MODEL_KEY = 'offline-fixture-key';
  await fs.mkdir(env.MOSS_CONFIG_DIR, { recursive: true });
  await fs.writeFile(
    path.join(env.MOSS_CONFIG_DIR, 'config.json'),
    JSON.stringify({
      provider: 'openai-compatible',
      model: 'fixture-model',
      baseUrl: fixture.url,
      apiKeyEnv: 'FIXTURE_MODEL_KEY',
      permissions: { defaultMode: 'manual', ...(allowWrite ? { allow: ['write_file'] } : {}) },
    })
  );
  const run = (...args) =>
    runProcess(process.execPath, {
      args: [
        cli,
        'superagent',
        ...args,
        '-C',
        dir,
        '--provider',
        'openai-compatible',
        '--model',
        'fixture-model',
        '--base-url',
        fixture.url,
      ],
      cwd: dir,
      env,
      timeout: 75_000,
      maxBuffer: 1024 * 1024,
    });
  return { run, dir, fixture, env };
}

test(
  'CLI uses an actual isolated Moss worker, native tools, native Task Runtime and an independent oracle',
  { timeout: 90_000 },
  async (t) => {
    const { run, dir, fixture, env } = await cliFixture(t);
    const before = await run('status');
    assert.equal(JSON.parse(before.stdout).initialized, false);
    await assert.rejects(fs.stat(path.join(dir, '.moss', 'superagent', 'state.sqlite')));
    await run('init', '--accept', accept);
    await run('submit', 'Write 42 to answer.txt', '--id', 'native-one');
    fixture.hooks.onRequest = async () => {
      if (fixture.seen.length !== 1) return;
      await run(
        'submit',
        'Keep answer 42 within the original scope',
        '--id',
        'followup',
        '--thread',
        'native-one'
      );
      const duplicate = JSON.parse(
        (
          await run(
            'submit',
            'Keep answer 42 within the original scope',
            '--id',
            'followup',
            '--thread',
            'native-one'
          )
        ).stdout
      );
      assert.equal(duplicate.duplicate, true);
    };
    const worked = await run('work');
    assert.equal(worked.exitCode, 0, worked.stderr + worked.stdout);
    const status = JSON.parse((await run('status')).stdout);
    const [ticket] = status.tickets;
    assert.equal(ticket.state, 'completed', JSON.stringify(status));
    assert.ok(ticket.taskId);
    assert.ok(ticket.workspace !== dir);
    assert.equal(await fs.readFile(path.join(dir, 'answer.txt'), 'utf8'), '0');
    assert.equal(await fs.readFile(path.join(ticket.workspace, 'answer.txt'), 'utf8'), '42');
    assert.ok(
      fixture.seen.some((body) =>
        (body.messages ?? []).some((message) =>
          message.tool_calls?.some((call) => call.function?.name === 'write_file')
        )
      )
    );
    const events = await fs.readFile(
      path.join(ticket.workspace, '.moss', 'task-events.jsonl'),
      'utf8'
    );
    assert.match(events, /acceptance_pass/);
    assert.ok(
      fixture.seen.some((body) =>
        JSON.stringify(body.messages).includes('Keep answer 42 within the original scope')
      )
    );
    const replay = JSON.parse(
      (await run('submit', 'Write 42 to answer.txt', '--id', 'native-one')).stdout
    );
    assert.equal(replay.duplicate, true);
    const requests = fixture.seen.length;
    await run('work');
    assert.equal(fixture.seen.length, requests);
    await run('submit', 'Write 42 to answer.txt', '--id', 'second-round', '--thread', 'native-one');
    await run('work');
    const [resumed] = JSON.parse((await run('status')).stdout).tickets;
    assert.equal(resumed.state, 'completed');
    assert.equal(resumed.workspace, ticket.workspace);
    assert.equal(resumed.sessionKey, ticket.sessionKey);
    assert.notEqual(resumed.taskId, ticket.taskId);
    const callsBeforeRecovery = fixture.seen.length;
    // Simulate a controller losing the task-ID acknowledgement for a newer native round.
    const worker = new NativeMossWorker({ env });
    await assert.rejects(
      worker.run(
        {
          ticketId: ticket.id,
          assignmentId: 'lost-task-ack',
          workspaceDir: ticket.workspace,
          sessionKey: ticket.sessionKey,
          scope: ticket.scope,
          acceptanceCommand: accept,
          taskId: ticket.taskId,
          inputs: [],
        },
        new AbortController().signal,
        () => {}
      )
    );
    assert.equal(fixture.seen.length, callsBeforeRecovery);
  }
);

test(
  'native worker inherits operator deny rules and never upgrades manual approvals',
  { timeout: 90_000 },
  async (t) => {
    const { run, dir } = await cliFixture(t, false);
    await run('init', '--accept', accept);
    await run('submit', 'Write 42 to answer.txt');
    const failure = await run('work').catch((error) => error);
    assert.equal(failure.exitCode, 9);
    const [ticket] = JSON.parse((await run('status')).stdout).tickets;
    assert.equal(ticket.state, 'blocked');
    assert.equal(await fs.readFile(path.join(ticket.workspace, 'answer.txt'), 'utf8'), '0');
    assert.equal(await fs.readFile(path.join(dir, 'answer.txt'), 'utf8'), '0');
    const sessions = await fs.readdir(path.join(ticket.workspace, '.moss', 'sessions'));
    const text = (
      await Promise.all(
        sessions
          .filter((file) => file.endsWith('.jsonl'))
          .map((file) =>
            fs.readFile(path.join(ticket.workspace, '.moss', 'sessions', file), 'utf8')
          )
      )
    ).join('');
    assert.match(text, /requires approval/);
    assert.ok(
      !(await fs.readdir(path.join(dir, '.moss', 'superagent'))).some((file) =>
        file.startsWith('worker-policy-')
      )
    );
  }
);

test(
  'help/status need no credentials and invalid command arguments fail without initializing state',
  { timeout: 60_000 },
  async (t) => {
    const dir = await project(t);
    const env = isolatedCliEnv();
    const run = (...args) =>
      runProcess(process.execPath, {
        args: [cli, 'superagent', ...args, '-C', dir],
        cwd: dir,
        env,
        timeout: 10_000,
      });
    assert.match((await run('--help')).stdout, /superagent/);
    assert.equal(JSON.parse((await run('status')).stdout).initialized, false);
    for (const args of [
      ['unknown'],
      ['status', '--accept', 'true'],
      ['pause', 'extra'],
      ['init', '--workers', '0', '--accept', 'true'],
      ['stop'],
      ['submit'],
      ['submit', 'Cannot run before initialization'],
    ])
      await assert.rejects(run(...args), (error) => error.exitCode !== 0);
    await assert.rejects(fs.stat(path.join(dir, '.moss', 'superagent', 'state.sqlite')), {
      code: 'ENOENT',
    });
  }
);

test(
  'stop cooperatively cancels one real native process while another native worker completes',
  { timeout: 60_000 },
  async (t) => {
    const { dir, env, fixture } = await cliFixture(t);
    let notify;
    let release;
    const started = new Promise((resolve) => {
      notify = resolve;
    });
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    fixture.hooks.onRequest = async (body) => {
      if (JSON.stringify(body.messages).includes('Wait for cancellation')) {
        notify();
        await hold;
      }
    };
    const runtime = await createMossSuperagent({
      workspaceDir: dir,
      workerEnv: env,
      config: {
        acceptanceCommand: accept,
        allowedActors: { local: ['operator'] },
        acceptMode: 'observe',
        rules: [],
        maxWorkers: 2,
        maxWallMs: 30_000,
      },
    });
    for (const [id, text] of [
      ['slow', 'Wait for cancellation'],
      ['fast', 'Write 42 to answer.txt'],
    ])
      runtime.receive({
        id,
        text,
        source: 'local',
        actor: 'operator',
        thread: id,
        human: true,
        addressed: true,
      });
    const controller = new AbortController();
    const work = runtime.work({ signal: controller.signal });
    try {
      await started;
      const control = await createMossSuperagent({ workspaceDir: dir });
      const slow = control.tickets().find((ticket) => ticket.scope === 'Wait for cancellation');
      control.stop(slow.id);
      await control.close();
      await work;
      const tickets = runtime.tickets();
      assert.equal(tickets.find((ticket) => ticket.id === slow.id).state, 'stopped');
      const fast = tickets.find((ticket) => ticket.scope !== 'Wait for cancellation');
      assert.equal(fast.state, 'completed');
      assert.notEqual(slow.workspace, fast.workspace);
      assert.equal(await fs.readFile(path.join(dir, 'answer.txt'), 'utf8'), '0');
    } finally {
      release();
      controller.abort();
      await work;
      await runtime.close();
    }
  }
);
