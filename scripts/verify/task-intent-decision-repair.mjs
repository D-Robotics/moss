#!/usr/bin/env node
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = process.env.MOSS_VERIFY_DIST_ROOT ?? path.join(root, 'dist');
const load = (file) => import(pathToFileURL(path.join(dist, file)).href);
const [{ SessionInbox }, { TaskIntentCoordinator }, { TaskIntentTurn }] = await Promise.all([
  load('core/session/session-inbox.js'),
  load('core/session/task-intent-coordinator.js'),
  load('core/session/task-intent-turn.js'),
]);

const request = '做一个宠物机器人';
const goal = (quote = request, messageId) => ({
  field: 'goal',
  operation: 'set',
  value: request,
  quote,
  ...(messageId ? { messageId } : {}),
});
const execute = (changes = [goal()]) => ({
  disposition: 'execute',
  changes,
  plan: ['Inspect the selected device'],
});
const call = (input) => [{ id: 'decision', name: 'turn_decision', input }];
function fixture(entries = [], context) {
  const inbox = SessionInbox.fromEntries(entries);
  const coordinator = new TaskIntentCoordinator(
    { read: () => inbox, mutate: (operation) => operation(inbox) },
    os.tmpdir(),
    context
  );
  const turn = () => new TaskIntentTurn(coordinator, undefined, () => []);
  return { inbox, coordinator, turn };
}

const first = fixture();
first.coordinator.admit({ id: 'first', text: request });
let turn = first.turn();
await turn.prepare();
const calls = call({
  disposition: 'clarify',
  plan: ['Ask about features'],
  changes: [{ field: 'goal', operation: 'set', value: request }],
});
calls.push({ id: 'business', name: 'device_probe', input: {} });
const rejected = await turn.process(calls, false);
assert.match(rejected.retry, /changes\[0\]\.quote/);
assert.match(rejected.retry, /plan/);
assert.match(rejected.retry, /clarify/);
assert.equal(calls.length, 0, 'invalid decisions must suppress the entire business batch');
assert.throws(() => first.coordinator.assertCurrent());
const failedRepair = await turn.process(
  call(execute([{ field: 'goal', operation: 'set', value: request }])),
  false
);
assert.ok(failedRepair.halt, 'keep one bounded repair');
assert.equal(first.coordinator.receipt('first').status, 'pending');
console.log('PASS malformed clarification reports plan and citation errors; no actions escape');

// Restore the unchanged journal, then receive a second message with a distinct identity.
const restarted = fixture(JSON.parse(JSON.stringify(first.inbox.toEntries())));
restarted.coordinator.admit({ id: 'second', text: request });
turn = restarted.turn();
await turn.prepare();
const committed = await turn.process(call(execute()), false);
assert.ok(!committed.retry && !committed.halt, committed.retry);
const state = restarted.coordinator.read();
assert.equal(state.pending, false);
assert.equal(state.state.sources.goal.at(-1).messageId, 'second');
assert.equal(restarted.coordinator.receipt('first').status, 'committed');
assert.equal(restarted.coordinator.receipt('second').status, 'committed');
assert.equal(restarted.inbox.toEntries().length, 2, 'do not erase or coalesce user messages');
restarted.coordinator.assertCurrent(state);
console.log(
  'PASS identical resubmission after restart binds the latest source and consumes both receipts'
);

const ambiguous = fixture();
ambiguous.coordinator.admit({ id: 'restricted', text: request + '，只读检查' });
ambiguous.coordinator.admit({ id: 'editing', text: request + '，修改程序' });
turn = ambiguous.turn();
await turn.prepare();
const conflict = await turn.process(call(execute()), false);
assert.match(conflict.retry, /messageId/);
assert.match(conflict.retry, /restricted/);
assert.match(conflict.retry, /editing/);
assert.throws(() => ambiguous.coordinator.assertCurrent());
const explicit = await turn.process(call(execute([goal(request, 'editing')])), false);
assert.ok(!explicit.retry && !explicit.halt, explicit.retry);
assert.equal(ambiguous.coordinator.read().state.sources.goal.at(-1).messageId, 'editing');
console.log(
  'PASS shared substrings remain ambiguous; repair must cite an explicit pending message'
);

const prior = fixture();
prior.coordinator.admit({ id: 'restriction', text: '只读检查' });
turn = prior.turn();
await turn.prepare();
const restricted = await turn.process(
  call(
    execute([
      {
        field: 'constraints',
        operation: 'add',
        value: 'read_only',
        quote: '只读检查',
      },
    ])
  ),
  false
);
assert.ok(!restricted.retry && !restricted.halt);
const oldGuard = turn.executionGuard();
for (const id of ['repeat-first', 'repeat-second']) prior.coordinator.admit({ id, text: request });
turn = prior.turn();
await turn.prepare();
const kept = await turn.process(call(execute()), false);
assert.ok(!kept.retry && !kept.halt, kept.retry);
assert.deepEqual(prior.coordinator.read().state.constraints, ['read_only']);
assert.equal(prior.coordinator.read().state.constraintSources.read_only.messageId, 'restriction');
assert.throws(oldGuard, 'source binding must not revive the previous execution plan');
console.log('PASS repeated input preserves existing restrictions and fences the old plan');

const changedBinding = fixture();
changedBinding.coordinator.admit({ id: 'ordinary', text: request });
changedBinding.coordinator.admit({ id: 'invalidating', text: request, invalidateTask: true });
turn = changedBinding.turn();
await turn.prepare();
assert.match((await turn.process(call(execute()), false)).retry, /messageId/);
console.log('PASS identical text with different task invalidation meaning remains ambiguous');

const corrections = [];
const corrected = fixture([], {
  correct: (correction) => corrections.push(correction),
  hasRecordedCorrection: () => false,
  registerClaims: () => [],
  claimsActive: () => true,
});
for (const id of ['correction-first', 'correction-second'])
  corrected.coordinator.admit({ id, text: '验收还没完成' });
turn = corrected.turn();
await turn.prepare();
const correction = await turn.process(
  call({
    disposition: 'answer',
    answer: '验收尚未完成。',
    contextCorrections: [{ targetId: 'old-conclusion', quote: '验收还没完成' }],
  }),
  false
);
assert.ok(!correction.retry && !correction.halt, correction.retry);
assert.equal(corrections[0].id, 'intent:correction-second:old-conclusion');
console.log('PASS repeated context corrections use the same exact-source binding rule');

const clarification = fixture();
clarification.coordinator.admit({ id: 'question', text: request });
turn = clarification.turn();
await turn.prepare();
const badPlan = await turn.process(
  call({ disposition: 'clarify', plan: ['Inspect hardware'] }),
  false
);
assert.match(badPlan.retry, /plan/);
const question = await turn.process(
  call({ disposition: 'clarify', answer: '你希望它具备哪些功能？' }),
  false
);
assert.equal(question.answer, '你希望它具备哪些功能？');
assert.equal(question.hold, true);
assert.equal(clarification.coordinator.receipt('question').status, 'needs_clarification');
assert.equal(clarification.coordinator.read().plan.length, 0);
assert.throws(() => clarification.coordinator.assertCurrent());
console.log('PASS repaired clarification asks the actual question and never authorizes execution');

const forged = fixture();
forged.coordinator.admit({ id: 'author', text: request });
turn = forged.turn();
await turn.prepare();
const invented = await turn.process(call(execute([goal('用户没有说过的授权', 'author')])), false);
assert.ok(invented.retry);
assert.throws(() => forged.coordinator.assertCurrent());
console.log('PASS missing or fabricated author quotes still fail closed');
