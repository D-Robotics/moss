import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { openTelemetry } from '../src/telemetry.mjs';
test('telemetry persists and deduplicates samples', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-telemetry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'samples.jsonl');
  let store = openTelemetry(file);
  const sample = {
    id: 'a',
    deviceId: 'rdk-1',
    seq: 1,
    at: 100,
    metrics: { temperature: 90, cpu: 40, battery: 50 },
  };
  assert.deepEqual(store.ingest(sample), { accepted: true, duplicate: false });
  assert.deepEqual(store.ingest(sample), { accepted: false, duplicate: true });
  store = openTelemetry(file);
  assert.equal(store.count(), 1);
  assert.deepEqual(store.latest('rdk-1'), sample);
  assert.throws(() => store.ingest({ ...sample, seq: 2 }), { code: 'ID_CONFLICT' });
});
