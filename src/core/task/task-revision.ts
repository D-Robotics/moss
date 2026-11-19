import type { TaskContract } from '../../contracts/task.js';
import { isDeepStrictEqual } from 'node:util';
import type { TaskStateSnapshot } from '../../contracts/task-runtime.js';
import { ErrorCode, MossError } from '../../errors.js';
import { listTaskRecords } from '../task-runtime/artifacts.js';
import { isTaskAcceptanceSettling } from './acceptance-commit-scope.js';
import {
  appendTaskEventUnlocked,
  getTaskStateSnapshot,
  listTaskEvents,
  withTaskEventLock,
} from './task-store.js';

export type TaskRevisionChanges = Partial<
  Pick<
    TaskContract,
    | 'goal'
    | 'constraints'
    | 'targetDeviceId'
    | 'expectedBehavior'
    | 'acceptanceCriteria'
    | 'verificationPlan'
  >
>;

export interface ApplyTaskRevisionInput {
  expectedRevision: number;
  revisionId: string;
  changes: TaskRevisionChanges;
  sourceMessageIds: string[];
}

const fields = new Set([
  'goal',
  'constraints',
  'targetDeviceId',
  'expectedBehavior',
  'acceptanceCriteria',
  'verificationPlan',
]);

function validateRevision(input: ApplyTaskRevisionInput): void {
  const invalid = (message: string): never => {
    throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
  };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    invalid('expectedRevision must be a nonnegative integer');
  if (!input.revisionId?.trim() || input.revisionId.length > 512)
    invalid('revisionId must be a nonempty string of at most 512 characters');
  if (
    !Array.isArray(input.sourceMessageIds) ||
    input.sourceMessageIds.length === 0 ||
    input.sourceMessageIds.length > 128 ||
    input.sourceMessageIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 512)
  )
    invalid('sourceMessageIds must identify the user input being applied');
  if (!input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes))
    invalid('changes must be an object');
  const entries = Object.entries(input.changes);
  if (entries.some(([field]) => !fields.has(field)))
    invalid('changes contains unsupported task fields');
  for (const [field, value] of entries) {
    if (field === 'acceptanceCriteria') {
      if (
        !Array.isArray(value) ||
        value.some(
          (item: unknown) =>
            !item ||
            typeof item !== 'object' ||
            typeof (item as { metric?: unknown }).metric !== 'string' ||
            !(item as { metric: string }).metric.trim() ||
            typeof (item as { expected?: unknown }).expected !== 'string' ||
            !(item as { expected: string }).expected.trim()
        )
      )
        invalid('acceptanceCriteria must contain metrics and expectations');
    } else if (field === 'constraints' || field === 'verificationPlan') {
      if (!Array.isArray(value) || value.some((item: unknown) => typeof item !== 'string'))
        invalid(`${field} must be an array of strings`);
    } else if (typeof value !== 'string' || (field === 'goal' && !value.trim())) {
      invalid(`${field} must be a string${field === 'goal' ? ' with a nonempty goal' : ''}`);
    }
  }
}

/** One authoritative event commits the contract revision and invalidates its old plan. */
export async function applyTaskRevision(
  workspaceDir: string,
  taskId: string,
  input: ApplyTaskRevisionInput
): Promise<TaskStateSnapshot> {
  validateRevision(input);
  return withTaskEventLock(workspaceDir, async () => {
    const events = await listTaskEvents(workspaceDir, taskId);
    const prior = events.find(
      (event) => event.type === 'task_revised' && event.data?.revisionId === input.revisionId
    );
    if (prior) {
      if (
        prior.data?.previousRevision !== input.expectedRevision ||
        !isDeepStrictEqual(prior.data?.changes, input.changes) ||
        JSON.stringify(prior.data?.sourceMessageIds) !== JSON.stringify(input.sourceMessageIds)
      ) {
        throw new MossError({
          code: ErrorCode.EXECUTION_REVISION_CONFLICT,
          message: `task ${taskId}: revisionId was already used for different input`,
        });
      }
      const restored = await getTaskStateSnapshot(workspaceDir, taskId);
      if (restored) return restored;
    }
    const contract = (await listTaskRecords(workspaceDir, Number.MAX_SAFE_INTEGER)).find(
      (task) => task.taskId === taskId
    );
    const snapshot = await getTaskStateSnapshot(workspaceDir, taskId);
    if (!contract || !snapshot) {
      throw new MossError({
        code: ErrorCode.USER_INPUT_INVALID,
        message: `task ${taskId} not found`,
      });
    }
    if (snapshot.revision !== input.expectedRevision) {
      throw new MossError({
        code: ErrorCode.EXECUTION_REVISION_CONFLICT,
        message: `task ${taskId}: expected revision ${input.expectedRevision}, got ${snapshot.revision}`,
      });
    }
    if (
      snapshot.phase === 'accepted' ||
      contract.status === 'accepted' ||
      isTaskAcceptanceSettling(workspaceDir, taskId) ||
      snapshot.lastVerdict?.verdict === 'pass'
    ) {
      throw new MossError({
        code: ErrorCode.EXECUTION_STATE_INVALID,
        message: `task ${taskId}: an accepted or settling task requires a new task`,
      });
    }
    const revised: TaskContract = {
      ...contract,
      ...input.changes,
      originalGoal: contract.originalGoal ?? contract.goal,
      revision: snapshot.revision + 1,
      status: 'active',
      updatedAt: Date.now(),
    };
    await appendTaskEventUnlocked(workspaceDir, taskId, 'task_revised', {
      revisionId: input.revisionId,
      previousRevision: snapshot.revision,
      revision: revised.revision,
      changes: input.changes,
      sourceMessageIds: input.sourceMessageIds,
      contract: revised,
      steps: [],
    });
    const committed = await getTaskStateSnapshot(workspaceDir, taskId);
    if (!committed) throw new Error(`task ${taskId}: revision commit cannot be read`);
    return committed;
  });
}
