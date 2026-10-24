import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonlSessionStore } from '../dist/index.js';
import { ErrorCode } from '../dist/errors.js';
import { runProcess } from '../dist/utils/run-process.js';

const key = 'owner:tail-session';
const user = (content) => ({ role: 'user', content });
const initial = user('complete history');
const tailMessage = user('complete final record');
const completeTail = JSON.stringify({ type: 'message', message: tailMessage, deliveryId: 'tail' });
const tails = [
  {
    name: 'partial JSON without newline',
    raw: '{"type":"message","message":',
    messages: [],
    receipts: [],
  },
  {
    name: 'complete JSON without newline',
    raw: completeTail,
    messages: [tailMessage],
    receipts: ['tail'],
  },
  {
    name: 'complete JSON with newline',
    raw: completeTail + '\n',
    messages: [tailMessage],
    receipts: ['tail'],
  },
];

async function fixture(t, tail) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-jsonl-tail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${encodeURIComponent(key)}.jsonl`);
  const raw = JSON.stringify({ type: 'message', message: initial }) + '\n' + tail;
  // Deterministic images of a stopped writer; subsequent writes and reads use
  // real stores in separate OS processes, with no mocked persistence.
  await fs.writeFile(file, raw);
  return { dir, file, raw };
}

async function child(dir, body) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const result = await runProcess(process.execPath, {
    args: [
      '--input-type=module',
      '--eval',
      `
      import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
      const store = new JsonlSessionStore({ dir: ${JSON.stringify(dir)} });
      const key = ${JSON.stringify(key)};
      const user = (content) => ({ role: 'user', content });
      ${body}
    `,
    ],
    cwd: dir,
    timeout: 10_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

for (const tail of tails) {
  test(`append-once survives process restarts after ${tail.name}`, async (t) => {
    const { dir, file, raw } = await fixture(t, tail.raw);
    assert.equal(
      await child(
        dir,
        `
      console.log(JSON.stringify(await store.appendMessageOnce(key, 'first', user('first delivery'))));
    `
      ),
      true
    );
    const afterFirst = await fs.readFile(file, 'utf8');
    const restarted = await child(
      dir,
      `
      const before = await store.loadDeliverySnapshot(key);
      const retry = await store.appendMessageOnce(key, 'first', user('first delivery'));
      const second = await store.appendMessageOnce(key, 'second', user('second delivery'));
      console.log(JSON.stringify({ before, retry, second }));
    `
    );
    assert.deepEqual(restarted.before, {
      messages: [initial, ...tail.messages, user('first delivery')],
      deliveryIds: [...tail.receipts, 'first'],
    });
    assert.equal(restarted.retry, false);
    assert.equal(restarted.second, true);
    const final = await child(
      dir,
      `
      const retry = await store.appendMessageOnce(key, 'second', user('second delivery'));
      console.log(JSON.stringify({ retry, snapshot: await store.loadDeliverySnapshot(key) }));
    `
    );
    assert.equal(final.retry, false);
    assert.deepEqual(final.snapshot, {
      messages: [initial, ...tail.messages, user('first delivery'), user('second delivery')],
      deliveryIds: [...tail.receipts, 'first', 'second'],
    });
    assert.equal(afterFirst.slice(0, raw.length), raw, 'existing tail bytes are never rewritten');
    const appendedLines = afterFirst.slice(raw.length).split('\n');
    if (!raw.endsWith('\n'))
      assert.equal(appendedLines.shift(), '', 'a new line isolates the old tail');
    assert.equal(JSON.parse(appendedLines[0]).deliveryId, 'first');
    assert.deepEqual(appendedLines.slice(1), [''], 'only one complete new record is appended');
  });

  test(`ordinary append survives process restarts after ${tail.name}`, async (t) => {
    const { dir, file, raw } = await fixture(t, tail.raw);
    assert.deepEqual(
      await child(
        dir,
        `
      await store.appendMessage(key, user('ordinary first'));
      console.log(JSON.stringify(await store.loadMessages(key)));
    `
      ),
      [initial, ...tail.messages, user('ordinary first')]
    );
    assert.deepEqual(
      await child(
        dir,
        `
      await store.appendMessage(key, user('ordinary second'));
      console.log(JSON.stringify(await store.loadMessages(key)));
    `
      ),
      [initial, ...tail.messages, user('ordinary first'), user('ordinary second')]
    );
    assert.equal((await fs.readFile(file, 'utf8')).slice(0, raw.length), raw);
  });
}

test('receipt hits do not mutate an unterminated tail', async (t) => {
  const { dir, file, raw } = await fixture(t, completeTail);
  assert.equal(
    await child(
      dir,
      `
    console.log(JSON.stringify(await store.appendMessageOnce(key, 'tail', user('must not append'))));
  `
    ),
    false
  );
  assert.equal(await fs.readFile(file, 'utf8'), raw);
});

test('external tail changes still reject stale append and replacement without mutation', async (t) => {
  const { dir, file } = await fixture(t, completeTail);
  const stale = new JsonlSessionStore({ dir });
  const messages = await stale.loadMessages(key);
  await fs.appendFile(file, '\n{"type":"message","message":');
  const changed = await fs.readFile(file, 'utf8');
  for (const append of [
    () => stale.appendMessageOnce(key, 'new', user('stale delivery')),
    () => stale.appendMessage(key, user('stale ordinary append')),
    () => stale.replaceMessages(key, messages),
  ]) {
    await assert.rejects(append, (error) => error.code === ErrorCode.SESSION_PERSIST_FAILED);
    assert.equal(await fs.readFile(file, 'utf8'), changed);
  }
});

test('replacement preserves a receipt from a complete unterminated tail', async (t) => {
  const { dir, file } = await fixture(t, completeTail);
  await child(
    dir,
    `
    await store.loadMessages(key);
    await store.replaceMessages(key, [user('compacted')]);
    console.log('true');
  `
  );
  const result = await child(
    dir,
    `
    const retry = await store.appendMessageOnce(key, 'tail', user('must not replay'));
    const next = await store.appendMessageOnce(key, 'next', user('next delivery'));
    console.log(JSON.stringify({ retry, next, snapshot: await store.loadDeliverySnapshot(key) }));
  `
  );
  assert.deepEqual(result, {
    retry: false,
    next: true,
    snapshot: {
      messages: [user('compacted'), user('next delivery')],
      deliveryIds: ['tail', 'next'],
    },
  });
  const lines = (await fs.readFile(file, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'state_replace');
});
