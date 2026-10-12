import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { acquireSessionWriteLock } from '../dist/core/session/session-write-lock.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const owner = (pid, token) =>
  JSON.stringify({ version: 1, pid, token, createdAt: new Date(0).toISOString() });

test('two dead-gate reclaimers cannot replace the winner with a delayed rename', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-gate-race-'));
  const sessionFile = path.join(dir, 'one.jsonl');
  const recoveryPath = `${sessionFile}.lock.recovery`;
  const originalRename = fs.rename;
  const originalLink = fs.link;
  const paused = deferred();
  const resume = deferred();
  const deniedClaim = deferred();
  let gated = false;
  let first;
  let second;
  let firstLock;
  let secondLock;
  let timer;
  try {
    await fs.writeFile(recoveryPath, owner(2_147_483_647, 'dead-gate-generation-0001'));
    fs.rename = async function (from, to) {
      if (String(from) === recoveryPath && !gated) {
        gated = true;
        paused.resolve();
        await resume.promise;
      }
      return originalRename.call(this, from, to);
    };
    fs.link = async function (from, to) {
      try {
        return await originalLink.call(this, from, to);
      } catch (error) {
        if (String(to).startsWith(`${recoveryPath}.reclaim-`) && error.code === 'EEXIST')
          deniedClaim.resolve('denied-claim');
        throw error;
      }
    };
    syncBuiltinESMExports();
    first = acquireSessionWriteLock({ sessionFile, timeoutMs: 5000 });
    await paused.promise;
    second = acquireSessionWriteLock({ sessionFile, timeoutMs: 5000 });
    const raced = await Promise.race([
      deniedClaim.promise,
      second.then((lock) => {
        secondLock = lock;
        return 'stole-gate';
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 3500);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(raced, 'denied-claim', 'the second reclaimer must lose the generation claim');
    assert.equal(JSON.parse(await fs.readFile(recoveryPath, 'utf8')).pid, 2_147_483_647);
    resume.resolve();
    clearTimeout(timer);
    firstLock = await first;
    const live = JSON.parse(await fs.readFile(`${sessionFile}.lock`, 'utf8'));
    assert.equal(live.pid, process.pid);
    assert.equal(
      secondLock,
      undefined,
      'a second writer cannot enter while the winner holds its lock'
    );
    await firstLock.release();
    firstLock = undefined;
    secondLock = await second;
    await secondLock.release();
    secondLock = undefined;
    assert.equal(
      (await fs.readdir(dir)).some((name) => name.includes('.reclaim-')),
      false
    );
  } finally {
    resume.resolve();
    fs.rename = originalRename;
    fs.link = originalLink;
    syncBuiltinESMExports();
    if (first && !firstLock) firstLock = await first.catch(() => undefined);
    await firstLock?.release().catch(() => {});
    if (second && !secondLock) secondLock = await second.catch(() => undefined);
    await secondLock?.release().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const state of ['unknown', 'live', 'dead']) {
  test(`a stranded ${state} recovery claim fails closed without deletion`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-gate-claim-'));
    const sessionFile = path.join(dir, 'one.jsonl');
    const recoveryPath = `${sessionFile}.lock.recovery`;
    const token = 'dead-gate-generation-0001';
    const claimPath = `${recoveryPath}.reclaim-${crypto.createHash('sha256').update(token).digest('hex')}`;
    const claim =
      state === 'unknown'
        ? 'unverified'
        : owner(state === 'live' ? process.pid : 2_147_483_647, 'stranded-claim-token-0001');
    try {
      await fs.writeFile(recoveryPath, owner(2_147_483_647, token));
      await fs.writeFile(claimPath, claim);
      await assert.rejects(
        acquireSessionWriteLock({ sessionFile, timeoutMs: 150 }),
        /获取会话写锁超时或失败/
      );
      assert.equal(await fs.readFile(claimPath, 'utf8'), claim);
      assert.equal(JSON.parse(await fs.readFile(recoveryPath, 'utf8')).token, token);
      await assert.rejects(fs.access(`${sessionFile}.lock`), { code: 'ENOENT' });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
