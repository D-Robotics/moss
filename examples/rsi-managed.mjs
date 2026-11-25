#!/usr/bin/env node
// Actual offline managed-package selection, durable cache, and native adoption.
// No model/network calls or learning-gain claim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  RsiManagedAdapterStore,
  RsiEngine,
  MossAgent,
  InMemorySessionStore,
  rsiAdapterDigest,
  rsiDigest,
  rsiManagedTaskScopeDigest,
  rsiTaskScopeDigest,
  selectRsiManagedCandidate,
} from '../dist/index.js';
import {
  createRsiManagedEnvelope,
  verifyRsiManagedEnvelope,
} from '@rdk-moss/agent/rsi-managed-package';
import { canonicalRsiSharedJson } from '@rdk-moss/agent/rsi-shared';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-managed-')));
const keys = generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const trust = { registryId: 'managed-example', publicKeys: { publisher: publicKey } };
const scope = { ownerKey: 'account-a', environment: 'test' };
const other = { ownerKey: 'account-b', environment: 'test' };
let now = Date.now();
const targetA = { platformId: 'platform-a', modelId: 'offline-a' };
const targetB = { platformId: 'platform-b', modelId: 'offline-b' };
const context = {
  profile: 'studio-development',
  profileVersion: '1',
  gateway: {
    mode: 'manual',
    contractVersion: 'lease-v1',
    selectionId: 'platform-a-chat',
    ...targetA,
  },
  tools: ['read', 'write', 'shell'],
  cohort: 30,
  taskScope: {
    projectId: 'receiver-project',
    repositoryRevision: 'a'.repeat(40),
    taskFamily: 'studio-development',
    taskFamilyVersion: '1',
    capabilitiesDigest: rsiDigest('real-tools'),
  },
};
const packageFor = (version, targets = [targetA, targetB], extra = {}) => {
  const adapter = {
    id: 'managed-development',
    version,
    instructions:
      'Read relevant files before editing. Preserve unrelated changes. OFFLINE_MANAGED_APPLIED.',
  };
  return createRsiManagedEnvelope(
    {
      kind: 'rsi-managed-package',
      schemaVersion: 2,
      registryId: trust.registryId,
      packageId: 'development-guidance',
      version,
      channel: 'stable',
      source: 'curated',
      publishedAt: now,
      summary: 'Human-reviewed offline compatibility proof, no learning claim.',
      adapter: { ...adapter, digest: rsiAdapterDigest(adapter) },
      compatibility: {
        sdkApiVersion: 2,
        profiles: [{ id: context.profile, version: '1' }],
        targets,
        gatewayContractVersions: ['lease-v1'],
        requiredTools: ['read'],
        forbiddenTools: ['delete-device'],
        allowAdditionalTools: true,
        ...extra,
      },
    },
    'publisher',
    privateKey
  );
};
const pkg = packageFor('1.0.0');
const manifestFor = (
  revision,
  entries = [
    {
      policyId: 'development-default',
      packageDigest: pkg.digest,
      priority: 10,
      rolloutPercent: 100,
    },
  ],
  extra = {}
) =>
  createRsiManagedEnvelope(
    {
      kind: 'rsi-managed-manifest',
      schemaVersion: 2,
      registryId: trust.registryId,
      revision,
      issuedAt: now,
      expiresAt: now + 300_000,
      enabled: true,
      entries,
      revokedDigests: [],
      ...extra,
    },
    'publisher',
    privateKey
  );
const manifest = manifestFor(1);
const store = new RsiManagedAdapterStore(root, { now: () => now });
const select = (overrides = {}) =>
  store.select(scope, { trust, context: { ...context, ...overrides } });
