import fs from 'node:fs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { assetPath, byteDigest } from './asset-io.js';
import { RsiError, RSI_BASELINE, type RsiState } from './store.js';
import { defaultRsiAssets } from './asset-types.js';
import type { RsiScope } from './types.js';

interface SafetyLedger {
  schemaVersion: 1;
  scope: RsiScope;
  revision: number;
  holdoutConsumptions: RsiState['holdoutConsumptions'];
  caseExposures: RsiState['caseExposures'];
  protocolProposals: string[];
  trainingReservations: NonNullable<RsiState['trainingReservations']>;
  cancelledSessions: string[];
  deletedAssetIds: string[];
  invalidatedAdapters: string[];
  deletedSourceIds: Array<{ id: string; taskScopeDigest: string }>;
  dailyDeletedRunDigests: string[];
  liveReferences: boolean;
}
export function backupKey(directory: string, create = false): Buffer {
  const file = assetPath(directory, 'backup-auth.key');
  if (!fs.existsSync(file) && create)
    fs.writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 });
  if (!fs.existsSync(file)) throw new RsiError('safety_ledger_unavailable', 503);
  const key = fs.readFileSync(file);
  if (key.length !== 32) throw new RsiError('safety_ledger_unavailable', 503);
  return key;
}
export function readSafetyLedger(
  directory: string,
  scope: RsiScope,
  required = false
): SafetyLedger | undefined {
  const file = assetPath(directory, 'safety-ledger.json');
  if (!fs.existsSync(file)) {
    if (required) throw new RsiError('safety_ledger_unavailable', 503);
    return undefined;
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('ledger size');
    const envelope = JSON.parse(raw) as { body: SafetyLedger; signature: string };
    const { body, signature } = envelope;
    const expected = createHmac('sha256', backupKey(directory))
      .update(JSON.stringify(body))
      .digest();
    if (
      !/^[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), expected) ||
      body.schemaVersion !== 1 ||
      body.scope.ownerKey !== scope.ownerKey ||
      body.scope.environment !== scope.environment ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0 ||
      ![
        'holdoutConsumptions',
        'caseExposures',
        'protocolProposals',
        'trainingReservations',
        'cancelledSessions',
        'deletedAssetIds',
        'invalidatedAdapters',
        'deletedSourceIds',
        'dailyDeletedRunDigests',
      ].every((key) => Array.isArray((body as unknown as Record<string, unknown>)[key]))
    )
      throw new Error('ledger integrity');
    return body;
  } catch (cause) {
    throw new RsiError('safety_ledger_unavailable', 503, cause);
  }
}
function merge<T>(left: T[], right: T[], key: (item: T) => string): T[] {
  return [...new Map([...left, ...right].map((item) => [key(item), item])).values()];
}
/** Only monotonically restrictive state is restored; no candidate/policy provenance comes from this journal. */
export function applySafetyLedger(state: RsiState, ledger: SafetyLedger): void {
  state.holdoutConsumptions = merge(
    state.holdoutConsumptions,
    ledger.holdoutConsumptions,
    (item) => item.digest
  );
  state.caseExposures = merge(state.caseExposures, ledger.caseExposures, (item) => item.digest);
  state.protocolProposals = [
    ...new Set([...(state.protocolProposals ?? []), ...ledger.protocolProposals]),
  ];
  state.trainingReservations = merge(
    state.trainingReservations ?? [],
    ledger.trainingReservations,
    (item) => item.id
  );
  const value = (state.assets ??= defaultRsiAssets());
  value.deletedIds = [...new Set([...value.deletedIds, ...ledger.deletedAssetIds])];
  value.invalidatedAdapters = [
    ...new Set([...value.invalidatedAdapters, ...ledger.invalidatedAdapters]),
  ];
  for (const record of value.records)
    if (value.deletedIds.includes(record.id)) record.deletedAt ??= Date.now();
  // Preserve source IDs even when the signed backup predates their asset index entries.
  state.deletedTrainingSources = merge(
    state.deletedTrainingSources ?? [],
    ledger.deletedSourceIds,
    (item) => `${item.taskScopeDigest}:${item.id}`
  );
  for (const session of state.trainingSessions ?? [])
    if (
      ledger.cancelledSessions.includes(session.id) ||
      (session.candidateDigest && value.invalidatedAdapters.includes(session.candidateDigest))
    )
      session.status = 'cancelled';
  state.candidates = state.candidates.filter(
    (candidate) => !value.invalidatedAdapters.includes(candidate.adapter.digest)
  );
  for (const policy of [state.policy, ...Object.values(state.trainingPolicies ?? {})]) {
    if (
      value.invalidatedAdapters.includes(policy.activeDigest) ||
      (policy.previousDigest && value.invalidatedAdapters.includes(policy.previousDigest))
    ) {
      policy.activeDigest = RSI_BASELINE.digest;
      policy.previousDigest = null;
      policy.version += 1;
      policy.updatedAt = Date.now();
    }
  }
  if (state.daily) {
    state.daily.deletedRunDigests = [
      ...new Set([...state.daily.deletedRunDigests, ...ledger.dailyDeletedRunDigests]),
    ];
    state.daily.experiences = state.daily.experiences.filter(
      (item) => !state.daily!.deletedRunDigests.includes(item.id)
    );
  }
}
/** Journal commits first: interrupted main-index replacement may over-consume, never refund. */
export function writeSafetyLedger(directory: string, state: RsiState): void {
  const previous = readSafetyLedger(directory, state.scope);
  const body: SafetyLedger = {
    schemaVersion: 1,
    scope: state.scope,
    revision: Math.max(state.revision, previous?.revision ?? 0),
    holdoutConsumptions: merge(
      previous?.holdoutConsumptions ?? [],
      state.holdoutConsumptions,
      (item) => item.digest
    ),
    caseExposures: merge(previous?.caseExposures ?? [], state.caseExposures, (item) => item.digest),
    protocolProposals: [
      ...new Set([...(previous?.protocolProposals ?? []), ...(state.protocolProposals ?? [])]),
    ],
    trainingReservations: merge(
      previous?.trainingReservations ?? [],
      state.trainingReservations ?? [],
      (item) => item.id
    ),
    cancelledSessions: [
      ...new Set([
        ...(previous?.cancelledSessions ?? []),
        ...(state.trainingSessions ?? [])
          .filter((session) => session.status === 'cancelled')
          .map((session) => session.id),
      ]),
    ],
    deletedAssetIds: [
      ...new Set([...(previous?.deletedAssetIds ?? []), ...(state.assets?.deletedIds ?? [])]),
    ],
    invalidatedAdapters: [
      ...new Set([
        ...(previous?.invalidatedAdapters ?? []),
        ...(state.assets?.invalidatedAdapters ?? []),
      ]),
    ],
    deletedSourceIds: merge(
      previous?.deletedSourceIds ?? [],
      [
        ...(state.deletedTrainingSources ?? []),
        ...(state.assets?.records ?? [])
          .filter((item) => item.deletedAt)
          .flatMap((item) =>
            [item.id, ...(item.sourceId ? [item.sourceId] : [])].map((id) => ({
              id,
              taskScopeDigest: item.taskScopeDigest,
            }))
          ),
      ],
      (item) => `${item.taskScopeDigest}:${item.id}`
    ),
    dailyDeletedRunDigests: [
      ...new Set([
        ...(previous?.dailyDeletedRunDigests ?? []),
        ...(state.daily?.deletedRunDigests ?? []),
      ]),
    ],
    liveReferences:
      state.runs.some((run) => run.outcome === 'running') ||
      Boolean(state.assets?.leases.some((lease) => ['running', 'revoked'].includes(lease.status))),
  };
  const signature = createHmac('sha256', backupKey(directory, true))
    .update(JSON.stringify(body))
    .digest('hex');
  const bytes = Buffer.from(JSON.stringify({ body, signature }));
  if (bytes.length > 16 * 1024 * 1024) throw new RsiError('safety_ledger_limit', 409);
  const file = assetPath(directory, 'safety-ledger.json'),
    temporary = assetPath(directory, `safety-ledger-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    const fd = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
/** Authenticated snapshots can repair corrupted immutable files; unrelated bytes remain untouched. */
export function repairSnapshotDocuments(directory: string, state: RsiState): void {
  for (const key of [
    'runs',
    'cases',
    'candidates',
    'evaluations',
    'trainingSessions',
    'trainingConfirmations',
  ] as const) {
    for (const record of state[key] ?? []) {
      const bytes = Buffer.from(JSON.stringify(record));
      const file = assetPath(directory, 'documents', key, `${byteDigest(bytes)}.json`);
      if (!fs.existsSync(file)) continue;
      if (fs.readFileSync(file).equals(bytes)) continue;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
  }
}
