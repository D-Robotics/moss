import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createMossSuperagent,
  MossAgent,
  JsonlSessionStore,
  createAgentTurnRunner,
  runTask,
} from '../dist/index.js';
import { runProcess } from '../dist/utils/run-process.js';
import { getTaskStateSnapshot } from '../dist/core/task/task-store.js';

const acceptance =
  "node -e \"const fs=require('node:fs');process.exit(fs.readFileSync('answer.txt','utf8')==='42'?0:1)\"";
const config = {
  acceptanceCommand: acceptance,
  allowedActors: { local: ['operator'] },
  acceptMode: 'observe',
  rules: [],
  maxWorkers: 1,
  maxWallMs: 30_000,
};
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'moss superagent ')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await runProcess('git', { args: ['init', '-q'], cwd: dir });
  await fs.writeFile(path.join(dir, 'answer.txt'), '0');
  await runProcess('git', { args: ['add', 'answer.txt'], cwd: dir });
  await runProcess('git', {
    args: [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'baseline',
    ],
    cwd: dir,
  });
  return dir;
}
function request(id = 'one', overrides = {}) {
  return {
    id,
    source: 'local',
    actor: 'operator',
    thread: id,
    text: 'Write 42 to answer.txt',
    human: true,
    addressed: true,
    ...overrides,
  };
}
function sdkWorker(counter = { runs: 0 }) {
  return {
    async run(job, signal, onTask) {
      counter.runs++;
      let calls = 0;
      const agent = new MossAgent({
        workspaceDir: job.workspaceDir,
        sessionStore: new JsonlSessionStore({
          dir: path.join(job.workspaceDir, '.moss', 'sessions'),
        }),
        llmProvider: {
          id: 'scripted',
          displayName: 'scripted offline',
          capabilities: { streaming: false },
          async complete() {
            calls++;
            return calls === 1
              ? {
                  stopReason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'write-1', name: 'write_answer', input: {} }],
                }
              : {
                  stopReason: 'end_turn',
                  content: [{ type: 'text', text: 'The requested file has been written.' }],
                };
          },
        },
        domainPrompt: false,
        enableFollowUpGuard: false,
        enableSteering: false,
      });
      agent.tools.register({
        name: 'write_answer',
        description: 'Write the requested answer',
        metadata: { sideEffectClass: 'local_write' },
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          await fs.writeFile(path.join(job.workspaceDir, 'answer.txt'), '42');
          return 'written';
        },
      });
      for (const input of job.inputs) agent.admit(job.sessionKey, input.text, { id: input.id });
      try {
        const result = await runTask(
          {
            workspaceDir: job.workspaceDir,
            runTurn: createAgentTurnRunner(agent, job.sessionKey, { abortSignal: signal }),
            signal,
            maxTurns: 4,
            maxRepairAttempts: 0,
            onProgress: (p) => onTask(p.taskId),
          },
          job.scope,
          { acceptanceCommand: job.acceptanceCommand }
        );
        const unread = new Set(agent.inboxPending(job.sessionKey).map((x) => x.id));
        return {
          state: result.outcome === 'pass' ? 'ready' : 'blocked',
          summary: result.outcome,
          taskId: result.snapshot.taskId,
          readInputIds: job.inputs.filter((x) => !unread.has(x.id)).map((x) => x.id),
        };
      } finally {
        await agent.close();
      }
    },
    async deliver(_id, inputs) {
      return inputs.map((x) => x.id);
    },
  };
}