try {
  const deviceScope = {
    kind: 'device-binding',
    projectId: 'registered-board-project',
    deviceId: 'actual-x5',
    bindingRevision: rsiDigest('registered-device-binding-v1'),
    capabilitiesDigest: rsiDigest('actual-readonly-tools'),
  };
  const deviceDigest = rsiManagedTaskScopeDigest(deviceScope);
  assert.match(deviceDigest, /^[a-f0-9]{64}$/);
  assert.throws(() => rsiTaskScopeDigest(deviceScope), /invalid_training_shape/);
  assert.throws(() =>
    rsiManagedTaskScopeDigest({ ...deviceScope, repositoryRevision: 'a'.repeat(40) })
  );
  assert.throws(() =>
    rsiManagedTaskScopeDigest({ ...deviceScope, bindingRevision: 'a'.repeat(40) })
  );
  assert.notEqual(
    deviceDigest,
    rsiManagedTaskScopeDigest({ ...deviceScope, deviceId: 'other-x5' })
  );
  assert.notEqual(
    deviceDigest,
    rsiManagedTaskScopeDigest({ ...deviceScope, bindingRevision: 'b'.repeat(64) })
  );
  assert.equal(select().reason, 'cache_cold');
  assert.equal(verifyRsiManagedEnvelope(pkg, trust, now).digest, pkg.digest);
  const tampered = structuredClone(pkg);
  tampered.payload.summary = 'Altered publisher text';
  assert.throws(
    () => store.sync(scope, { trust, manifest, packages: [tampered] }),
    /digest_mismatch/
  );
  const wrongDomain = {
    ...pkg,
    signature: sign(
      null,
      Buffer.from(
        'moss-rsi-shared/v1\0' + canonicalRsiSharedJson({ keyId: pkg.keyId, payload: pkg.payload })
      ),
      keys.privateKey
    ).toString('base64'),
  };
  assert.throws(() => verifyRsiManagedEnvelope(wrongDomain, trust), /signature_invalid/);
  assert.throws(
    () => verifyRsiManagedEnvelope({ ...pkg, schemaVersion: 1 }, trust),
    /unsupported_envelope/
  );
  store.sync(scope, { trust, manifest, packages: [] });
  assert.equal(
    select().reason,
    'cache_cold',
    'Manifest checkpoint does not select a missing package'
  );
  store.sync(scope, { trust, manifest, packages: [pkg] });
  assert.equal(select().reason, 'selected', 'No per-project install or adopt step');
  assert.equal(
    store.select(other, { trust, context }).reason,
    'cache_cold',
    'Owner cache remains isolated'
  );
  assert.equal(select({ gateway: undefined }).reason, 'gateway_identity_unresolved');
  assert.equal(
    select({ gateway: { ...context.gateway, platformId: 'other-platform' } }).reason,
    'model_incompatible'
  );
  assert.equal(select({ tools: ['write'] }).reason, 'capability_mismatch');
  assert.equal(select({ tools: ['read', 'delete-device'] }).reason, 'capability_mismatch');
  assert.equal(select({ profile: 'unknown' }).reason, 'task_profile_unsupported');
  const auto = {
    mode: 'auto',
    contractVersion: 'lease-v1',
    routeId: 'moss-route',
    targets: [targetA, targetB],
    bounded: true,
  };
  assert.equal(select({ gateway: auto }).reason, 'selected');
  assert.equal(
    select({ gateway: { ...auto, targets: [targetA, { ...targetB, modelId: 'unknown' }] } }).reason,
    'model_incompatible'
  );
  assert.equal(
    select({ gateway: { ...auto, bounded: false } }).reason,
    'gateway_identity_unresolved'
  );
  assert.equal(select({ gateway: { ...auto, targets: [] } }).reason, 'gateway_identity_unresolved');
  const selected = select().selection;
  assert.equal(selected.receipt.managed.gateway.selectionId, context.gateway.selectionId);
  assert.equal(selected.receipt.registry.packageDigest, pkg.digest);
  const reopened = new RsiManagedAdapterStore(root, { now: () => now });
  assert.equal(reopened.select(scope, { trust, context }).packageDigest, pkg.digest);

  const boardScope = { ...scope, ownerKey: 'board-owner' };
  const boardPackage = packageFor('2.0.0', [targetA, targetB], {
    profiles: [{ id: 'board-readonly-diagnostics', version: '1' }],
    boardPlatforms: ['rdk-x5'],
    requiredTools: ['device_file_read'],
  });
  const boardManifest = manifestFor(1, [
    {
      policyId: 'board-default',
      packageDigest: boardPackage.digest,
      priority: 10,
      rolloutPercent: 100,
    },
  ]);
  store.sync(boardScope, { trust, manifest: boardManifest, packages: [boardPackage] });
  const boardContext = {
    ...context,
    profile: 'board-readonly-diagnostics',
    boardPlatform: 'rdk-x5',
    tools: ['device_file_read'],
    taskScope: deviceScope,
  };
  const boardSelected = store.select(boardScope, { trust, context: boardContext });
  assert.equal(boardSelected.reason, 'selected');
  assert.equal(boardSelected.selection.receipt.taskScopeDigest, deviceDigest);
  for (const invalidContext of [
    { ...boardContext, profile: 'studio-development' },
    { ...boardContext, boardPlatform: undefined },
  ]) {
    assert.throws(
      () =>
        selectRsiManagedCandidate(
          boardManifest.payload,
          [{ digest: boardPackage.digest, package: boardPackage.payload }],
          invalidContext
        ),
      /device_scope_profile/
    );
    const fallback = store.select(boardScope, { trust, context: invalidContext });
    assert.equal(
      fallback.selection,
      undefined,
      'An invalid device scope never injects a candidate'
    );
    assert.equal(fallback.reason, 'gateway_identity_unresolved');
  }

  // Actual Moss native loop proves injection and receipt, not just selection intent.
  const engine = new RsiEngine({ rootDir: root });
  const observer = engine.createRunObserver({
    scope,
    runId: 'managed-native',
    adapter: selected,
    model: 'offline-a',
  });
  assert(observer);
  const agent = new MossAgent({
    model: 'offline-a',
    domainPrompt: false,
    sessionStore: new InMemorySessionStore(),
    llmProvider: {
      id: 'offline-a',
      capabilities: { streaming: false },
      async complete(request) {
        assert(request.systemPrompt.includes(pkg.payload.adapter.instructions));
        return {
          stopReason: 'end_turn',
          content: [{ type: 'text', text: 'OFFLINE_MANAGED_APPLIED' }],
        };
      },
    },
    onAgentLoopEvent(event, identity) {
      if (identity.runId === 'managed-native') observer.onEvent(event);
    },
  });
  try {
    const result = await agent.chat('managed-session', 'Reply once.', {
      runId: 'managed-native',
      taskFlow: false,
      harnessAdapter: selected.harnessAdapter,
    });
    assert.equal(result.response, 'OFFLINE_MANAGED_APPLIED');
    observer.finish('completed');
    assert.equal(
      engine.getRun(scope, 'managed-native').adapter.managed.policyId,
      'development-default'
    );
  } finally {
    await agent.close({ stopBackgroundProcesses: false });
  }

  // Same-revision renewal is legal, content forks and old revisions are not.
  now += 1;
  store.sync(scope, { trust, manifest: manifestFor(1), packages: [] });
  assert.throws(
    () =>
      store.sync(scope, { trust, manifest: manifestFor(1, [], { enabled: false }), packages: [] }),
    /index_fork/
  );
  const ambiguous = [
    { policyId: 'one', packageDigest: pkg.digest, priority: 10, rolloutPercent: 100 },
    { policyId: 'two', packageDigest: pkg.digest, priority: 10, rolloutPercent: 100 },
  ];
  store.sync(scope, { trust, manifest: manifestFor(2, ambiguous), packages: [] });
  assert.equal(select().reason, 'policy_ambiguous');
  assert.throws(() => store.sync(scope, { trust, manifest, packages: [] }), /index_rollback/);
  const changed = structuredClone(pkg.payload);
  changed.summary += ' changed';
  const conflicting = createRsiManagedEnvelope(changed, 'publisher', privateKey);
  assert.throws(
    () =>
      store.sync(scope, {
        trust,
        manifest: manifestFor(3, [{ ...ambiguous[0], packageDigest: conflicting.digest }]),
        packages: [conflicting],
      }),
    /version_conflict/
  );
  store.sync(scope, {
    trust,
    manifest: manifestFor(3, [{ ...ambiguous[0], rolloutPercent: 10 }]),
    packages: [],
  });
  assert.equal(select().reason, 'rollout_excluded');
  now += 300_000;
  assert.equal(select().reason, 'index_expired');
  now += 1;
  store.sync(scope, {
    trust,
    manifest: manifestFor(4, [], { revokedDigests: [pkg.digest] }),
    packages: [],
  });
  assert.equal(select().reason, 'package_revoked');
  const replacement = packageFor('1.1.0');
  const replacementManifest = manifestFor(
    5,
    [
      {
        policyId: 'replacement',
        packageDigest: replacement.digest,
        priority: 10,
        rolloutPercent: 100,
      },
    ],
    { revokedDigests: [pkg.digest] }
  );
  store.sync(scope, { trust, manifest: replacementManifest, packages: [] });
  assert.equal(
    select().reason,
    'cache_cold',
    'Missing replacement cannot revive the revoked old candidate'
  );
  store.sync(scope, { trust, manifest: replacementManifest, packages: [replacement] });
  assert.equal(
    select().packageDigest,
    replacement.digest,
    'Packages install incrementally against the checkpoint'
  );
  assert.throws(
    () => store.sync(scope, { trust, manifest: manifestFor(6), packages: [pkg] }),
    /revoked_policy/
  );
  assert.equal(
    selected.receipt.managed.policyRevision,
    1,
    'Historical frozen receipt never mutates'
  );
  console.log(
    'managed RSI: signed v2, cold/warm cache, full gateway set, scope, immutable versions, rollout, expiry, rollback/fork, revocation and actual native receipt PASS'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
