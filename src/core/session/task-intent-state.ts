import type {
  TaskIntentChange,
  TaskIntentSnapshot,
  TaskIntentState,
  TurnDecision,
} from '../../contracts/task-intent.js';
import type { SessionInboxEntry } from './session-inbox.js';

export const TURN_DECISION_TOOL = 'turn_decision';

/** Persistence is a trust boundary too: malformed receipts must never unlock actions. */
export function validatePersistedTaskIntent(input: unknown): void {
  const value = record(input);
  const integer = (item: unknown): boolean => Number.isSafeInteger(item) && Number(item) >= 0;
  if (
    !['pending', 'projecting', 'committed', 'needs_clarification', 'failed'].includes(
      String(value.status)
    ) ||
    (value.invalidateTask !== undefined && typeof value.invalidateTask !== 'boolean') ||
    (value.taskId !== undefined && typeof value.taskId !== 'string') ||
    (value.revision !== undefined && !integer(value.revision)) ||
    (value.expectedTaskRevision !== undefined && !integer(value.expectedTaskRevision)) ||
    (value.digest !== undefined &&
      (typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)))
  ) {
    throw new Error('Invalid persisted task intent receipt');
  }
  if (value.status === 'projecting' && (!value.snapshot || !integer(value.expectedTaskRevision))) {
    throw new Error('Incomplete persisted task intent projection');
  }
  if (value.snapshot !== undefined) {
    const snapshot = record(value.snapshot);
    const state = record(snapshot.state);
    if (
      !['revision', 'inputSeq', 'processedSeq'].every((key) => integer(snapshot[key])) ||
      Number(snapshot.processedSeq) > Number(snapshot.inputSeq) ||
      !['answer', 'execute', 'clarify', 'cancel'].includes(String(snapshot.disposition)) ||
      typeof snapshot.pending !== 'boolean' ||
      typeof snapshot.planId !== 'string' ||
      (snapshot.taskId !== undefined && typeof snapshot.taskId !== 'string') ||
      !['goal', 'target', 'executionSurface'].every((key) => typeof state[key] === 'string')
    ) {
      throw new Error('Invalid persisted task intent snapshot');
    }
    strings(snapshot.plan, 'persisted plan', 32);
    if (snapshot.planDependsOn !== undefined)
      strings(snapshot.planDependsOn, 'persisted plan dependencies', 32);
    strings(state.constraints, 'persisted constraints', Number.MAX_SAFE_INTEGER);
    strings(state.responseRequirements, 'persisted response requirements', Number.MAX_SAFE_INTEGER);
    for (const sources of Object.values(record(state.sources))) {
      if (
        !Array.isArray(sources) ||
        !sources.every(
          (source) =>
            source && typeof source.messageId === 'string' && typeof source.quote === 'string'
        )
      ) {
        throw new Error('Invalid persisted task intent sources');
      }
    }
  }
  if (value.projection !== undefined) {
    const projection = record(value.projection);
    const changes = record(projection.changes);
    if (
      typeof projection.revisionId !== 'string' ||
      !integer(projection.expectedRevision) ||
      (changes.goal !== undefined && typeof changes.goal !== 'string') ||
      (changes.targetDeviceId !== undefined && typeof changes.targetDeviceId !== 'string')
    ) {
      throw new Error('Invalid persisted native task projection');
    }
    strings(projection.sourceMessageIds, 'projection messageIds', 500);
    if (changes.constraints !== undefined)
      strings(changes.constraints, 'projection constraints', Number.MAX_SAFE_INTEGER);
  }
}

export function emptyTaskIntent(): TaskIntentSnapshot {
  return {
    revision: 0,
    inputSeq: 0,
    processedSeq: 0,
    state: {
      goal: '',
      target: '',
      executionSurface: '',
      constraints: [],
      responseRequirements: [],
      sources: {},
    },
    planId: '',
    plan: [],
    disposition: 'answer',
    pending: false,
  };
}

export function readTaskIntent(entries: readonly SessionInboxEntry[]): TaskIntentSnapshot {
  const latest = entries
    .filter((entry) => entry.intent?.snapshot && entry.intent.status !== 'failed')
    .at(-1)?.intent?.snapshot;
  const snapshot = latest ? structuredClone(latest) : emptyTaskIntent();
  snapshot.inputSeq = Math.max(0, ...entries.filter((e) => e.intent).map((e) => e.admittedSeq));
  snapshot.pending = entries.some(
    (entry) => entry.intent && ['pending', 'projecting', 'failed'].includes(entry.intent.status)
  );
  return snapshot;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('turn_decision must be an object');
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, name: string, limit: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    !value.every((item) => typeof item === 'string' && item.trim() && item.length <= 4000)
  ) {
    throw new Error(`Invalid ${name}`);
  }
  return value as string[];
}