test('real upstream engine dispatches a verified Moss task in a separate worktree; replay is durable', async (t) => {
  const dir = await fixture(t);
  const counter = { runs: 0 };
  let runtime = await createMossSuperagent({
    workspaceDir: dir,
    config,
    worker: sdkWorker(counter),
  });
  assert.equal(runtime.receive(request()).duplicate, false);
  assert.equal(runtime.receive(request()).duplicate, true);
  assert.throws(() => runtime.receive(request('one', { text: 'different' })), /changed content/);
  await runtime.work();
  const [ticket] = runtime.tickets();
  assert.equal(ticket.state, 'completed', JSON.stringify(ticket));
  assert.equal(counter.runs, 1);
  assert.equal(await fs.readFile(path.join(dir, 'answer.txt'), 'utf8'), '0');
  assert.equal(
    (
      await runProcess('git', {
        args: ['status', '--porcelain', '--untracked-files=all'],
        cwd: dir,
      })
    ).stdout,
    '',
    'runtime state must not pollute or expose itself in the parent Git status'
  );
  assert.equal(await fs.readFile(path.join(ticket.workspace, 'answer.txt'), 'utf8'), '42');
  assert.equal((await getTaskStateSnapshot(ticket.workspace, ticket.taskId)).phase, 'accepted');
  assert.equal(runtime.decisions()[0].mandate.strength, 'explicit');
  assert.ok(runtime.replies().some((reply) => reply.kind === 'reply'));
  await runtime.close();
  runtime = await createMossSuperagent({ workspaceDir: dir, worker: sdkWorker(counter) });
  assert.equal(runtime.receive(request()).duplicate, true);
  await runtime.work();
  assert.equal(counter.runs, 1);
  assert.equal(runtime.tickets()[0].id, ticket.id);
  await runtime.close();
});

test('unauthorized/context-only/unknown source requests cannot launch workers', async (t) => {
  const dir = await fixture(t);
  const counter = { runs: 0 };
  const runtime = await createMossSuperagent({
    workspaceDir: dir,
    config,
    worker: sdkWorker(counter),
  });
  runtime.receive(request('bad', { actor: 'stranger' }));
  runtime.receive(request('context', { human: false }));
  runtime.receive(request('source', { source: 'foreign' }));
  await runtime.work();
  assert.equal(counter.runs, 0);
  assert.equal(runtime.tickets().length, 0);
  await runtime.close();
});

test('observe records a positive semantic assessment without execution; auto needs written matched rules', async (t) => {
  const dir = await fixture(t);
  const counter = { runs: 0 };
  const policy = {
    ...config,
    rules: [{ id: 'repair', instruction: 'Repair the local answer file' }],
  };
  const runtime = await createMossSuperagent({
    workspaceDir: dir,
    config: policy,
    worker: sdkWorker(counter),
    assess: async () => ({
      kind: 'accept',
      scope: 'Write 42 to answer.txt',
      reason: 'Matches written rule',
      rules: ['repair'],
    }),
  });
  runtime.receive(request('observe', { addressed: false }));
  await runtime.work();
  assert.equal(counter.runs, 0);
  assert.ok(runtime.decisions().some((x) => x.audit?.wouldAccept));
  runtime.configure({ ...policy, acceptMode: 'auto' });
  runtime.receive(request('auto', { addressed: false }));
  await runtime.work();
  assert.equal(counter.runs, 1);
  assert.equal(runtime.tickets()[0].state, 'completed');
  await runtime.close();
});

test('a fabricated ready report or failed oracle cannot become a completed ticket', async (t) => {
  const dir = await fixture(t);
  const runtime = await createMossSuperagent({
    workspaceDir: dir,
    config,
    worker: {
      async run(job) {
        return {
          state: 'ready',
          summary: 'Trust me: PASS',
          taskId: 'invented',
          readInputIds: job.inputs.map((x) => x.id),
        };
      },
      async deliver() {
        return [];
      },
    },
  });
  runtime.receive(request());
  await runtime.work();
  assert.equal(runtime.tickets()[0].state, 'blocked');
  assert.ok(!runtime.replies().some((x) => x.text === 'Trust me: PASS'));
  await runtime.close();
});

test('pause persists across connections and prevents launches until resumed', async (t) => {
  const dir = await fixture(t);
  const counter = { runs: 0 };
  const runtime = await createMossSuperagent({
    workspaceDir: dir,
    config,
    worker: sdkWorker(counter),
  });
  runtime.setPaused(true);
  runtime.receive(request());
  await runtime.work();
  assert.equal(counter.runs, 0);
  const other = await createMossSuperagent({ workspaceDir: dir });
  assert.equal(other.paused(), true);
  other.setPaused(false);
  await other.close();
  await runtime.work();
  assert.equal(counter.runs, 1);
  await runtime.close();
});

