import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonlSessionStore } from '../dist/index.js';
import { runProcess } from '../dist/utils/run-process.js';

const key = 'owner:receipt-session';
const user = (content) => ({ role: 'user', content });
const eio = (message) => Object.assign(new Error(message), { code: 'EIO' });

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-jsonl-receipt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, `${encodeURIComponent(key)}.jsonl`) };
}

function interceptOpen(t, intercept) {
  const original = fs.open;
  fs.open = (target, flags, ...args) => intercept(original, target, flags, ...args);
  syncBuiltinESMExports();
  t.after(() => {
    fs.open = original;
    syncBuiltinESMExports();
  });
}

async function restartedSnapshot(dir) {
  const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
  const result = await runProcess(process.execPath, {
    args: [
      '--input-type=module',
      '--eval',
      `
      import { JsonlSessionStore } from ${JSON.stringify(moduleUrl)};
      const store = new JsonlSessionStore({ dir: ${JSON.stringify(dir)} });
      console.log(JSON.stringify(await store.loadDeliverySnapshot(${JSON.stringify(key)})));
    `,
    ],
    cwd: dir,
    timeout: 10_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('a duplicate receipt retries failed file fsync before acknowledging and closes every handle', async (t) => {
  const { dir, file } = await fixture(t);
  let failing = true;
  let syncAttempts = 0;
  let closes = 0;
  const flagsSeen = [];
  interceptOpen(t, async (open, target, flags, ...args) => {
    const handle = await open(target, flags, ...args);
    if (target === file) {
      flagsSeen.push(flags);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.sync = async () => {
        syncAttempts++;
        if (failing) throw eio('persistent data fsync failure');
        await sync();
      };
      handle.close = async () => {
        closes++;
        await close();
      };
    }
    return handle;
  });
  await assert.rejects(
    new JsonlSessionStore({ dir }).appendMessageOnce(key, 'delivery', user('one delivery')),
    { code: 'EIO' }
  );
  assert.equal(syncAttempts, 1);
  assert.equal(closes, 1);
  const written = await fs.readFile(file, 'utf8');
  await assert.rejects(
    new JsonlSessionStore({ dir }).appendMessageOnce(key, 'delivery', user('one delivery')),
    { code: 'EIO' }
  );
  assert.equal(syncAttempts, 2, 'a visible receipt cannot bypass the failed persistence barrier');
  assert.equal(closes, 2);
  failing = false;
  assert.equal(
    await new JsonlSessionStore({ dir }).appendMessageOnce(key, 'delivery', user('one delivery')),
    false
  );
  assert.equal(syncAttempts, 3);
  assert.equal(closes, 3);
  assert.deepEqual(flagsSeen, ['a', 'r+', 'r+']);
  assert.equal(await fs.readFile(file, 'utf8'), written, 'retries never append or rewrite history');
  assert.deepEqual(await restartedSnapshot(dir), {
    messages: [user('one delivery')],
    deliveryIds: ['delivery'],
  });
});

if (process.platform !== 'win32') {
  test('a duplicate receipt requires its parent directory barrier and closes on failure', async (t) => {
    const { dir, file } = await fixture(t);
    await new JsonlSessionStore({ dir }).appendMessageOnce(key, 'delivery', user('one delivery'));
    const written = await fs.readFile(file, 'utf8');
    let failing = true;
    let armed = false;
    let directoryAttempts = 0;
    let dataCloses = 0;
    let barrierCloses = 0;
    interceptOpen(t, async (open, target, flags, ...args) => {
      const handle = await open(target, flags, ...args);
      if (target === file) {
        assert.equal(flags, 'r+');
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        handle.sync = async () => {
          await sync();
          armed = true;
        };
        handle.close = async () => {
          dataCloses++;
          await close();
        };
      } else if (target === dir && armed) {
        armed = false;
        const sync = handle.sync.bind(handle);
        const close = handle.close.bind(handle);
        handle.sync = async () => {
          directoryAttempts++;
          if (failing) throw eio('receipt directory fsync failure');
          await sync();
        };
        handle.close = async () => {
          barrierCloses++;
          await close();
        };
      }
      return handle;
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await assert.rejects(
        new JsonlSessionStore({ dir }).appendMessageOnce(key, 'delivery', user('one delivery')),
        { code: 'EIO' }
      );
      assert.equal(directoryAttempts, attempt);
      assert.equal(dataCloses, attempt);
      assert.equal(barrierCloses, attempt);
    }
    failing = false;
    assert.equal(
      await new JsonlSessionStore({ dir }).appendMessageOnce(key, 'delivery', user('one delivery')),
      false
    );
    assert.equal(directoryAttempts, 3);
    assert.equal(dataCloses, 3);
    assert.equal(barrierCloses, 3);
    assert.equal(await fs.readFile(file, 'utf8'), written);
  });
}

test('a receipt barrier cannot recreate a data file removed before opening it', async (t) => {
  const { dir, file } = await fixture(t);
  await new JsonlSessionStore({ dir }).appendMessageOnce(key, 'delivery', user('one delivery'));
  let opens = 0;
  interceptOpen(t, async (open, target, flags, ...args) => {
    if (target === file) {
      opens++;
      await fs.unlink(file);
      assert.equal(flags, 'r+', 'the receipt barrier must only open an existing file');
    }
    return open(target, flags, ...args);
  });
  await assert.rejects(
    new JsonlSessionStore({ dir }).appendMessageOnce(key, 'delivery', user('one delivery')),
    { code: 'ENOENT' }
  );
  assert.equal(opens, 1);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
});

const firstId = 'sk-fixture000000000000000000000000000000';
const secondId = 'sk-fixture111111111111111111111111111111';
const importedId = 'sk-fixture222222222222222222222222222222';
const bodySecret = 'sk-bodysecret333333333333333333333333333';
const password = 'SyntheticPassword123';
const sensitive = user(`api_key=${bodySecret}\nDB_PASSWORD=${password}`);

test('append preserves exact receipt IDs while redacting message secrets', async (t) => {
  const { dir, file } = await fixture(t);
  assert.equal(
    await new JsonlSessionStore({ dir }).appendMessageOnce(key, firstId, sensitive),
    true
  );
  assert.equal(
    await new JsonlSessionStore({ dir }).appendMessageOnce(key, firstId, sensitive),
    false
  );
  assert.equal(
    await new JsonlSessionStore({ dir }).appendMessageOnce(key, secondId, sensitive),
    true
  );
  const snapshot = await restartedSnapshot(dir);
  assert.deepEqual(snapshot.deliveryIds, [firstId, secondId]);
  assert.equal(snapshot.messages.length, 2);
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(raw.includes(bodySecret), false);
  assert.equal(raw.includes(password), false);
  assert.match(JSON.stringify(snapshot.messages), /\[REDACTED\]/);
});

test('replacement preserves carried and imported receipt IDs while redacting message secrets', async (t) => {
  const { dir, file } = await fixture(t);
  // A valid existing receipt image isolates replacement from append redaction.
  await fs.writeFile(
    file,
    JSON.stringify({ type: 'message', message: user('before'), deliveryId: firstId }) + '\n'
  );
  const store = new JsonlSessionStore({ dir });
  await store.loadMessages(key);
  await store.replaceMessages(key, [sensitive], { deliveryIds: [importedId] });
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(raw.includes(bodySecret), false);
  assert.equal(raw.includes(password), false);
  assert.deepEqual(await restartedSnapshot(dir), {
    messages: [user('api_key=[REDACTED]\nDB_PASSWORD=[REDACTED]')],
    deliveryIds: [firstId, importedId],
  });
  for (const id of [firstId, importedId]) {
    assert.equal(await new JsonlSessionStore({ dir }).appendMessageOnce(key, id, sensitive), false);
  }
  assert.equal(
    await new JsonlSessionStore({ dir }).appendMessageOnce(key, secondId, sensitive),
    true
  );
  assert.deepEqual((await restartedSnapshot(dir)).deliveryIds, [firstId, importedId, secondId]);
});
