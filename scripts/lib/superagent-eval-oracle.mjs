import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { spawnProcess } from '../../dist/utils/run-process.js';
import { runGit } from '../../dist/utils/git-spawn.js';

export const CASES = ['telemetry', 'alerts', 'queue'];
const sample = (seq, patch = {}) => ({
  id: `e${seq}`,
  deviceId: 'rdk-1',
  seq,
  at: seq * 10,
  metrics: { temperature: 50, cpu: 40, battery: 50 },
  ...patch,
});
const rule = { metric: 'temperature', op: 'gte', open: 90, clear: 85, consecutive: 2 };
const job = (id, patch = {}) => ({
  id,
  key: `key-${id}`,
  type: 'notify',
  payload: { device: 'rdk-1' },
  ...patch,
});
const code = (fn, expected) => assert.throws(fn, { code: expected });

export async function runOracle(caseName, workspace) {
  if (!CASES.includes(caseName)) throw new Error('Unknown oracle case');
  const module = await import(
    pathToFileURL(path.join(workspace, 'src', `${caseName}.mjs`)).href + `?oracle=${Date.now()}`
  );
  const checks = [];
  const check = async (name, fn) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-operations-oracle-'));
    try {
      await fn(path.join(dir, 'nested', 'state'));
      checks.push({ name, passed: true });
    } catch (error) {
      checks.push({ name, passed: false, error: String(error.message).slice(0, 2500) });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
  if (caseName === 'telemetry') {
    const open = module.openTelemetry;
    await check('strict validation does not mutate state', (file) => {
      const s = open(file);
      code(() => open(file + 'x', { limit: 0 }), 'INVALID_LIMIT');
      for (const bad of [
        sample(-1),
        sample(0, { id: '' }),
        sample(0, { deviceId: '../bad' }),
        sample(0, { at: NaN }),
        sample(0, { metrics: { temperature: 201, cpu: 0, battery: 0 } }),
        sample(0, { metrics: { temperature: 20, cpu: 101, battery: 0 } }),
        sample(0, { metrics: { temperature: 20, cpu: 1, battery: -1 } }),
      ])
        code(() => s.ingest(bad), 'INVALID_SAMPLE');
      assert.equal(s.count(), 0);
      assert.equal(s.latest('missing'), null);
    });
    await check('global normalized deduplication survives eviction and restart', async (file) => {
      let s = open(file, { limit: 2 });
      const a = sample(1);
      assert.deepEqual(s.ingest(a), { accepted: true, duplicate: false });
      assert.deepEqual(
        s.ingest({ ...a, extra: 'ignored', metrics: { battery: 50, cpu: 40, temperature: 50 } }),
        { accepted: false, duplicate: true }
      );
      s.ingest(sample(2));
      s.ingest(sample(3));
      s = open(file, { limit: 2 });
      assert.deepEqual(s.ingest(a), { accepted: false, duplicate: true });
      code(() => s.ingest({ ...a, deviceId: 'rdk-2' }), 'ID_CONFLICT');
      assert.equal(s.count(), 3);
      assert.equal((await fs.readFile(file, 'utf8')).trim().split('\n').length, 3);
    });
    await check('out-of-order window and ties are deterministic', (file) => {
      const s = open(file, { limit: 3 });
      for (const x of [
        sample(3),
        sample(1),
        sample(4, { id: 'z' }),
        sample(2),
        sample(4, { id: 'a' }),
      ])
        s.ingest(x);
      assert.deepEqual(
        s.history('rdk-1').map((x) => x.id),
        ['e3', 'a', 'z']
      );
      assert.equal(s.latest('rdk-1').id, 'z');
      assert.equal(s.count(), 5);
      s.ingest(sample(9, { deviceId: 'rdk-2' }));
      assert.equal(s.latest('rdk-1').id, 'z');
    });
    await check('input/result aliasing cannot rewrite persisted samples', (file) => {
      const s = open(file);
      const a = sample(1);
      s.ingest(a);
      a.metrics.cpu = 99;
      s.latest('rdk-1').metrics.cpu = 88;
      s.history('rdk-1')[0].seq = 999;
      assert.equal(s.latest('rdk-1').metrics.cpu, 40);
      assert.equal(open(file).latest('rdk-1').seq, 1);
    });
    await check(
      'partial tail is removed before append; corrupt complete lines fail closed',
      async (file) => {
        let s = open(file);
        s.ingest(sample(1));
        await fs.appendFile(file, '{"id":"interrupted');
        s = open(file);
        assert.equal(s.count(), 1);
        s.ingest(sample(2));
        assert.equal(open(file).count(), 2);
        await fs.appendFile(file, '{broken}\n');
        code(() => open(file), 'CORRUPT_LOG');
      }
    );
  } else if (caseName === 'alerts') {
    const open = module.openAlerts;
    const observe = (engine, seq, value, deviceId = 'rdk-1') =>
      engine.observe({ deviceId, seq, metrics: { temperature: value } });
    await check('rules and samples validate before changing a cursor', (file) => {
      for (const rules of [
        [],
        [{ ...rule, clear: 91 }],
        [{ ...rule, consecutive: 0 }],
        [rule, rule],
      ])
        code(() => open(file, rules), 'INVALID_RULES');
      const a = open(file, [rule]);
      code(() => a.observe({ deviceId: 'rdk-1', seq: 1, metrics: {} }), 'INVALID_SAMPLE');
      assert.deepEqual(observe(a, 1, 91), []);
      assert.equal(observe(a, 2, 92).length, 1);
    });
    await check('streaks, hysteresis and stale samples', (file) => {
      const a = open(file, [rule]);
      observe(a, 1, 91);
      observe(a, 2, 87);
      observe(a, 3, 91);
      assert.deepEqual(observe(a, 3, 92), []);
      assert.deepEqual(observe(a, 2, 99), []);
      const opened = observe(a, 4, 93);
      assert.deepEqual(opened, [
        {
          id: 'rdk-1:temperature:opened:4',
          deviceId: 'rdk-1',
          metric: 'temperature',
          type: 'opened',
          seq: 4,
          value: 93,
        },
      ]);
      assert.deepEqual(observe(a, 5, 99), []);
      observe(a, 6, 84);
      observe(a, 7, 87);
      observe(a, 8, 85);
      assert.equal(observe(a, 9, 84)[0].type, 'cleared');
      assert.deepEqual(a.active(), []);
    });
    await check('low threshold and independent device/metric state', (file) => {
      const a = open(file, [
        rule,
        { metric: 'battery', op: 'lte', open: 15, clear: 20, consecutive: 2 },
      ]);
      for (const seq of [1, 2])
        a.observe({ deviceId: 'b', seq, metrics: { temperature: 91, battery: 14 } });
      assert.deepEqual(a.active(), [
        { deviceId: 'b', metric: 'battery' },
        { deviceId: 'b', metric: 'temperature' },
      ]);
      a.observe({ deviceId: 'a', seq: 1, metrics: { temperature: 20, battery: 10 } });
      assert.equal(a.active().length, 2);
      for (const seq of [3, 4])
        a.observe({ deviceId: 'b', seq, metrics: { temperature: 88, battery: 20 } });
      assert.deepEqual(a.active(), [{ deviceId: 'b', metric: 'temperature' }]);
    });
    await check('streak/outbox/acks survive reopening without duplicate transitions', (file) => {
      let a = open(file, [rule]);
      observe(a, 1, 91);
      a = open(file, [rule]);
      const [event] = observe(a, 2, 92);
      assert.ok(event);
      a = open(file, [rule]);
      assert.deepEqual(observe(a, 2, 92), []);
      assert.equal(a.pending().length, 1);
      a.pending()[0].type = 'forged';
      assert.equal(a.pending()[0].type, 'opened');
      assert.equal(a.ack('unknown'), false);
      assert.equal(a.ack(event.id), true);
      assert.equal(a.ack(event.id), false);
      assert.equal(open(file, [rule]).pending().length, 0);
      code(() => open(file, [{ ...rule, open: 95 }]), 'RULES_CONFLICT');
    });
    await check('rules are copied and corruption is never silently erased', async (file) => {
      const rules = [{ ...rule }];
      const a = open(file, rules);
      rules[0].open = 150;
      observe(a, 1, 91);
      assert.equal(observe(a, 2, 91).length, 1);
      await fs.writeFile(file, '{bad');
      code(() => open(file, [rule]), 'CORRUPT_STATE');
    });
  } else {
    const open = module.openQueue;
    await check('idempotency uses normalized content and protects ID ownership', (file) => {
      let q = open(file);
      assert.equal(q.enqueue(job('a', { payload: { x: 1, y: 2 } })), 'a');
      assert.equal(q.enqueue(job('b', { key: 'key-a', payload: { y: 2, x: 1 } })), 'a');
      code(() => q.enqueue(job('c', { key: 'key-a' })), 'KEY_CONFLICT');
      code(() => q.enqueue(job('a', { key: 'another' })), 'ID_CONFLICT');
      q = open(file);
      assert.equal(q.enqueue(job('b', { key: 'key-a', payload: { y: 2, x: 1 } })), 'a');
      assert.equal(q.stats().queued, 1);
    });
    await check('invalid jobs never partially enqueue', (file) => {
      const q = open(file);
      for (const j of [
        job(''),
        job('a', { maxAttempts: 0 }),
        job('a', { dependsOn: ['missing'] }),
        job('a', { dependsOn: ['a'] }),
        job('a', { payload: null }),
      ])
        code(() => q.enqueue(j), 'INVALID_JOB');
      assert.deepEqual(q.stats(), { queued: 0, running: 0, done: 0, dead: 0 });
      code(() => q.claim('', 0, 100), 'INVALID_CLAIM');
      code(() => q.claim('w', -1, 100), 'INVALID_CLAIM');
    });
    await check('FIFO, dependencies, leases and fencing remain correct after restart', (file) => {
      let q = open(file);
      q.enqueue(job('a'));
      q.enqueue(job('b', { dependsOn: ['a'] }));
      q.enqueue(job('c'));
      const a = q.claim('w1', 0, 100);
      assert.equal(a.id, 'a');
      assert.equal(q.claim('w2', 1, 100).id, 'c');
      assert.equal(q.claim('w3', 2, 100), null);
      q = open(file);
      const renewed = q.claim('w2', 100, 100);
      assert.equal(renewed.id, 'a');
      assert.notEqual(renewed.token, a.token);
      assert.equal(renewed.attempts, 2);
      code(() => q.complete('a', a.token, {}, 101), 'STALE_LEASE');
      q.complete('a', renewed.token, { ok: true }, 101);
      assert.equal(q.claim('w3', 102, 100).id, 'b');
      assert.equal(open(file).get('a').status, 'done');
    });
    await check('backoff and exhausted/expired leases cannot run forever', (file) => {
      let q = open(file);
      q.enqueue(job('a', { maxAttempts: 2 }));
      const a = q.claim('w', 0, 10);
      q.fail('a', a.token, 'try again', 1);
      assert.equal(q.get('a').notBefore, 101);
      assert.equal(q.claim('w', 100, 10), null);
      const b = q.claim('w', 101, 10);
      assert.equal(b.attempts, 2);
      code(() => q.complete('a', b.token, {}, 111), 'STALE_LEASE');
      assert.equal(q.claim('w2', 111, 10), null);
      assert.equal(q.get('a').status, 'dead');
      q = open(file);
      assert.equal(q.claim('w3', 1000, 10), null);
      assert.deepEqual(q.stats(), { queued: 0, running: 0, done: 0, dead: 1 });
    });
    await check(
      'payload/result aliases and corrupt files cannot mutate durable state',
      async (file) => {
        let q = open(file);
        const input = job('a');
        q.enqueue(input);
        input.payload.device = 'bad';
        const a = q.claim('w', 0, 100);
        a.payload.device = 'bad';
        const result = { nested: { ok: true } };
        q.complete('a', a.token, result, 1);
        result.nested.ok = false;
        q.get('a').result.nested.ok = false;
        q = open(file);
        assert.equal(q.get('a').payload.device, 'rdk-1');
        assert.equal(q.get('a').result.nested.ok, true);
        await fs.writeFile(file, '{bad');
        code(() => open(file), 'CORRUPT_STATE');
      }
    );
  }
  return { case: caseName, passed: checks.length === 5 && checks.every((x) => x.passed), checks };
}

export function selectMandateCase(controller, workspace) {
  const match = /^superagent-([a-f0-9]+)$/.exec(path.basename(workspace));
  if (!match) throw new Error('Not a ticket workspace');
  const db = new DatabaseSync(path.join(controller, '.moss', 'superagent', 'state.sqlite'), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare('SELECT value FROM records WHERE kind=? AND key=?')
      .get('ticket', match[1]);
    const ticket = row ? JSON.parse(String(row.value)) : undefined;
    if (!ticket || path.resolve(ticket.execution.directory) !== path.resolve(workspace))
      throw new Error('Ticket binding mismatch');
    const id = /^\[case:(telemetry|alerts|queue)\]/.exec(ticket.mandate.scope)?.[1];
    if (!id) throw new Error('No fixed case in mandate');
    return id;
  } finally {
    db.close();
  }
}

export async function integrationOracle(workspace) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-operations-http-'));
  let child;
  const start = async () => {
    child = spawnProcess(process.execPath, [path.join(workspace, 'server.mjs')], {
      cwd: workspace,
      env: { PATH: process.env.PATH, PORT: '0', OPS_DATA_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stderr.on('data', (part) => {
      errors += part;
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Server exited: ' + errors.slice(-1000)));
      });
      child.stdout.on('data', (part) => {
        output += part;
        const line = output.split('\n').find((x) => x.startsWith('{'));
        if (line) {
          try {
            const row = JSON.parse(line);
            if (row.port) {
              clearTimeout(timer);
              resolve(row.port);
            }
          } catch {}
        }
      });
    });
    return async (route, body, expected = 200) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, expected, route);
      return response.json();
    };
  };
  const stop = async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    await exited;
    clearTimeout(timer);
  };
  try {
    let api = await start();
    assert.deepEqual(await api('/health'), { ok: true });
    const first = sample(1, { metrics: { temperature: 91, cpu: 40, battery: 50 } });
    await Promise.all(Array.from({ length: 8 }, () => api('/samples', first)));
    await api('/samples', sample(2, { metrics: { temperature: 92, cpu: 40, battery: 50 } }));
    await api('/samples', { ...first, at: 999 }, 409);
    assert.equal((await api('/devices/rdk-1')).total, 2);
    assert.equal((await api('/alerts')).active.length, 1);
    assert.deepEqual(await api('/jobs/stats'), { queued: 1, running: 0, done: 0, dead: 0 });
    const leased = await api('/jobs/claim', { worker: 'w1', now: 0, leaseMs: 100 });
    await stop();
    api = await start();
    await api('/samples', first);
    const renewed = await api('/jobs/claim', { worker: 'w2', now: 100, leaseMs: 100 });
    assert.equal(renewed.id, leased.id);
    assert.notEqual(renewed.token, leased.token);
    await api(
      `/jobs/${encodeURIComponent(leased.id)}/complete`,
      { token: leased.token, now: 101, result: {} },
      409
    );
    await api(`/jobs/${encodeURIComponent(renewed.id)}/complete`, {
      token: renewed.token,
      now: 101,
      result: { sent: true },
    });
    for (const seq of [3, 4])
      await api('/samples', sample(seq, { metrics: { temperature: 84, cpu: 40, battery: 50 } }));
    const cleared = await api('/jobs/claim', { worker: 'w3', now: 102, leaseMs: 100 });
    assert.equal(cleared.payload.type, 'cleared');
    await api(`/jobs/${encodeURIComponent(cleared.id)}/complete`, {
      token: cleared.token,
      now: 103,
      result: { sent: true },
    });
    await stop();
    api = await start();
    assert.equal((await api('/devices/rdk-1')).latest.seq, 4);
    assert.deepEqual((await api('/alerts')).active, []);
    assert.deepEqual(await api('/jobs/stats'), { queued: 0, running: 0, done: 2, dead: 0 });
    return { passed: true, notifications: 2, duplicateRequests: 8, serverRestarts: 2 };
  } finally {
    await stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Generated business code needs no model credentials, even inside the acceptance process.
  for (const key of Object.keys(process.env))
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) delete process.env[key];
  const args = process.argv.slice(2);
  const controller = args[0] === '--controller' ? args[1] : undefined;
  try {
    const selected = controller ? selectMandateCase(controller, process.cwd()) : args[1];
    if (!CASES.includes(selected)) throw new Error('Unknown oracle case');
    const changed = await runGit(['diff', '--name-only', 'HEAD'], {
      cwd: process.cwd(),
      readOnly: true,
    });
    const untracked = await runGit(['ls-files', '--others', '--exclude-standard'], {
      cwd: process.cwd(),
      readOnly: true,
    });
    const paths = (changed.stdout + '\n' + untracked.stdout)
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
    if (paths.some((file) => file !== `src/${selected}.mjs`))
      throw new Error('SCOPE_VIOLATION: only the assigned module may change: ' + paths.join(', '));
    const result = await runOracle(selected, process.cwd());
    console.log(JSON.stringify(result));
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ passed: false, error: String(error.message).slice(0, 1000) }));
    process.exitCode = 1;
  }
}
