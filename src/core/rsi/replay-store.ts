import { RsiStore, RSI_BASELINE, rsiDigest, type RsiState } from './store.js';
import { RsiAssetStore, putRsiAsset, beginRsiAssetDeletion } from './asset-store.js';
import { rsiTaskScopeDigest } from './external-training.js';
import {
  replayState,
  replayFail,
  replayIdentifier,
  replayDigest,
  replayCas,
  replayCanonical,
  replayJson,
  replaySensitiveText,
  replayConsent,
  replayLiveAsset,
  assertReplayTrainingSource,
} from './replay-validation.js';
import type { RsiScope, RsiTaskScope, RsiTrainingCase } from './types.js';
import type {
  RsiReplayProfile,
  RsiReplayCapture,
  RsiReplayCaptureInput,
  RsiReplayCaptureSummary,
  RsiReplayCaptureReview,
  RsiReplayCaseSummary,
  RsiReplayCaseRecord,
  RsiReplayJson,
  RsiReplayGrader,
  RsiReplayGrade,
  RsiReplaySplit,
  RsiReplayManifest,
} from './replay-types.js';

const splits: RsiReplaySplit[] = ['training', 'validation', 'holdout', 'regression'];
const hashJson = (value: RsiReplayJson) => rsiDigest(replayCanonical(value));
const sourceId = (capture: Pick<RsiReplayCapture, 'projectId' | 'runId'>) =>
  rsiDigest(JSON.stringify([capture.projectId, capture.runId]));
function captureFor(state: RsiState, id: string): RsiReplayCapture {
  const capture = replayState(state).captures.find((item) => item.id === id);
  if (!capture) return replayFail('replay_capture_not_found');
  return capture;
}
function admittedCapture(state: RsiState, id: string): RsiReplayCapture {
  const capture = captureFor(state, id);
  replayConsent(state, capture.profileId);
  if (state.daily?.deletedRunDigests.includes(sourceId(capture)))
    replayFail('replay_source_deleted');
  replayLiveAsset(state, capture.sourceAssetId);
  if (capture.completedAssetId) replayLiveAsset(state, capture.completedAssetId);
  return capture;
}
function summary(capture: RsiReplayCapture, state: RsiState): RsiReplayCaptureSummary {
  const { id, profileId, runId, projectId, taskScope, createdAt, completedAt } = capture;
  let status = capture.status;
  try {
    replayLiveAsset(state, capture.sourceAssetId);
  } catch {
    status = 'revoked';
  }
  return { id, profileId, runId, projectId, taskScope, createdAt, completedAt, status };
}
function publicCase(item: RsiReplayCaseRecord): RsiReplayCaseSummary {
  const { privateAssetId: _private, initialGroupDigest: _initial, ...publicValue } = item;
  return publicValue;
}
function boundedGrade(
  grader: RsiReplayGrader,
  content: string,
  rules: RsiReplayJson
): RsiReplayGrade {
  const result = grader(content, structuredClone(rules));
  if (
    !result ||
    typeof result.passed !== 'boolean' ||
    !Array.isArray(result.checks) ||
    result.checks.length > 128 ||
    result.checks.some((check) => typeof check !== 'string' || check.length > 160)
  )
    return replayFail('replay_grader_invalid');
  return { passed: result.passed, checks: [...result.checks] };
}

