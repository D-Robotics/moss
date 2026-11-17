import type { RsiSelectedAdapter } from './engine.js';
import { rsiTaskScopeDigest } from './external-training.js';
import { managedGatewayIdentity, managedTargets, managedTexts } from './managed-validation.js';
import { sharedInteger, sharedText } from './shared-validation.js';
import type {
  RsiManagedDecision,
  RsiManagedManifest,
  RsiManagedPackage,
  RsiManagedReason,
  RsiManagedRunContext,
  RsiManagedTarget,
} from './managed-types.js';

const targetKey = (target: RsiManagedTarget) => JSON.stringify([target.platformId, target.modelId]);
function compatibilityReason(
  pkg: RsiManagedPackage,
  context: RsiManagedRunContext
): RsiManagedReason | null {
  const compatible = pkg.compatibility;
  if (
    !compatible.profiles.some(
      (profile) => profile.id === context.profile && profile.version === context.profileVersion
    )
  )
    return 'task_profile_unsupported';
  const gateway = context.gateway;
  if (!gateway || !compatible.gatewayContractVersions.includes(gateway.contractVersion))
    return 'gateway_identity_unresolved';
  const targets =
    gateway.mode === 'manual'
      ? [{ platformId: gateway.platformId, modelId: gateway.modelId }]
      : gateway.bounded === true
        ? managedTargets(gateway.targets)
        : [];
  if (!targets.length) return 'gateway_identity_unresolved';
  const allowed = new Set(compatible.targets.map(targetKey));
  if (targets.some((target) => !allowed.has(targetKey(target)))) return 'model_incompatible';
  if (
    compatible.requiredTools.some((tool) => !context.tools.includes(tool)) ||
    compatible.forbiddenTools.some((tool) => context.tools.includes(tool)) ||
    (!compatible.allowAdditionalTools &&
      context.tools.some((tool) => !compatible.requiredTools.includes(tool))) ||
    (compatible.boardPlatforms &&
      (!context.boardPlatform || !compatible.boardPlatforms.includes(context.boardPlatform)))
  )
    return 'capability_mismatch';
  return null;
}
function selection(
  pkg: RsiManagedPackage,
  digest: string,
  policyId: string,
  manifest: RsiManagedManifest,
  context: RsiManagedRunContext
): RsiSelectedAdapter {
  const adapter = structuredClone(pkg.adapter);
  return {
    adapter,
    receipt: {
      id: adapter.id,
      version: adapter.version,
      digest: adapter.digest,
      applicationMode: 'native-sdk',
      policyVersion: manifest.revision,
      taskScopeDigest: rsiTaskScopeDigest(context.taskScope),
      registry: {
        registryId: pkg.registryId,
        packageId: pkg.packageId,
        packageDigest: digest,
        channel: 'stable',
        source: 'curated',
      },
      managed: {
        schemaVersion: 2,
        policyId,
        policyRevision: manifest.revision,
        profile: context.profile,
        profileVersion: context.profileVersion,
        gateway: structuredClone(context.gateway!),
      },
    },
    harnessAdapter: {
      id: adapter.id,
      version: adapter.version,
      instructions: adapter.instructions,
      sha256: adapter.digest,
    },
  };
}
/** No provider calls, model classification or network I/O occur during selection. */
export function selectRsiManagedCandidate(
  manifest: RsiManagedManifest,
  packages: ReadonlyArray<{ digest: string; package: RsiManagedPackage }>,
  context: RsiManagedRunContext
): RsiManagedDecision {
  sharedText(context.profile);
  sharedText(context.profileVersion);
  managedTexts([...context.tools], true);
  if (sharedInteger(context.cohort) > 99)
    return { reason: 'rollout_excluded', policyRevision: manifest.revision };
  if (!manifest.enabled) return { reason: 'policy_disabled', policyRevision: manifest.revision };
  if (!context.gateway)
    return { reason: 'gateway_identity_unresolved', policyRevision: manifest.revision };
  context = { ...context, gateway: managedGatewayIdentity(context.gateway) };
  const matches: Array<{ priority: number; decision: RsiManagedDecision }> = [];
  let reason: RsiManagedReason = manifest.revokedDigests.length
    ? 'package_revoked'
    : 'task_profile_unsupported';
  for (const policy of manifest.entries) {
    if (manifest.revokedDigests.includes(policy.packageDigest)) {
      reason = 'package_revoked';
      continue;
    }
    const installed = packages.find((pkg) => pkg.digest === policy.packageDigest);
    if (!installed) continue;
    const mismatch = compatibilityReason(installed.package, context);
    if (mismatch) {
      reason = mismatch;
      continue;
    }
    if (context.cohort >= policy.rolloutPercent) {
      reason = 'rollout_excluded';
      continue;
    }
    matches.push({
      priority: policy.priority,
      decision: {
        reason: 'selected',
        policyId: policy.policyId,
        policyRevision: manifest.revision,
        packageDigest: installed.digest,
        selection: selection(
          installed.package,
          installed.digest,
          policy.policyId,
          manifest,
          context
        ),
      },
    });
  }
  if (!matches.length) return { reason, policyRevision: manifest.revision };
  matches.sort((left, right) => right.priority - left.priority);
  if (matches[1]?.priority === matches[0].priority)
    return { reason: 'policy_ambiguous', policyRevision: manifest.revision };
  return matches[0].decision;
}
