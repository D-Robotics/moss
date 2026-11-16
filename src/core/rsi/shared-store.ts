import { rsiTaskScopeDigest } from './external-training.js';
import type { RsiSelectedAdapter } from './engine.js';
import type { RsiScope } from './types.js';
import {
  RsiSharedStateFile,
  type SharedState,
  type SharedRegistryHistory,
} from './shared-state.js';
import {
  verifyRsiSharedIndex,
  verifyRsiSharedPackage,
  rsiSharedIndexContentDigest,
} from './shared-package.js';
import {
  sharedFail,
  sharedInteger,
  sharedDigest,
  sharedText,
  validateRsiSharedConfiguration,
  SHARED_MAX_PACKAGES,
} from './shared-validation.js';
import type {
  RsiSharedConfiguration,
  RsiSharedEnvelope,
  RsiSharedIndex,
  RsiSharedInstalledPackage,
  RsiSharedOverview,
  RsiSharedPackage,
  RsiSharedRunContext,
  RsiSharedStoreOptions,
} from './shared-types.js';

function historyFor(state: SharedState, registryId: string): SharedRegistryHistory | undefined {
  return state.histories.find((item) => item.registryId === registryId);
}
function configuration(state: SharedState): RsiSharedConfiguration {
  if (!state.configuration) return sharedFail('configuration_required', 409);
  return validateRsiSharedConfiguration(state.configuration);
}
function freshIndex(state: SharedState, now: number): RsiSharedIndex | null {
  try {
    const trust = configuration(state);
    if (!state.index) return null;
    const index = verifyRsiSharedIndex(state.index, trust, now).payload;
    const history = historyFor(state, trust.registryId);
    if (
      !history ||
      index.revision !== history.revision ||
      index.issuedAt !== history.issuedAt ||
      rsiSharedIndexContentDigest(index) !== history.contentDigest
    )
      return null;
    return index;
  } catch {
    return null;
  }
}
function available(
  state: SharedState,
  envelope: RsiSharedEnvelope<RsiSharedPackage>,
  now: number
): RsiSharedInstalledPackage['availability'] {
  const config = configuration(state);
  if (
    !config.enabled ||
    envelope.payload.registryId !== config.registryId ||
    envelope.payload.channel !== config.channel
  )
    return 'disabled';
  const history = historyFor(state, config.registryId);
  if (history?.revokedDigests.includes(envelope.digest)) return 'revoked';
  const index = freshIndex(state, now);
  if (!index) return 'expired';
  const entry = index.entries.find((item) => item.digest === envelope.digest);
  if (!entry) return 'unlisted';
  if (entry.status === 'revoked') return 'revoked';
  if (
    entry.packageId !== envelope.payload.packageId ||
    entry.version !== envelope.payload.version ||
    entry.channel !== envelope.payload.channel
  )
    return 'unlisted';
  verifyRsiSharedPackage(envelope, config, now);
  return 'available';
}
function acceptIndex(state: SharedState, envelope: RsiSharedEnvelope<RsiSharedIndex>): void {
  const index = envelope.payload,
    digest = rsiSharedIndexContentDigest(index);
  let history = historyFor(state, index.registryId);
  if (history) {
    if (index.revision < history.revision || index.issuedAt < history.issuedAt)
      sharedFail('index_rollback', 409);
    if (index.revision === history.revision && digest !== history.contentDigest)
      sharedFail('index_fork', 409);
  } else {
    if (state.histories.length >= 8) sharedFail('registry_limit', 409);
    history = {
      registryId: index.registryId,
      revision: index.revision,
      contentDigest: digest,
      issuedAt: index.issuedAt,
      revokedDigests: [],
      versions: [],
    };
    state.histories.push(history);
  }
  for (const entry of index.entries) {
    const previous = history.versions.find(
      (item) => item.packageId === entry.packageId && item.version === entry.version
    );
    if (previous && previous.digest !== entry.digest) sharedFail('version_conflict', 409);
    if (entry.status === 'published' && history.revokedDigests.includes(entry.digest))
      sharedFail('revoked_package_republished', 409);
    if (!previous)
      history.versions.push({
        packageId: entry.packageId,
        version: entry.version,
        digest: entry.digest,
      });
    if (entry.status === 'revoked' && !history.revokedDigests.includes(entry.digest))
      history.revokedDigests.push(entry.digest);
  }
  if (history.versions.length > 4096 || history.revokedDigests.length > 4096)
    sharedFail('history_limit', 409);
  history.revision = index.revision;
  history.contentDigest = digest;
  history.issuedAt = index.issuedAt;
  state.index = envelope;
}
function matches(pkg: RsiSharedPackage, context: RsiSharedRunContext): boolean {
  const compatible = pkg.compatibility;
  if (
    compatible.taskFamily !== context.taskScope.taskFamily ||
    compatible.executionProfileDigest !== context.executionProfileDigest ||
    !compatible.models.includes(context.model)
  )
    return false;
  const actualTools = [...context.tools].sort(),
    requiredTools = [...compatible.tools].sort();
  if (
    new Set(actualTools).size !== actualTools.length ||
    JSON.stringify(actualTools) !== JSON.stringify(requiredTools)
  )
    return false;
  if (
    compatible.boardPlatforms &&
    (!context.boardPlatform || !compatible.boardPlatforms.includes(context.boardPlatform))
  )
    return false;
  if (
    compatible.providerKinds &&
    (!context.providerKind || !compatible.providerKinds.includes(context.providerKind))
  )
    return false;
  return true;
}
/** A host-neutral signed-package consumer. No model calls or hosted server. */
export class RsiSharedAdapterStore {
  private readonly files: RsiSharedStateFile;
  constructor(
    readonly rootDir: string,
    private readonly options: RsiSharedStoreOptions = {}
  ) {
    this.files = new RsiSharedStateFile(rootDir);
  }
  private now(): number {
    return sharedInteger(this.options.now?.() ?? Date.now(), 1);
  }
  configure(
    scope: RsiScope,
    input: RsiSharedConfiguration & { expectedRevision: number }
  ): RsiSharedOverview {
    this.options.authorize?.(scope);
    const { expectedRevision, ...requested } = input;
    const config = validateRsiSharedConfiguration(requested);
    this.files.update(scope, expectedRevision, (state) => {
      if (state.configuration?.registryId !== config.registryId) state.index = null;
      state.configuration = config;
    });
    return this.overview(scope);
  }
  sync(
    scope: RsiScope,
    input: { index: unknown; packages?: unknown[]; expectedRevision: number }
  ): RsiSharedOverview {
    this.options.authorize?.(scope);
    if (
      input.packages !== undefined &&
      (!Array.isArray(input.packages) || input.packages.length > SHARED_MAX_PACKAGES)
    )
      sharedFail('package_limit');
    const now = this.now();
    this.files.update(scope, input.expectedRevision, (state) => {
      const trust = configuration(state);
      const index = verifyRsiSharedIndex(input.index, trust, now);
      acceptIndex(state, index);
      for (const value of input.packages ?? []) {
        const envelope = verifyRsiSharedPackage(value, trust, now),
          pkg = envelope.payload;
        const entry = index.payload.entries.find((item) => item.digest === envelope.digest);
        if (
          !entry ||
          entry.status !== 'published' ||
          entry.channel !== trust.channel ||
          entry.packageId !== pkg.packageId ||
          entry.version !== pkg.version ||
          entry.channel !== pkg.channel
        )
          sharedFail('package_not_published', 409);
        const installed = state.installed.find((item) => item.envelope.digest === envelope.digest);
        if (!installed) state.installed.push({ envelope, installedAt: now });
      }
      if (state.installed.length > SHARED_MAX_PACKAGES) sharedFail('package_limit', 409);
    });
    return this.overview(scope);
  }
  adopt(
    scope: RsiScope,
    input: { projectId: string; packageDigest: string; expectedRevision: number }
  ): RsiSharedOverview {
    this.options.authorize?.(scope);
    sharedText(input.projectId, 256);
    sharedDigest(input.packageDigest);
    const now = this.now();
    this.files.update(scope, input.expectedRevision, (state) => {
      const installed = state.installed.find(
        (item) => item.envelope.digest === input.packageDigest
      );
      if (!installed || available(state, installed.envelope, now) !== 'available')
        sharedFail('package_unavailable', 409);
      let policy = state.policies.find((item) => item.projectId === input.projectId);
      if (!policy) {
        if (state.policies.length >= 128) sharedFail('project_limit', 409);
        policy = {
          projectId: input.projectId,
          packageDigest: null,
          previousPackageDigest: null,
          version: 0,
          updatedAt: 0,
        };
        state.policies.push(policy);
      }
      if (policy.packageDigest !== input.packageDigest) {
        policy.previousPackageDigest = policy.packageDigest;
        policy.packageDigest = input.packageDigest;
        policy.version++;
        policy.updatedAt = now;
      }
    });
    return this.overview(scope);
  }
  rollback(
    scope: RsiScope,
    input: { projectId: string; expectedRevision: number }
  ): RsiSharedOverview {
    this.options.authorize?.(scope);
    sharedText(input.projectId, 256);
    const now = this.now();
    this.files.update(scope, input.expectedRevision, (state) => {
      const policy = state.policies.find((item) => item.projectId === input.projectId);
      if (!policy || !policy.packageDigest) return sharedFail('rollback_unavailable', 409);
      const previous = state.installed.find(
        (item) => item.envelope.digest === policy.previousPackageDigest
      );
      policy.packageDigest =
        previous && available(state, previous.envelope, now) === 'available'
          ? previous.envelope.digest
          : null;
      policy.previousPackageDigest = null;
      policy.version++;
      policy.updatedAt = now;
    });
    return this.overview(scope);
  }
  overview(scope: RsiScope): RsiSharedOverview {
    this.options.authorize?.(scope);
    const state = this.files.read(scope),
      now = this.now();
    return {
      revision: state.revision,
      configuration: state.configuration,
      index: state.index?.payload ?? null,
      indexFresh: Boolean(freshIndex(state, now)),
      installed: state.installed.map((item) => ({
        digest: item.envelope.digest,
        package: item.envelope.payload,
        installedAt: item.installedAt,
        availability: available(state, item.envelope, now),
      })),
      policies: structuredClone(state.policies),
    };
  }
  capture(scope: RsiScope, context: RsiSharedRunContext): RsiSelectedAdapter | null {
    try {
      this.options.authorize?.(scope);
      const state = this.files.read(scope),
        now = this.now();
      const policy = state.policies.find((item) => item.projectId === context.taskScope.projectId);
      const installed = state.installed.find(
        (item) => item.envelope.digest === policy?.packageDigest
      );
      if (
        !policy ||
        !installed ||
        available(state, installed.envelope, now) !== 'available' ||
        !matches(installed.envelope.payload, context)
      )
        return null;
      const pkg = installed.envelope.payload,
        adapter = structuredClone(pkg.adapter);
      return {
        adapter,
        receipt: {
          id: adapter.id,
          version: adapter.version,
          digest: adapter.digest,
          applicationMode: 'native-sdk',
          policyVersion: policy.version,
          taskScopeDigest: rsiTaskScopeDigest(context.taskScope),
          registry: {
            registryId: pkg.registryId,
            packageId: pkg.packageId,
            packageDigest: installed.envelope.digest,
            channel: pkg.channel,
            source: 'curated',
          },
        },
        harnessAdapter: {
          id: adapter.id,
          version: adapter.version,
          instructions: adapter.instructions,
          sha256: adapter.digest,
        },
      };
    } catch {
      return null;
    }
  }
}
