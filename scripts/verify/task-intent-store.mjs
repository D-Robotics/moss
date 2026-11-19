#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TaskIntentCoordinator } from '../../dist/core/session/task-intent-coordinator.js';
import {
  loadSessionInbox,
  updateSessionInbox,
} from '../../dist/core/session/session-inbox-store.js';
import {
  createDraftTask,
  appendTaskEvent,
  getTaskStateSnapshot,
} from '../../dist/core/task/task-store.js';
import { runAcceptanceCommand } from '../../dist/core/task/acceptance-command.js';
import {
  withTaskExecutionGuard,
  TaskExecutionSupersededError,
} from '../../dist/core/task/task-execution-guard.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-intent-store-'));
let failAfterJournal = false;
const port = (file) => ({
  read: () => loadSessionInbox(file),
  mutate(operation) {
    const { result } = updateSessionInbox(file, operation);
    if (failAfterJournal) {
      failAfterJournal = false;
      throw new Error('simulated process exit after journal fsync');
    }
    return result;
  },
});
function proposal(batch, disposition = 'answer', changes = []) {
  return {
    baseRevision: batch.snapshot.revision,
    inputSeq: batch.snapshot.inputSeq,
    messageIds: batch.inputs.map((input) => input.id),
    changes,
    disposition,
    plan: disposition === 'execute' ? ['Check the current device'] : [],
  };
}
try {
  if (process.platform !== 'win32') {
    const marker = path.join(workspace, 'obsolete-command-started');
    const previous = process.env.MOSS_ACCEPT_LOGIN_PATH;
    process.env.MOSS_ACCEPT_LOGIN_PATH = '0';
    try {
      let stale = false;
      const pending = withTaskExecutionGuard(
        () => {
          if (stale) throw new TaskExecutionSupersededError();
        },
        () =>
          runAcceptanceCommand({
            command: 'touch obsolete-command-started',
            workspaceDir: workspace,
          })
      );
      stale = true;
      await assert.rejects(pending, /superseded/);
      await assert.rejects(fs.access(marker));
    } finally {
      if (previous === undefined) delete process.env.MOSS_ACCEPT_LOGIN_PATH;
      else process.env.MOSS_ACCEPT_LOGIN_PATH = previous;
    }
    console.log('PASS correction during acceptance environment setup prevents process startup');
  }
  const file = path.join(workspace, 'receipt.json');
  const a = new TaskIntentCoordinator(port(file), workspace);
  const b = new TaskIntentCoordinator(port(file), workspace);
  a.admit({ id: 'seed', text: 'Read the device' });
  const seed = await a.capture();
  await a.commit(seed, proposal(seed));
  a.admit({ id: 'same-revision', text: 'Just another question' });
  const [first, second] = await Promise.all([a.capture(), b.capture()]);
  await a.commit(first, proposal(first));
  await assert.rejects(b.commit(second, proposal(second)), /superseded/i);
  console.log('PASS two coordinators cannot submit the same no-change input twice');
  updateSessionInbox(file, (inbox) => {
    for (let index = 0; index < 505; index++) {
      const entry = inbox.admit({ id: `ordinary-${index}`, prompt: 'Internal prompt' });
      inbox.promote(entry.id);
    }
  });
  assert.equal(
    loadSessionInbox(file)
      .toEntries()
      .find((entry) => entry.id === 'seed').prompt,
    ''
  );
  a.admit({ id: 'seed', text: 'Read the device' });
  assert.equal(a.read().pending, false);
  assert.equal(a.receipt('seed').revision, 1);
  assert.throws(() => a.admit({ id: 'seed', text: 'Different text' }), /conflict/);
  console.log('PASS pruned intent payload retains receipt and idempotent input identity');

  const task = await createDraftTask(workspace, 'Original goal', { constraints: ['readonly'] });
  const recoveryFile = path.join(workspace, 'projection.json');
  const journal = new TaskIntentCoordinator(port(recoveryFile), workspace);
  journal.admit({ id: 'revise', text: 'Use a visible terminal', taskId: task.taskId });
  const batch = await journal.capture(task.taskId);
  failAfterJournal = true;
  await assert.rejects(
    journal.commit(
      batch,
      proposal(batch, 'execute', [
        {
          field: 'executionSurface',
          operation: 'set',
          value: 'visible terminal',
          messageId: 'revise',
          quote: 'visible terminal',
        },
      ])
    ),
    /simulated process exit/
  );
  assert.equal(journal.read().pending, true);
  const recovered = new TaskIntentCoordinator(port(recoveryFile), workspace);
  await recovered.recover();
  await recovered.recover();
  const revised = await getTaskStateSnapshot(workspace, task.taskId);
  assert.equal(revised.revision, 1);
  assert.equal(revised.needsReplan, false);
  assert.equal(revised.plan.length, 1);
  assert.equal(recovered.read().state.goal, 'Original goal');
  assert.deepEqual(recovered.read().state.constraints, ['readonly']);
  assert.equal(recovered.receipt('revise').status, 'committed');
  console.log(
    'PASS durable projection recovery applies once and preserves the native goal/constraint'
  );
  const oldBinding = recovered.read();
  await appendTaskEvent(workspace, task.taskId, 'execution_started');
  recovered.admit({ id: 'continue', text: 'Continue this task', taskId: task.taskId });
  const continuation = await recovered.capture(task.taskId);
  const decision = proposal(continuation, 'execute');
  decision.plan = ['Continue under a fresh plan'];
  await recovered.commit(continuation, decision);
  const continued = await getTaskStateSnapshot(workspace, task.taskId);
  assert.equal(continued.revision, 1);
  assert.equal(continued.plan[0].title, decision.plan[0]);
  assert.throws(() => recovered.assertCurrent(oldBinding), /authorize execution/);
  console.log('PASS a same-revision continuation replaces the plan and fences old callbacks');

  const corrupt = path.join(workspace, 'corrupt.json');
  const malformed = loadSessionInbox(file).toEntries();
  malformed[0].intent = { status: 'anything' };
  await fs.writeFile(corrupt, JSON.stringify(malformed));
  assert.throws(() => loadSessionInbox(corrupt), /Invalid persisted/);
  console.log('PASS malformed persisted intent fails closed');

  const accepted = await createDraftTask(workspace, 'Completed goal');
  for (const type of [
    'plan_ready',
    'execution_started',
    'verification_started',
    'acceptance_pass',
  ]) {
    await appendTaskEvent(workspace, accepted.taskId, type);
  }
  const rejectedFile = path.join(workspace, 'rejected.json');
  const rejected = new TaskIntentCoordinator(port(rejectedFile), workspace);
  rejected.admit({ id: 'old-task', text: 'Change completed goal', taskId: accepted.taskId });
  const old = await rejected.capture(accepted.taskId);
  await assert.rejects(
    rejected.commit(
      old,
      proposal(old, 'execute', [
        {
          field: 'goal',
          operation: 'set',
          value: 'Changed goal',
          messageId: 'old-task',
          quote: 'Change completed goal',
        },
      ])
    )
  );
  assert.equal(rejected.receipt('old-task').status, 'failed');
  const fresh = await createDraftTask(workspace, 'Fresh follow-up');
  rejected.admit({ id: 'fresh-task', text: 'Work on this new task', taskId: fresh.taskId });
  const retry = await rejected.capture(fresh.taskId);
  await rejected.commit(retry, proposal(retry, 'execute'));
  assert.equal(rejected.read().taskId, fresh.taskId);
  assert.equal((await getTaskStateSnapshot(workspace, accepted.taskId)).goal, 'Completed goal');
  console.log('PASS rejected completed-task projection does not wedge later fresh-task inputs');
  recovered.admit({ id: 'unbound', text: 'Explain a different topic' });
  const unbound = await recovered.capture();
  assert.equal(unbound.snapshot.taskId, undefined);
  await recovered.commit(
    unbound,
    proposal(unbound, 'answer', [
      {
        field: 'goal',
        operation: 'set',
        value: 'Explain a different topic',
        messageId: 'unbound',
        quote: 'Explain a different topic',
      },
    ])
  );
  assert.equal(recovered.read().taskId, undefined);
  assert.equal((await getTaskStateSnapshot(workspace, task.taskId)).goal, 'Original goal');
  console.log('PASS a host-unbound follow-up does not rewrite the preceding native task');
} finally {
  await fs.rm(workspace, { recursive: true, force: true });
}
