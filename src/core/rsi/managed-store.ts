import { RsiManagedStateFile } from './managed-state.js';
import { verifyRsiManagedEnvelope, rsiManagedManifestContentDigest } from './managed-package.js';
import { selectRsiManagedCandidate } from './managed-selection.js';
import { managedFail } from './managed-validation.js';
import type { RsiScope } from './types.js';
import type {
  RsiManagedDecision,
  RsiManagedManifest,
  RsiManagedPackage,
  RsiManagedReason,
  RsiManagedRunContext,
  RsiManagedTrust,
} from './managed-types.js';

export interface RsiManagedOverview {
  manifest: RsiManagedManifest | null;
  packages: Array<{ digest: string; package: RsiManagedPackage }>;
  indexFresh: boolean;
  reason?: RsiManagedReason;
}
export class RsiManagedAdapterStore {
  private readonly files: RsiManagedStateFile;
  constructor(
    root: string,
    private readonly options: { authorize?(scope: RsiScope): void; now?(): number } = {}
  ) {
    this.files = new RsiManagedStateFile(root);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  sync(
    scope: RsiScope,
    input: { trust: RsiManagedTrust; manifest: unknown; packages: readonly unknown[] }
  ): RsiManagedOverview {
    this.options.authorize?.(scope);
    const now = this.now();
    const manifest = verifyRsiManagedEnvelope<RsiManagedManifest>(input.manifest, input.trust, now);
    if (manifest.payload.kind !== 'rsi-managed-manifest' || input.packages.length > 128)
      return managedFail('invalid_sync');
    const packages = input.packages.map((value) => {
      const pkg = verifyRsiManagedEnvelope<RsiManagedPackage>(value, input.trust, now);
      if (pkg.payload.kind !== 'rsi-managed-package') return managedFail('invalid_sync');
      return pkg;
    });
    this.files.update(scope, (state) => {
      if (state.manifest) {
        const old = verifyRsiManagedEnvelope<RsiManagedManifest>(state.manifest, input.trust);
        if (
          manifest.payload.revision < old.payload.revision ||
          manifest.payload.issuedAt < old.payload.issuedAt
        )
          return managedFail('index_rollback', 409);
        if (
          manifest.payload.revision === old.payload.revision &&
          rsiManagedManifestContentDigest(manifest.payload) !==
            rsiManagedManifestContentDigest(old.payload)
        )
          return managedFail('index_fork', 409);
      }
      const revoked = new Set([...state.revokedDigests, ...manifest.payload.revokedDigests]);
      if (manifest.payload.entries.some((policy) => revoked.has(policy.packageDigest)))
        return managedFail('revoked_policy', 409);
      for (const pkg of packages) {
        const previous = state.versions.find(
          (item) => item.packageId === pkg.payload.packageId && item.version === pkg.payload.version
        );
        if (previous && previous.digest !== pkg.digest) return managedFail('version_conflict', 409);
        if (!previous)
          state.versions.push({
            packageId: pkg.payload.packageId,
            version: pkg.payload.version,
            digest: pkg.digest,
          });
      }
      const installed = new Map(state.packages.map((pkg) => [pkg.digest, pkg]));
      for (const pkg of packages) installed.set(pkg.digest, pkg);
      const selected = manifest.payload.entries.map((entry) => installed.get(entry.packageDigest));
      // Persist freshness/revocation before downloading replacements. Partial
      // caches are never used for selection until every referenced package exists.
      state.packages = [
        ...new Map(selected.flatMap((pkg) => (pkg ? [[pkg.digest, pkg] as const] : []))).values(),
      ];
      state.manifest = manifest;
      state.revokedDigests = [...revoked];
      if (state.versions.length > 4096 || state.revokedDigests.length > 4096)
        return managedFail('history_limit', 409);
    });
    return this.overview(scope, { trust: input.trust });
  }
  overview(scope: RsiScope, input: { trust: RsiManagedTrust }): RsiManagedOverview {
    this.options.authorize?.(scope);
    try {
      const state = this.files.read(scope);
      if (!state.manifest)
        return { manifest: null, packages: [], indexFresh: false, reason: 'cache_cold' };
      const manifest = verifyRsiManagedEnvelope<RsiManagedManifest>(state.manifest, input.trust);
      if (manifest.payload.kind !== 'rsi-managed-manifest') return managedFail('invalid_sync');
      if (
        this.now() >= manifest.payload.expiresAt ||
        manifest.payload.issuedAt > this.now() + 30_000
      )
        return {
          manifest: manifest.payload,
          packages: [],
          indexFresh: false,
          reason: 'index_expired',
        };
      const packages = state.packages
        .map((raw) => {
          const pkg = verifyRsiManagedEnvelope<RsiManagedPackage>(raw, input.trust, this.now());
          if (pkg.payload.kind !== 'rsi-managed-package') return managedFail('invalid_sync');
          return { digest: pkg.digest, package: pkg.payload };
        })
        .filter((pkg) => !state.revokedDigests.includes(pkg.digest));
      return { manifest: manifest.payload, packages, indexFresh: true };
    } catch {
      return { manifest: null, packages: [], indexFresh: false, reason: 'signature_invalid' };
    }
  }
  select(
    scope: RsiScope,
    input: { trust: RsiManagedTrust; context: RsiManagedRunContext }
  ): RsiManagedDecision {
    const overview = this.overview(scope, input);
    if (!overview.indexFresh || !overview.manifest)
      return { reason: overview.reason ?? 'cache_cold' };
    if (
      overview.manifest.entries.some(
        (entry) => !overview.packages.some((pkg) => pkg.digest === entry.packageDigest)
      )
    )
      return { reason: 'cache_cold', policyRevision: overview.manifest.revision };
    try {
      return selectRsiManagedCandidate(overview.manifest, overview.packages, input.context);
    } catch {
      return { reason: 'gateway_identity_unresolved', policyRevision: overview.manifest.revision };
    }
  }
}
