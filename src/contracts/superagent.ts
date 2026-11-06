/** An authenticated host request. Source adapters, never model text, establish actor identity. */
export interface SuperagentRequest {
  id: string;
  source: string;
  actor: string;
  thread: string;
  text: string;
  human: boolean;
  addressed?: boolean;
}

export interface SuperagentRule {
  id: string;
  instruction: string;
}

export interface SuperagentConfig {
  acceptanceCommand: string;
  allowedActors: Record<string, string[]>;
  acceptMode: 'off' | 'observe' | 'auto';
  rules: SuperagentRule[];
  maxWorkers: number;
  maxWallMs: number;
}

/** Selected public projection; credentials and provider settings are never persisted here. */
export interface SuperagentTicketView {
  id: string;
  title: string;
  scope: string;
  state: string;
  summary?: string;
  workspace?: string;
  sessionKey?: string;
  taskId?: string;
  outcome?: string;
}

export interface SuperagentWorkerInput {
  id: string;
  text: string;
  contextOnly: boolean;
}

export interface SuperagentWorkRequest {
  ticketId: string;
  assignmentId: string;
  workspaceDir: string;
  sessionKey: string;
  scope: string;
  acceptanceCommand: string;
  taskId?: string;
  inputs: SuperagentWorkerInput[];
}

export interface SuperagentWorkerResult {
  state: 'ready' | 'blocked' | 'failed';
  summary: string;
  taskId?: string;
  readInputIds: string[];
  /** B167: model the native task ran on, when the worker knows it. */
  model?: string;
  /** B165: usage accumulated by the native task turns of this dispatch. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
  };
}

export interface SuperagentAssessment {
  kind: 'accept' | 'ignore';
  scope: string;
  reason: string;
  rules: string[];
}