test('symlink state paths are refused', async (t) => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, '.moss'));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-foreign-'));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  await fs.symlink(
    target,
    path.join(dir, '.moss', 'superagent'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(createMossSuperagent({ workspaceDir: dir, config }), /symbolic links/);
});

test('a genuine native accepted task is still blocked if the independent oracle subsequently fails', async (t) => {
  const dir = await fixture(t);
  const worker = sdkWorker();
  const runtime = await createMossSuperagent({
    workspaceDir: dir,
    config,
    worker: {
      ...worker,
      async run(job, signal, onTask) {
        const result = await worker.run(job, signal, onTask);
        await fs.writeFile(path.join(job.workspaceDir, 'answer.txt'), '0');
        return result;
      },
    },
  });
  runtime.receive(request());
  await runtime.work();
  assert.equal(runtime.tickets()[0].state, 'blocked');
  await runtime.close();
});

test('SQLite atomically rolls back domain rows and side effects', async (t) => {
  const dir = await fixture(t);
  const { SuperagentStore } = await import('../dist/core/superagent/store.js');
  const store = new SuperagentStore(path.join(dir, 'state.sqlite'));
  assert.throws(
    () =>
      store.atomic(() => {
        store.set('effect', 'start:one', { id: 'one' });
        store.set('ticket', 'one', { id: 'one' });
        throw new Error('injected failure');
      }),
    /injected failure/
  );
  assert.equal(store.get('effect', 'start:one'), undefined);
  assert.equal(store.get('ticket', 'one'), undefined);
  store.close();
});

test('invalid inferred decisions fail closed instead of authorizing work', async (t) => {
  const dir = await fixture(t);
  const counter = { runs: 0 };
  const runtime = await createMossSuperagent({
    workspaceDir: dir,
    config: { ...config, acceptMode: 'auto', rules: [{ id: 'known', instruction: 'Repair' }] },
    worker: sdkWorker(counter),
    assess: async () => ({
      kind: 'accept',
      scope: 'anything',
      reason: 'injected',
      rules: ['unknown'],
    }),
  });
  runtime.receive(request('bad-decision', { addressed: false }));
  await runtime.work();
  assert.equal(counter.runs, 0);
  assert.equal(runtime.tickets().length, 0);
  assert.ok(runtime.decisions().some((x) => x.kind === 'unavailable'));
  await runtime.close();
});

test(
  'stop cancels only its assignment while a second isolated worker can complete',
  { timeout: 30_000 },
  async (t) => {
    const dir = await fixture(t);
    const real = sdkWorker();
    let firstStarted;
    const started = new Promise((resolve) => {
      firstStarted = resolve;
    });
    let cancelled = false;
    const worker = {
      ...real,
      async run(job, signal, onTask) {
        if (job.scope === 'Wait for cancellation') {
          firstStarted();
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
          cancelled = true;
          throw new Error('cancelled');
        }
        return real.run(job, signal, onTask);
      },
    };
    const runtime = await createMossSuperagent({
      workspaceDir: dir,
      config: { ...config, maxWorkers: 2 },
      worker,
    });
    runtime.receive(request('slow', { text: 'Wait for cancellation' }));
    runtime.receive(request('fast'));
    const work = runtime.work();
    await started;
    const slow = runtime.tickets().find((x) => x.scope === 'Wait for cancellation');
    const control = await createMossSuperagent({ workspaceDir: dir });
    control.stop(slow.id);
    await control.close();
    await work;
    assert.equal(cancelled, true);
    assert.equal(runtime.tickets().find((x) => x.id === slow.id).state, 'stopped');
    assert.ok(runtime.tickets().some((x) => x.state === 'completed'));
    await runtime.close();
  }
);

