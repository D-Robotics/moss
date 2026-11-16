import { RsiError, rsiDigest, type RsiState } from './store.js';
import { RSI_DAILY_ALL_PROJECTS } from './daily-store.js';
import type { RsiReplayJson, RsiReplayState, RsiReplayProfile } from './replay-types.js';
import type { RsiTrainingPlan } from './types.js';

export const replayFail = (code: string): never => {
  throw new RsiError(code, 409);
};
export function replayState(state: RsiState): RsiReplayState {
  const value = (state.replay ??= {
    schemaVersion: 1,
    profiles: [],
    captures: [],
    cases: [],
    manifests: [],
  });
  if (
    value.schemaVersion !== 1 ||
    ![value.profiles, value.captures, value.cases, value.manifests].every(Array.isArray)
  )
    replayFail('replay_store_invalid');
  return value;
}
export function replayIdentifier(value: string, maximum = 512): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\x00-\x1f]/.test(value)
  )
    replayFail('invalid_replay_reference');
}
export function replayDigest(value: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    replayFail('invalid_replay_digest');
}
export function replaySensitiveText(value: string): void {
  if (
    /-----BEGIN .*PRIVATE KEY-----|\bBearer\s+[a-zA-Z0-9._-]{16,}|\b(?:sk-[a-zA-Z0-9_-]{16,}|npm_[a-zA-Z0-9]{20,})|["']?\b(?:api[_-]?key|access[_-]?token|password)["']?\s*[:=]\s*["']?[^\s"']{8,}/i.test(
      value
    )
  )
    replayFail('asset_contains_credentials');
}
export function replayCas(state: RsiState, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected !== state.revision)
    replayFail('replay_revision_conflict');
}
export function replayCanonical(value: RsiReplayJson): string {
  if (Array.isArray(value)) return `[${value.map(replayCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${replayCanonical(value[key]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function replayJson(content: string, maximum = 262144): RsiReplayJson {
  if (typeof content !== 'string' || Buffer.byteLength(content) > maximum)
    replayFail('replay_content_too_large');
  let value: RsiReplayJson;
  try {
    value = JSON.parse(content) as RsiReplayJson;
  } catch {
    return replayFail('replay_json_invalid');
  }
  let count = 0;
  const visit = (node: RsiReplayJson, depth: number) => {
    if (++count > 10000 || depth > 32) replayFail('replay_json_limit');
    if (typeof node === 'number' && !Number.isFinite(node)) replayFail('replay_json_invalid');
    if (typeof node === 'string') replaySensitiveText(node);
    if (node && typeof node === 'object')
      for (const [key, child] of Object.entries(node)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          replayFail('replay_json_invalid');
        if (
          /^(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|auth|authentication|authorization|client[_-]?secret|session[_-]?(token|secret)|credentials?|private[_-]?key|secret([_-]?key)?)$/i.test(
            key
          ) &&
          child !== '' &&
          child !== null
        )
          replayFail('asset_contains_credentials');
        visit(child as RsiReplayJson, depth + 1);
      }
  };
  visit(value, 0);
  return value;
}
export function replayConsent(state: RsiState, profileId: string): RsiReplayProfile {
  const profile = replayState(state).profiles.find((item) => item.id === profileId);
  if (!profile?.enabled || !profile.contentConsent)
    return replayFail('replay_content_consent_required');
  const consent =
    state.daily?.projects.find((item) => item.projectId === profile.projectId) ??
    state.daily?.projects.find((item) => item.projectId === RSI_DAILY_ALL_PROJECTS);
  if (!consent?.enabled) replayFail('replay_index_consent_required');
  return profile;
}
export function replayLiveAsset(state: RsiState, id: string): void {
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    if (visited.size > 10000) replayFail('replay_dependency_limit');
    const record = state.assets?.records.find((item) => item.id === key);
    if (!record || record.deletedAt || state.assets?.deletedIds.includes(key))
      replayFail('replay_source_deleted');
    for (const parent of record!.dependencies) visit(parent);
  };
  visit(id);
}
/** Admission is checked again inside the training transaction, not only when UI freezes a pack. */
export function assertReplayTrainingSource(state: RsiState, id: string): void {
  const item = state.replay?.cases.find((item) => item.id === id);
  if (!item) return;
  replayConsent(state, item.profileId);
  replayLiveAsset(state, id);
  const capture = state.replay!.captures.find((capture) => capture.id === item.captureId);
  if (
    !capture ||
    state.daily?.deletedRunDigests.includes(
      rsiDigest(JSON.stringify([capture.projectId, capture.runId]))
    )
  )
    replayFail('replay_source_deleted');
}
export function assertReplayTrainingPlan(state: RsiState, plan: RsiTrainingPlan): void {
  const entries = Object.values(plan.cases).flat();
  if (!entries.some((entry) => state.replay?.cases.some((item) => item.id === entry.id))) return;
  const canonical = (value: unknown) =>
    replayCanonical(JSON.parse(JSON.stringify(value)) as RsiReplayJson);
  const manifest = state.replay?.manifests.find(
    (item) =>
      canonical(item.cases) === canonical(plan.cases) &&
      canonical(item.taskScope) === canonical(plan.taskScope)
  );
  if (!manifest) replayFail('replay_manifest_required');
  replayLiveAsset(state, manifest!.id);
  for (const entry of entries) assertReplayTrainingSource(state, entry.id);
}
export function replayAdditionalClaim(state: RsiState, caseId: string): string[] {
  const item = state.replay?.cases.find((item) => item.id === caseId);
  return item ? [rsiDigest(JSON.stringify(['training-group', item.initialGroupDigest]))] : [];
}
