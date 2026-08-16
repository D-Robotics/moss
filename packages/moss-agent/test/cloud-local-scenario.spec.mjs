import assert from 'node:assert/strict';
import test from 'node:test';

import { runCloudLocalScenario } from '../../../scripts/lib/cloud-local-scenario.mjs';

test('reconciles local and cloud evidence after an observable retryable failure', async () => {
  const result = await runCloudLocalScenario();

  assert.equal(result.ok, true);
  assert.equal(result.cloudAttempts, 2);
  assert.equal(result.run.status, 'completed');
  assert.equal(result.run.verification, 'unverified');
  assert.deepEqual(
    result.evidence.map(({ type }) => type),
    ['tool.succeeded', 'tool.failed', 'tool.succeeded', 'tool.succeeded']
  );
  assert.match(result.final, /CLOUD_LOCAL_COMPLETE/);
  assert.ok(result.trace.some((entry) => entry.phase === 'recovery-decision'));
});

test('rejects a cloud attestation that disagrees with the local artifact', async () => {
  const result = await runCloudLocalScenario({ cloudDigestMismatch: true });

  assert.equal(result.ok, true);
  assert.equal(result.cloudAttempts, 2);
  assert.match(result.final, /CLOUD_LOCAL_REJECTED/);
  assert.doesNotMatch(result.final, /CLOUD_LOCAL_COMPLETE/);
  assert.deepEqual(
    result.evidence.map(({ type }) => type),
    ['tool.succeeded', 'tool.failed', 'tool.succeeded', 'tool.failed']
  );
  assert.ok(result.trace.some((entry) => entry.outcome === 'CLOUD_LOCAL_REJECTED'));
});
