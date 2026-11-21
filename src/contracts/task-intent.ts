/** A host-identified user input, separate from autonomous engine prompts. */
export interface TaskIntentInput {
  id: string;
  text: string;
  taskId?: string;
  invalidateTask?: boolean;
}

export interface TaskIntentState {
  goal: string;
  target: string;
  executionSurface: string;
  constraints: string[];
  responseRequirements: string[];
  sources: Record<string, { messageId: string; quote: string }[]>;
}

export interface TaskIntentSnapshot {
  revision: number;
  inputSeq: number;
  processedSeq: number;
  state: TaskIntentState;
  taskId?: string;
  planId: string;
  plan: string[];
  planDependsOn?: string[];
  disposition: 'answer' | 'execute' | 'clarify' | 'cancel';
  pending: boolean;
}

export interface TaskIntentChange {
  field: 'goal' | 'target' | 'executionSurface' | 'constraints' | 'responseRequirements';
  operation: 'set' | 'add' | 'remove';
  value: string;
  messageId: string;
  quote: string;
}

export interface TurnDecision {
  baseRevision: number;
  inputSeq: number;
  messageIds: string[];
  changes: TaskIntentChange[];
  contextCorrections?: { targetId: string; messageId: string; quote: string }[];
  disposition: TaskIntentSnapshot['disposition'];
  plan: string[];
  planDependsOn?: string[];
}

export interface TaskIntentReceipt {
  status: 'pending' | 'committed' | 'needs_clarification' | 'failed';
  revision?: number;
}

/** Stored inside the existing durable inbox; a projection is replayable. */
export interface TaskIntentEntryState {
  taskId?: string;
  invalidateTask?: boolean;
  status: TaskIntentReceipt['status'] | 'projecting';
  revision?: number;
  /** Compact dedupe tombstones retain identity after full inbox payload pruning. */
  digest?: string;
  expectedTaskRevision?: number;
  snapshot?: TaskIntentSnapshot;
  projection?: {
    revisionId: string;
    expectedRevision: number;
    sourceMessageIds: string[];
    changes: { goal?: string; constraints?: string[]; targetDeviceId?: string };
  };
}
