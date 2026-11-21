import type { LLMMessage } from './llm-messages.js';

export type ContextMessageOrigin = 'user' | 'assistant' | 'tool' | 'runtime' | 'legacy';

export interface ContextSourceMessage {
  id: string;
  ordinal: number;
  origin: ContextMessageOrigin;
  generatedRevision?: number;
  message: LLMMessage;
}

export interface ContextCorrection {
  id: string;
  targetId: string;
  text: string;
}

export interface CommittedContextCorrection extends ContextCorrection {
  revision: number;
  fromOrdinal: number;
  throughOrdinal: number;
}

export interface ContextSummaryEntry {
  kind: 'observation' | 'user_decision' | 'proposal' | 'unverified';
  text: string;
  sourceIds: string[];
}

export interface ContextCheckpoint {
  revision: number;
  throughOrdinal: number;
  sourceHash: string;
  policy: string;
  entries: ContextSummaryEntry[];
}

export interface VersionedContextSnapshot {
  revision: number;
  messages: ContextSourceMessage[];
  corrections: CommittedContextCorrection[];
  claims: ContextClaim[];
}

/** Model statements remain historical data; only the task ledger establishes acceptance. */
export interface ContextClaimDraft {
  text: string;
  sourceIds: string[];
  dependsOn: string[];
}

export interface ContextClaim extends ContextClaimDraft {
  id: string;
  ordinal: number;
  status: 'active' | 'invalidated';
}