test('restart blocks an uncertain persisted assignment; explicit retry reuses its worktree/session', async (t) => {
  const dir = await fixture(t);
  let runtime = await createMossSuperagent({
    workspaceDir: dir,
    config,
    worker: {
      async run() {
        throw new Error('injected interruption');
      },
      async deliver() {
        return [];
      },
    },
  });
  runtime.receive(request());
  await runtime.work();
  const initial = runtime.tickets()[0];
  assert.equal(initial.state, 'blocked');
  await runtime.close();
  const { SuperagentStore } = await import('../dist/core/superagent/store.js');
  const store = new SuperagentStore(path.join(dir, '.moss', 'superagent', 'state.sqlite'));
  const binding = store.get('binding', initial.id);
  store.set('binding', initial.id, { ...binding, running: true });
  store.close();
  const counter = { runs: 0 };
  runtime = await createMossSuperagent({ workspaceDir: dir, worker: sdkWorker(counter) });
  await runtime.work();
  assert.equal(counter.runs, 0);
  assert.equal(runtime.tickets()[0].state, 'blocked');
  runtime.retry(initial.id);
  await runtime.work();
  assert.equal(counter.runs, 1);
  assert.equal(runtime.tickets()[0].state, 'completed');
  assert.equal(runtime.tickets()[0].workspace, initial.workspace);
  assert.equal(runtime.tickets()[0].sessionKey, initial.sessionKey);
  await runtime.close();
});

test('a follow-up arriving at completion cannot be lost or turn an unread ticket into ready', async (t) => {
  const dir = await fixture(t);
  const real = sdkWorker();
  let injected = false;
  const runtime = await createMossSuperagent({
    workspaceDir: dir,
    config,
    worker: {
      ...real,
      async run(job, signal, onTask) {
        const result = await real.run(job, signal, onTask);
        if (!injected) {
          injected = true;
          runtime.receive(
            request('late', { thread: 'one', text: 'Keep 42 within the authorized scope' })
          );
        }
        return result;
      },
    },
  });
  runtime.receive(request());
  await runtime.work();
  assert.equal(runtime.tickets()[0].state, 'blocked');
  runtime.retry(runtime.tickets()[0].id);
  await runtime.work();
  assert.equal(runtime.tickets()[0].state, 'completed');
  await runtime.close();
});

test('operator reconfiguration cannot replace an existing mandate oracle', async (t) => {
  const dir = await fixture(t);
  const real = sdkWorker();
  let first = true;
  const runtime = await createMossSuperagent({
    workspaceDir: dir,
    config,
    worker: {
      ...real,
      async run(job, signal, onTask) {
        assert.equal(job.acceptanceCommand, acceptance);
        if (first) {
          first = false;
          throw new Error('inspect before retry');
        }
        return real.run(job, signal, onTask);
      },
    },
  });
  runtime.receive(request());
  await runtime.work();
  runtime.configure({ ...config, acceptanceCommand: 'node -e "process.exit(1)"', maxWorkers: 2 });
  runtime.retry(runtime.tickets()[0].id);
  await runtime.work();
  assert.equal(runtime.tickets()[0].state, 'completed');
  await runtime.close();
});

test(
  'only one scheduler may own the database, and a failed contender can retry after release',
  { timeout: 10_000 },
  async (t) => {
    const dir = await fixture(t);
    const first = await createMossSuperagent({ workspaceDir: dir, config });
    const second = await createMossSuperagent({ workspaceDir: dir });
    const controller = new AbortController();
    const work = first.work({ follow: true, signal: controller.signal });
    try {
      // The lock is an observable ownership record, not a timing assumption.
      for (let i = 0; i < 100; i++) {
        if (
          (await fs.readdir(path.join(dir, '.moss', 'superagent'))).some(
            (file) => file.includes('scheduler') && file.endsWith('.lock')
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await assert.rejects(second.work());
    } finally {
      controller.abort();
      await work;
    }
    await second.work();
    await second.close();
    await first.close();
  }
);
