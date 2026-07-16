import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DeviceSshSession } from '../dist/tools/device-ssh-session.js';
import { installFakeSsh } from './helpers/fake-ssh.mjs';

test('DeviceSshSession establishes one ControlMaster and reuses it for commands', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ssh-session-'));
  const binDir = path.join(dir, 'bin');
  const callsFile = path.join(dir, 'calls.log');
  await fs.mkdir(binDir);
  const fakeSsh = await installFakeSsh(binDir, {
    callsFile,
    responses: [
      { includes: 'echo first', stdout: 'first\n' },
      { includes: 'echo second', stdout: 'second\n' },
    ],
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const session = new DeviceSshSession({ host: '192.168.127.10', user: 'root', port: 22, ...fakeSsh });
  await session.connect();
  const [first, second] = await Promise.all([
    session.run('echo first', { timeout: 1_000 }),
    session.run('echo second', { timeout: 1_000 }),
  ]);
  await session.close();

  assert.equal(first.stdout.trim(), 'first');
  assert.equal(second.stdout.trim(), 'second');
  const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n');
  assert.equal(calls.filter((line) => line.includes('ControlMaster=yes')).length, 1);
  assert.equal(calls.filter((line) => line.includes('-O check')).length, 2);
  assert.equal(calls.filter((line) => line.includes('ControlPath=')).length, 6);
  assert.equal(calls.filter((line) => line.includes('-O exit')).length, 1);
  const paths = calls
    .map((line) => line.match(/ControlPath=([^ ]+)/)?.[1])
    .filter(Boolean);
  assert.equal(new Set(paths).size, 1, 'all operations must use the same control socket');
});

test('DeviceSshSession connects at most once when commands arrive concurrently', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ssh-session-race-'));
  const binDir = path.join(dir, 'bin');
  const callsFile = path.join(dir, 'calls.log');
  await fs.mkdir(binDir);
  const fakeSsh = await installFakeSsh(binDir, { callsFile });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const session = new DeviceSshSession({ host: 'rdk.local', user: 'sunrise', port: 22, ...fakeSsh });
  await Promise.all([
    session.run('true', { timeout: 1_000 }),
    session.run('uname -a', { timeout: 1_000 }),
    session.connect(),
  ]);
  await session.close();

  const calls = (await fs.readFile(callsFile, 'utf8')).trim().split('\n');
  assert.equal(calls.filter((line) => line.includes('ControlMaster=yes')).length, 1);
  assert.equal(calls.filter((line) => line.includes('-O check')).length, 2);
});

test('DeviceSshSession releases exit cleanup after a failed connection', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-ssh-session-fail-'));
  const binDir = path.join(dir, 'bin');
  await fs.mkdir(binDir);
  const fakeSsh = await installFakeSsh(binDir, { defaultExitCode: 255 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await fs.rm(dir, { recursive: true, force: true });
  });

  const before = process.listenerCount('exit');
  const session = new DeviceSshSession({ host: 'offline.local', user: 'root', port: 22, ...fakeSsh });
  assert.equal(process.listenerCount('exit'), before + 1);
  await assert.rejects(session.connect());
  await session.close();
  assert.equal(process.listenerCount('exit'), before);
});
