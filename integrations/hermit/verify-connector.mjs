/** Executable boundary probe; fixture output is never an upstream training result. Build first. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hermit-supervisor-')));
const { runHermitWorker, probeHermitWorker, HERMIT_WORKER_PIN } = await import(
  pathToFileURL(path.resolve('dist/core/rsi/hermit-worker.js')).href
);
const { spawnProcess } = await import(
  pathToFileURL(path.resolve('dist/utils/run-process.js')).href
);
const python = process.env.HERMIT_PYTHON;
assert(python, 'Set HERMIT_PYTHON to the optional Python executable');
const workerPath = path.join(root, 'fixture.py');
await fs.mkdir(path.join(root, 'input'));
await fs.writeFile(path.join(root, 'input/run.yaml'), 'fixture: true\n');
const configSha256 = createHash('sha256').update('fixture: true\n').digest('hex');
const base = {
  python,
  workerPath,
  sourceRoot: root,
  jobDir: root,
  configSha256,
  trainingTokenLimit: 100,
  bridgeUrl: 'http://127.0.0.1:12345',
  bridgeToken: 'job-capability',
  timeoutMs: 2000,
  revoke() {},
};
const identity = {
  hermitCommit: HERMIT_WORKER_PIN.commit,
  hermitVersion: HERMIT_WORKER_PIN.version,
  gepaCommit: HERMIT_WORKER_PIN.gepaCommit,
};
const result = {
  ...identity,
  method: 'gepa',
  runId: 'fixture-only',
  finalCommit: 'a'.repeat(40),
  instructions: 'text',
  instructionsSha256: createHash('sha256').update('text').digest('hex'),
  summarySha256: 'b'.repeat(64),
  steps: [1, 2].map((step) => ({ step, status: 'done', commits: ['c'.repeat(40)] })),
};
async function fixture(body) {
  await fs.writeFile(workerPath, body);
}
try {
  await fixture(
    `import json\nprint(json.dumps(${JSON.stringify(JSON.stringify(result))} and json.loads(${JSON.stringify(JSON.stringify(result))})))\n`
  );
  assert.equal((await runHermitWorker(base)).instructions, 'text');
  await assert.rejects(
    runHermitWorker({ ...base, bridgeUrl: 'https://example.com' }),
    /hermit_bridge_invalid/
  );
  await assert.rejects(
    runHermitWorker({ ...base, configSha256: '0'.repeat(64) }),
    /hermit_config_digest_mismatch/
  );
  await fixture(
    `import json\nprint(json.dumps(json.loads(${JSON.stringify(JSON.stringify({ ...result, instructionsSha256: '0'.repeat(64) }))})))\n`
  );
  await assert.rejects(runHermitWorker(base), /hermit_worker_result_invalid/);
  let revoked = false;
  await fixture('import sys\nsys.stdout.write("x" * 1100000)\nsys.stdout.flush()\n');
  await assert.rejects(
    runHermitWorker({
      ...base,
      revoke() {
        revoked = true;
      },
    }),
    /hermit_worker_output_limit/
  );
  assert(revoked);
  if (process.platform !== 'win32') {
    const sentinel = spawnProcess(python, ['-c', 'import time; time.sleep(20)'], {
      stdio: 'ignore',
    });
    try {
      const pidfile = path.join(root, 'owned.pid');
      // TERM produces a valid but late result while its descendant ignores TERM.
      await fixture(
        `import os, signal, time\ndef late(*args):\n print(${JSON.stringify(JSON.stringify(result))}, flush=True)\n os._exit(0)\nsignal.signal(signal.SIGTERM, late)\npid = os.fork()\nif pid == 0:\n signal.signal(signal.SIGTERM, signal.SIG_IGN)\n time.sleep(20)\n os._exit(0)\nopen(${JSON.stringify(pidfile)}, 'w').write(str(os.getpid()) + ',' + str(pid))\ntime.sleep(20)\n`
      );
      const control = new AbortController();
      revoked = false;
      const pending = assert.rejects(
        runHermitWorker({
          ...base,
          signal: control.signal,
          revoke() {
            revoked = true;
          },
        }),
        /hermit_worker_cancelled/
      );
      for (let i = 0; i < 100; i++) {
        try {
          await fs.stat(pidfile);
          break;
        } catch {
          await delay(10);
        }
      }
      const [pid, descendant] = (await fs.readFile(pidfile, 'utf8')).split(',').map(Number);
      control.abort();
      await pending;
      assert(revoked);
      assert.throws(
        () => process.kill(pid, 0),
        (error) => error.code === 'ESRCH'
      );
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(descendant, 0);
        } catch {
          break;
        }
        await delay(10);
      }
      assert.throws(
        () => process.kill(descendant, 0),
        (error) => error.code === 'ESRCH'
      );
      assert.doesNotThrow(
        () => process.kill(sentinel.pid, 0),
        'unrelated owned sentinel survives group cancellation'
      );
    } finally {
      sentinel.kill('SIGKILL');
    }
  }
  const capability = {
    ...identity,
    available: false,
    reasons: ['fixture'],
    trainerApi: true,
    pythonVersion: 'fixture',
    platform: process.platform,
    template: 'prompt-only@1.0',
    evolvers: {
      codex: { available: false, reasons: ['fixture'] },
      gepa: { available: false, reasons: ['fixture'] },
    },
  };
  await fixture(`print(${JSON.stringify(JSON.stringify(capability))})\n`);
  assert.equal((await probeHermitWorker(base)).available, false);
  console.log(
    'PASS: connector contract, digest, loopback, overflow, cancellation and owned group cleanup (fixtures only)'
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