export function parseTurnDecision(input: unknown): TurnDecision {
  const value = record(input);
  const dispositions = ['answer', 'execute', 'clarify', 'cancel'];
  if (
    !Number.isSafeInteger(value.baseRevision) ||
    (value.baseRevision as number) < 0 ||
    !Number.isSafeInteger(value.inputSeq) ||
    (value.inputSeq as number) < 1 ||
    !dispositions.includes(String(value.disposition)) ||
    !Array.isArray(value.changes) ||
    value.changes.length > 64
  ) {
    throw new Error('Invalid turn_decision revision, sequence, disposition, or changes');
  }
  const changes = value.changes.map((raw): TaskIntentChange => {
    const item = record(raw);
    const scalar = ['goal', 'target', 'executionSurface'].includes(String(item.field));
    const list = ['constraints', 'responseRequirements'].includes(String(item.field));
    if (
      (!scalar && !list) ||
      (scalar ? item.operation !== 'set' : !['add', 'remove'].includes(String(item.operation))) ||
      !['value', 'messageId', 'quote'].every(
        (key) => typeof item[key] === 'string' && (item[key] as string).trim()
      ) ||
      (item.value as string).length > 4000 ||
      (item.quote as string).length > 4000
    ) {
      throw new Error('Invalid task intent change; lists require add/remove, scalars require set');
    }
    return item as unknown as TaskIntentChange;
  });
  const rawCorrections = value.contextCorrections ?? [];
  if (!Array.isArray(rawCorrections) || rawCorrections.length > 16)
    throw new Error('Invalid context corrections');
  const contextCorrections = rawCorrections.map((raw) => {
    const item = record(raw);
    if (
      !['targetId', 'messageId', 'quote'].every(
        (key) =>
          typeof item[key] === 'string' &&
          (item[key] as string).trim() &&
          (item[key] as string).length <= 4000
      )
    )
      throw new Error('Invalid context correction source');
    return {
      targetId: item.targetId as string,
      messageId: item.messageId as string,
      quote: item.quote as string,
    };
  });
  const plan = strings(value.plan, 'plan', 32);
  if (value.disposition === 'execute' && plan.length === 0) {
    throw new Error('execute requires a non-empty plan');
  }
  if (value.disposition !== 'execute' && plan.length > 0) {
    throw new Error('Only execute may submit an executable plan');
  }
  return {
    baseRevision: value.baseRevision as number,
    inputSeq: value.inputSeq as number,
    messageIds: strings(value.messageIds, 'messageIds', 500),
    changes,
    ...(contextCorrections.length ? { contextCorrections } : {}),
    disposition: value.disposition as TurnDecision['disposition'],
    plan,
    ...(value.planDependsOn === undefined
      ? {}
      : { planDependsOn: strings(value.planDependsOn, 'plan dependencies', 32) }),
  };
}

export function applyIntentChanges(
  current: TaskIntentState,
  changes: readonly TaskIntentChange[],
  inputs: readonly SessionInboxEntry[]
): TaskIntentState {
  const state = structuredClone(current);
  for (const change of changes) {
    const source = inputs.find((entry) => entry.id === change.messageId);
    if (!source || !source.prompt.includes(change.quote)) {
      throw new Error('Task changes must cite an exact quote from a pending user input');
    }
    if (change.field === 'constraints' || change.field === 'responseRequirements') {
      const values = state[change.field];
      if (change.operation === 'add') {
        if (!values.includes(change.value)) values.push(change.value);
      } else {
        state[change.field] = values.filter((value) => value !== change.value);
      }
    } else {
      state[change.field] = change.value;
    }
    (state.sources[change.field] ??= []).push({
      messageId: change.messageId,
      quote: change.quote,
    });
  }
  return state;
}

export const turnDecisionSchema = {
  type: 'object' as const,
  properties: {
    baseRevision: { type: 'integer' },
    inputSeq: { type: 'integer' },
    messageIds: { type: 'array', items: { type: 'string' } },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            enum: ['goal', 'target', 'executionSurface', 'constraints', 'responseRequirements'],
          },
          operation: { type: 'string', enum: ['set', 'add', 'remove'] },
          value: { type: 'string' },
          messageId: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['field', 'operation', 'value', 'messageId', 'quote'],
        additionalProperties: false,
      },
    },
    contextCorrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targetId: { type: 'string' },
          messageId: { type: 'string' },
          quote: { type: 'string' },
        },
        required: ['targetId', 'messageId', 'quote'],
        additionalProperties: false,
      },
    },
    disposition: { type: 'string', enum: ['answer', 'execute', 'clarify', 'cancel'] },
    plan: { type: 'array', items: { type: 'string' } },
    planDependsOn: { type: 'array', items: { type: 'string' } },
  },
  required: ['baseRevision', 'inputSeq', 'messageIds', 'changes', 'disposition', 'plan'],
  additionalProperties: false,
};

/** The session runtime already captured the receipt envelope for this model request. */
export const versionedTurnDecisionSchema = {
  type: 'object' as const,
  properties: {
    disposition: turnDecisionSchema.properties.disposition,
    contextCorrections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          targetId: {
            type: 'string',
            description: 'ID of the superseded assistant conclusion or active claim.',
          },
          quote: {
            type: 'string',
            description: 'Copy an exact substring from the pending user correction.',
          },
          messageId: {
            type: 'string',
            description: 'Only needed when the same quote occurs in multiple pending user inputs.',
          },
        },
        required: ['targetId', 'quote'],
        additionalProperties: false,
      },
    },
    changes: {
      ...turnDecisionSchema.properties.changes,
      description:
        'Omit for a read-only answer or historical correction. Only include actual task amendments.',
    },
    plan: {
      ...turnDecisionSchema.properties.plan,
      description: 'Required for execute. Omit for answer, clarify and cancel.',
    },
    planDependsOn: turnDecisionSchema.properties.planDependsOn,
    answer: {
      type: 'string',
      description: 'For answer, clarify and cancel, include the complete user-facing reply here.',
    },
  },
  required: ['disposition'],
  additionalProperties: false,
};

export const readOnlyTurnDecisionSchema = {
  ...versionedTurnDecisionSchema,
  properties: {
    disposition: { type: 'string', enum: ['answer', 'clarify', 'cancel'] },
    answer: versionedTurnDecisionSchema.properties.answer,
    contextCorrections: versionedTurnDecisionSchema.properties.contextCorrections,
    changes: versionedTurnDecisionSchema.properties.changes,
  },
};