/** Trusted host API. Actor/private accessors must never be exposed as raw HTTP asset endpoints. */
export class RsiReplayCaseStore {
  private readonly store: RsiStore;
  private readonly assets: RsiAssetStore;
  constructor(readonly rootDir: string) {
    this.store = new RsiStore(rootDir);
    this.assets = new RsiAssetStore(rootDir);
  }
  listProfiles(scope: RsiScope): { revision: number; profiles: RsiReplayProfile[] } {
    const state = this.store.read(scope);
    return structuredClone({ revision: state.revision, profiles: replayState(state).profiles });
  }
  configureProfile(
    scope: RsiScope,
    input: {
      projectId: string;
      file: string;
      enabled: boolean;
      contentConsent: boolean;
      expectedRevision: number;
    }
  ): { revision: number; profiles: RsiReplayProfile[] } {
    replayIdentifier(input.projectId);
    if (
      typeof input.file !== 'string' ||
      input.file.length > 512 ||
      !/^[a-zA-Z0-9_@-][a-zA-Z0-9_@./-]*\.json$/.test(input.file) ||
      input.file.split('/').some((part) => !part || part.startsWith('.')) ||
      /(?:secret|credential|password|token|private.?key)/i.test(input.file) ||
      typeof input.enabled !== 'boolean' ||
      typeof input.contentConsent !== 'boolean'
    )
      replayFail('invalid_replay_profile');
    this.store.update(scope, (state) => {
      replayCas(state, input.expectedRevision);
      const value = replayState(state);
      const id = rsiDigest(JSON.stringify([input.projectId, input.file]));
      const old = value.profiles.find((item) => item.id === id);
      if (!old && value.profiles.length >= 100) replayFail('replay_profile_limit');
      // A project has one explicitly selected file surface at a time.
      if (input.enabled)
        for (const item of value.profiles)
          if (item.projectId === input.projectId && item.id !== id) item.enabled = false;
      const profile: RsiReplayProfile = {
        id,
        projectId: input.projectId,
        file: input.file,
        enabled: input.enabled,
        contentConsent: input.contentConsent,
        version: 1,
        updatedAt: Date.now(),
      };
      if (old) Object.assign(old, profile);
      else value.profiles.push(profile);
    });
    return this.listProfiles(scope);
  }
  beginCapture(scope: RsiScope, input: RsiReplayCaptureInput): RsiReplayCaptureSummary {
    replayIdentifier(input.runId);
    replayDigest(input.contractDigest);
    replayDigest(input.sourceGroupDigest);
    rsiTaskScopeDigest(input.taskScope);
    replayJson(input.initialContent);
    if (
      typeof input.request !== 'string' ||
      !input.request.trim() ||
      Buffer.byteLength(input.request) > 8192
    )
      replayFail('invalid_replay_request');
    replaySensitiveText(input.request);
    const id = rsiDigest(JSON.stringify(['replay-capture', input.profileId, input.runId]));
    return this.store.update(scope, (state) => {
      const profile = replayConsent(state, input.profileId);
      if (profile.projectId !== input.taskScope.projectId) replayFail('replay_project_mismatch');
      if (
        state.daily?.deletedRunDigests.includes(
          rsiDigest(JSON.stringify([profile.projectId, input.runId]))
        )
      )
        replayFail('replay_source_deleted');
      const value = replayState(state);
      const old = value.captures.find((item) => item.id === id);
      const payload = {
        schemaVersion: 1,
        profileId: profile.id,
        runId: input.runId,
        request: input.request,
        initialContent: input.initialContent,
        contractDigest: input.contractDigest,
        sourceGroupDigest: input.sourceGroupDigest,
      };
      if (old) {
        admittedCapture(state, id);
        const prior = JSON.parse(
          this.assets.read(scope, old.taskScope, old.sourceAssetId)
        ) as typeof payload;
        if (
          JSON.stringify(prior) !== JSON.stringify(payload) ||
          rsiTaskScopeDigest(old.taskScope) !== rsiTaskScopeDigest(input.taskScope)
        )
          replayFail('replay_capture_conflict');
        return summary(old, state);
      }
      const run = state.runs.find((item) => item.runId === input.runId);
      if (run && (run.outcome !== 'running' || run.toolCalls > 0 || run.usage.inputTokens > 0))
        replayFail('replay_capture_late');
      if (value.captures.length >= 1000) replayFail('replay_capture_limit');
      const asset = putRsiAsset(this.rootDir, state, input.taskScope, {
        kind: 'experience',
        content: JSON.stringify(payload),
        sourceId: input.runId,
        expectedRevision: state.revision,
      });
      const capture: RsiReplayCapture = {
        id,
        profileId: profile.id,
        runId: input.runId,
        projectId: profile.projectId,
        taskScope: structuredClone(input.taskScope),
        createdAt: Date.now(),
        status: 'capturing',
        sourceAssetId: asset.id,
        contractDigest: input.contractDigest,
        sourceGroupDigest: input.sourceGroupDigest,
      };
      value.captures.push(capture);
      return summary(capture, state);
    });
  }
  completeCapture(
    scope: RsiScope,
    input: { captureId: string; finalContent: string }
  ): RsiReplayCaptureSummary {
    replayJson(input.finalContent);
    return this.store.update(scope, (state) => {
      const capture = admittedCapture(state, input.captureId);
      if (capture.completedAssetId) {
        const payload = JSON.parse(
          this.assets.read(scope, capture.taskScope, capture.completedAssetId)
        ) as { finalContent: string };
        if (payload.finalContent !== input.finalContent) replayFail('replay_capture_conflict');
        return summary(capture, state);
      }
      const run = state.runs.find((item) => item.runId === capture.runId);
      const reference = state.daily?.experiences.find(
        (item) => item.runId === capture.runId && item.projectId === capture.projectId
      );
      if (!run || !reference || run.outcome === 'running' || !run.endedAt)
        replayFail('replay_source_pending');
      if (
        run!.source !== 'native-moss-observer' ||
        run!.runtime !== 'moss' ||
        run!.coverage.source !== 'native-moss-observer' ||
        !run!.events.some((event) => event.type === 'turn_start') ||
        run!.coverage.gaps.some((gap) =>
          [
            'native_identity_unavailable',
            'prompt_attestation_unavailable',
            'observer_gap',
            'persistence_gap',
          ].includes(gap)
        ) ||
        run!.endedAt! < capture.createdAt ||
        (run!.adapter.digest !== RSI_BASELINE.digest &&
          run!.adapter.taskScopeDigest !== rsiTaskScopeDigest(capture.taskScope)) ||
        (run!.adapter.taskScopeDigest &&
          run!.adapter.taskScopeDigest !== rsiTaskScopeDigest(capture.taskScope)) ||
        (reference!.taskScopeDigest &&
          reference!.taskScopeDigest !== rsiTaskScopeDigest(capture.taskScope)) ||
        (reference!.adapterDigest && reference!.adapterDigest !== run!.adapter.digest)
      )
        replayFail('replay_source_invalid');
      const receiptDigest = rsiDigest(JSON.stringify(run));
      if (reference!.evidenceDigest && reference!.evidenceDigest !== receiptDigest)
        replayFail('replay_source_invalid');
      const asset = putRsiAsset(this.rootDir, state, capture.taskScope, {
        kind: 'experience',
        content: JSON.stringify({ finalContent: input.finalContent, receiptDigest, receipt: run }),
        sourceId: capture.runId,
        dependencies: [capture.sourceAssetId],
        expectedRevision: state.revision,
      });
      capture.completedAssetId = asset.id;
      capture.receiptDigest = receiptDigest;
      capture.completedAt = Date.now();
      capture.status = 'completed';
      return summary(capture, state);
    });
  }
  listCaptures(scope: RsiScope): RsiReplayCaptureSummary[] {
    const state = this.store.read(scope);
    return structuredClone(replayState(state).captures.map((item) => summary(item, state)));
  }
  readCaptureReview(scope: RsiScope, id: string): RsiReplayCaptureReview {
    const capture = admittedCapture(this.store.read(scope), id);
    if (!capture.completedAssetId || !capture.receiptDigest)
      return replayFail('replay_source_pending');
    const initial = JSON.parse(
      this.assets.read(scope, capture.taskScope, capture.sourceAssetId)
    ) as { request: string; initialContent: string };
    const final = JSON.parse(
      this.assets.read(scope, capture.taskScope, capture.completedAssetId)
    ) as { finalContent: string };
    return {
      request: initial.request,
      initialContent: initial.initialContent,
      finalContent: final.finalContent,
      contractDigest: capture.contractDigest,
      receiptDigest: capture.receiptDigest,
    };
  }
  qualify(
    scope: RsiScope,
    input: {
      captureId: string;
      rules: RsiReplayJson;
      kind: 'problem' | 'regression';
      graderVersion: string;
    },
    grader: RsiReplayGrader
  ): RsiReplayCaseSummary {
    if (!['problem', 'regression'].includes(input.kind) || typeof grader !== 'function')
      replayFail('invalid_replay_qualification');
    replayIdentifier(input.graderVersion, 128);
    const rules = replayJson(JSON.stringify(input.rules), 65536);
    const capture = admittedCapture(this.store.read(scope), input.captureId);
    const review = this.readCaptureReview(scope, input.captureId);
    const initial = boundedGrade(grader, review.initialContent, rules),
      final = boundedGrade(grader, review.finalContent, rules);
    if (
      JSON.stringify(initial) !==
        JSON.stringify(boundedGrade(grader, review.initialContent, rules)) ||
      JSON.stringify(final) !== JSON.stringify(boundedGrade(grader, review.finalContent, rules))
    )
      replayFail('replay_grader_nondeterministic');
    if (!final.passed || initial.passed !== (input.kind === 'regression'))
      replayFail('replay_not_qualified');
    const fixtureDigest = hashJson({
      initial: replayJson(review.initialContent),
      request: review.request,
      rules,
      reference: replayJson(review.finalContent),
      graderVersion: input.graderVersion,
      contractDigest: review.contractDigest,
    });
    return this.store.update(scope, (state) => {
      const current = admittedCapture(state, input.captureId);
      if (current.completedAssetId !== capture.completedAssetId)
        replayFail('replay_capture_conflict');
      const value = replayState(state);
      const old = value.cases.find(
        (item) =>
          item.captureId === capture.id &&
          item.fixtureDigest === fixtureDigest &&
          item.kind === input.kind
      );
      if (old) {
        replayLiveAsset(state, old.id);
        return publicCase(old);
      }
      if (value.cases.length >= 1000) replayFail('replay_case_limit');
      const privateAsset = putRsiAsset(this.rootDir, state, capture.taskScope, {
        kind: 'case',
        content: JSON.stringify({
          rules,
          referenceContent: review.finalContent,
          graderVersion: input.graderVersion,
          initial,
          final,
        }),
        dependencies: [current.completedAssetId!],
        sourceId: capture.runId,
        expectedRevision: state.revision,
      });
      const proof = putRsiAsset(this.rootDir, state, capture.taskScope, {
        kind: 'case',
        content: JSON.stringify({
          schemaVersion: 1,
          captureId: capture.id,
          fixtureDigest,
          kind: input.kind,
          receiptDigest: review.receiptDigest,
          initialPassed: initial.passed,
          referencePassed: final.passed,
        }),
        dependencies: [privateAsset.id],
        sourceId: capture.runId,
        expectedRevision: state.revision,
      });
      const item: RsiReplayCaseRecord = {
        id: proof.id,
        captureId: capture.id,
        profileId: capture.profileId,
        projectId: capture.projectId,
        runId: capture.runId,
        taskScope: capture.taskScope,
        kind: input.kind,
        groupDigest: capture.sourceGroupDigest,
        fixtureDigest,
        graderVersion: input.graderVersion,
        createdAt: Date.now(),
        initialPassed: initial.passed,
        referencePassed: final.passed,
        privateAssetId: privateAsset.id,
        initialGroupDigest: hashJson([
          'replay-initial',
          capture.projectId,
          replayJson(review.initialContent),
        ]),
      };
      value.cases.push(item);
      return publicCase(item);
    });
  }
  listCases(scope: RsiScope): RsiReplayCaseSummary[] {
    const state = this.store.read(scope);
    return replayState(state)
      .cases.filter((item) => {
        try {
          replayLiveAsset(state, item.id);
          return true;
        } catch {
          return false;
        }
      })
      .map(publicCase);
  }
  private caseFor(scope: RsiScope, id: string): RsiReplayCaseRecord {
    const state = this.store.read(scope),
      item = replayState(state).cases.find((item) => item.id === id);
    if (!item) return replayFail('replay_case_not_found');
    assertReplayTrainingSource(state, item.id);
    return item;
  }
  readActorInput(scope: RsiScope, id: string): { request: string; initialContent: string } {
    const item = this.caseFor(scope, id),
      review = this.readCaptureReview(scope, item.captureId);
    return { request: review.request, initialContent: review.initialContent };
  }
  readGraderInput(
    scope: RsiScope,
    id: string
  ): { rules: RsiReplayJson; referenceContent: string; graderVersion: string } {
    const item = this.caseFor(scope, id);
    const value = JSON.parse(this.assets.read(scope, item.taskScope, item.privateAssetId)) as {
      rules: RsiReplayJson;
      referenceContent: string;
      graderVersion: string;
    };
    return {
      rules: value.rules,
      referenceContent: value.referenceContent,
      graderVersion: value.graderVersion,
    };
  }
  freezeManifest(
    scope: RsiScope,
    input: {
      taskScope: RsiTaskScope;
      cases: Record<RsiReplaySplit, string[]>;
      expectedRevision: number;
    }
  ): RsiReplayManifest {
    const digest = rsiTaskScopeDigest(input.taskScope);
    return this.store.update(scope, (state) => {
      replayCas(state, input.expectedRevision);
      if (
        !input.cases ||
        Object.keys(input.cases).sort().join(',') !== [...splits].sort().join(',') ||
        splits.some(
          (split) => !Array.isArray(input.cases[split]) || input.cases[split].length !== 4
        )
      )
        replayFail('training_requires_four_cases_per_split');
      const value = replayState(state),
        ids = splits.flatMap((split) => input.cases[split]);
      if (new Set(ids).size !== 16) replayFail('training_splits_overlap');
      const selected = ids.map((id) => {
        const item = value.cases.find((item) => item.id === id);
        if (!item) return replayFail('replay_case_not_found');
        assertReplayTrainingSource(state, id);
        if (rsiTaskScopeDigest(item.taskScope) !== digest) replayFail('replay_scope_mismatch');
        return item;
      });
      if (new Set(selected.map((item) => item.fixtureDigest)).size !== 16)
        replayFail('training_splits_overlap');
      if (
        new Set(selected.map((item) => item.profileId)).size !== 1 ||
        new Set(selected.map((item) => captureFor(state, item.captureId).contractDigest)).size !==
          1 ||
        new Set(selected.map((item) => item.graderVersion)).size !== 1
      )
        replayFail('replay_contract_mismatch');
      const groups = new Map<string, RsiReplaySplit>();
      const cases = Object.fromEntries(
        splits.map((split) => [
          split,
          input.cases[split].map((id) => {
            const item = selected.find((item) => item.id === id)!;
            if (item.kind !== (split === 'regression' ? 'regression' : 'problem'))
              replayFail('replay_case_kind_mismatch');
            const exposure = split === 'regression' ? 'holdout' : split;
            for (const group of [item.groupDigest, item.initialGroupDigest]) {
              if (groups.has(group) && groups.get(group) !== split)
                replayFail('training_splits_overlap');
              groups.set(group, split);
            }
            const claims = [
              rsiDigest(JSON.stringify(['task-fixture', item.fixtureDigest])),
              ...[item.groupDigest, item.initialGroupDigest].map((group) =>
                rsiDigest(JSON.stringify(['training-group', group]))
              ),
            ];
            for (const claim of claims) {
              if (state.holdoutConsumptions.some((old) => old.digest === claim))
                replayFail('holdout_already_consumed');
              const old = state.caseExposures.find((old) => old.digest === claim);
              if (old && old.split !== exposure) replayFail('case_split_immutable');
              if (!old)
                state.caseExposures.push({ digest: claim, split: exposure, at: Date.now() });
            }
            return { id, groupDigest: item.groupDigest, fixtureDigest: item.fixtureDigest };
          }),
        ])
      ) as Record<RsiReplaySplit, RsiTrainingCase[]>;
      if (state.caseExposures.length > 10000) replayFail('case_exposure_ledger_limit');
      const existing = value.manifests.find(
        (item) =>
          JSON.stringify(item.cases) === JSON.stringify(cases) &&
          rsiTaskScopeDigest(item.taskScope) === digest
      );
      if (existing) {
        replayLiveAsset(state, existing.id);
        return existing;
      }
      if (value.manifests.length >= 100) replayFail('replay_manifest_limit');
      const record = putRsiAsset(this.rootDir, state, input.taskScope, {
        kind: 'manifest',
        content: JSON.stringify({ schemaVersion: 1, taskScope: input.taskScope, cases }),
        dependencies: ids,
        expectedRevision: state.revision,
      });
      const manifest = {
        id: record.id,
        taskScope: structuredClone(input.taskScope),
        cases,
        createdAt: Date.now(),
      };
      value.manifests.push(manifest);
      return manifest;
    });
  }
  readManifest(scope: RsiScope, id: string): RsiReplayManifest {
    const state = this.store.read(scope),
      item = replayState(state).manifests.find((item) => item.id === id);
    if (!item) return replayFail('replay_manifest_not_found');
    replayLiveAsset(state, item.id);
    for (const entry of Object.values(item.cases).flat())
      assertReplayTrainingSource(state, entry.id);
    return structuredClone(item);
  }
  listManifests(scope: RsiScope): RsiReplayManifest[] {
    return replayState(this.store.read(scope)).manifests.flatMap((item) => {
      try {
        return [this.readManifest(scope, item.id)];
      } catch {
        return [];
      }
    });
  }
  getManifestSourceAssetIds(scope: RsiScope, id: string): string[] {
    return [this.readManifest(scope, id).id];
  }
  beginSourceDeletion(scope: RsiScope, input: { captureId: string; expectedRevision: number }) {
    return this.store.update(
      scope,
      (state) => {
        replayCas(state, input.expectedRevision);
        const capture = captureFor(state, input.captureId);
        const result = beginRsiAssetDeletion(state, capture.taskScope, {
          assetIds: [capture.sourceAssetId],
          expectedRevision: state.revision,
        });
        if (state.daily && !state.daily.deletedRunDigests.includes(sourceId(capture))) {
          if (state.daily.deletedRunDigests.length >= 10000)
            replayFail('daily_deletion_retention_limit');
          state.daily.deletedRunDigests.push(sourceId(capture));
        }
        return { ...result, taskScope: capture.taskScope };
      },
      true
    );
  }
  completeSourceDeletion(scope: RsiScope, input: { captureId: string; deletionId: string }): void {
    const state = this.store.read(scope),
      capture = captureFor(state, input.captureId);
    const deletion = state.assets?.deletions.find(
      (item) => item.id === input.deletionId && item.assetIds.includes(capture.sourceAssetId)
    );
    if (!deletion) replayFail('deletion_not_found');
    this.assets.completeDeletion(scope, capture.taskScope, input.deletionId);
    this.store.update(
      scope,
      (current) => {
        if (current.daily)
          current.daily.experiences = current.daily.experiences.filter(
            (item) => item.id !== sourceId(capture)
          );
      },
      true
    );
  }
}
