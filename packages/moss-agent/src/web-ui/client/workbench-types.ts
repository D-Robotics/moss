export type RunStatus =
  | 'created'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type RuntimeMode = 'plan' | 'default' | 'acceptEdits';
export type SettingsSection =
  | 'general'
  | 'models'
  | 'permissions'
  | 'skills'
  | 'mcp'
  | 'plugins'
  | 'runtime';

export interface WorkspaceSummary {
  id: string;
  name: string;
  current: boolean;
}
export interface SessionSummary {
  sessionId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  runId?: string;
  runStatus?: RunStatus;
  snippet?: string;
}
export interface RunSnapshot {
  id: string;
  sessionId: string;
  title: string;
  status: RunStatus;
  verification: string;
  evidenceCount: number;
  updatedAt: number;
}
export interface BootstrapResponse {
  csrfToken: string;
  tools: string[];
  plugins: PluginSnapshot[];
  taskRuns: RunSnapshot[];
  model: string;
}
export interface PluginSnapshot {
  id: string;
  state: string;
  tools: string[];
  webContributions?: string[];
}
export interface InstalledPlugin {
  id: string;
  version: string;
  enabled: boolean;
}
export interface WebContribution {
  pluginId: string;
  id: string;
  slot: string;
  moduleUrl: string;
}
export interface PluginInventory {
  installed: InstalledPlugin[];
  active: PluginSnapshot[];
  contributions: WebContribution[];
}

export type TimelineItem =
  | {
      id: string;
      kind: 'user' | 'assistant' | 'reasoning' | 'status';
      text: string;
      state?: string;
    }
  | {
      id: string;
      kind: 'tool';
      name: string;
      state: 'running' | 'complete' | 'failed';
      input?: unknown;
      result?: unknown;
    }
  | { id: string; kind: 'retry'; attempt: number; text: string }
  | {
      id: string;
      kind: 'compaction';
      summaryChars: number;
      droppedMessages: number;
      outline?: string[];
    }
  | { id: string; kind: 'usage'; inputTokens: number; outputTokens: number; contextTokens?: number }
  | {
      id: string;
      kind: 'context';
      status: string;
      reason: string;
      goal: string;
      nextAction: string;
    };

export type StreamEvent =
  | { type: 'run'; run: RunSnapshot }
  | { type: 'text' | 'thought'; delta: string }
  | {
      type: 'tool';
      state: 'start' | 'end';
      toolCallId: string;
      name: string;
      input?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | { type: 'retry'; attempt: number; error: string }
  | {
      type: 'compaction';
      summaryChars: number;
      droppedMessages: number;
      checkpointOutline?: string[];
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number; contextTokens?: number }
  | { type: 'context'; status: string; reason: string; goal: string; nextAction: string }
  | { type: 'interrupted'; reason: string; run: RunSnapshot }
  | { type: 'done'; stopReason: string; run?: RunSnapshot }
  | { type: 'error'; message: string };

export interface Interaction {
  id: string;
  kind: 'approval' | 'question';
  prompt: string;
  state: string;
  createdAt: number;
}
export interface MentionInventory {
  skills: string[];
  experts: string[];
  commands: string[];
}
export interface RuntimeInventory {
  [key: string]: unknown;
}
export interface GoalSnapshot {
  objective?: string;
  status?: string;
  reason?: string;
}
export interface TodoSnapshot {
  id?: string;
  text?: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}
export interface JobSnapshot {
  id: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}
export interface ExecutionEvidenceView {
  id: string;
  nodeId?: string;
  kind: string;
  summary: string;
  artifactRef?: string;
  metadata?: Record<string, unknown>;
}
export interface ExecutionGraphSnapshot {
  id: string;
  sessionId?: string;
  goal: string;
  status: string;
  revision: number;
  budget: Record<string, number | undefined>;
  nodes: Record<
    string,
    {
      id: string;
      title: string;
      kind: string;
      status: string;
      roleId?: string;
      dependencies: string[];
      attempts: number;
      workspaceLeaseId?: string;
      evidenceIds: string[];
      error?: string;
    }
  >;
  evidence: ExecutionEvidenceView[];
  verification?: { verdict: string; evidenceIds: string[]; reasons: string[] };
  recovery?: { requiresUserResume: boolean; interruptedNodeIds: string[] };
}
export interface ExecutionView {
  graphId: string;
  sessionId?: string;
  goal: string;
  status: string;
  revision: number;
  updatedAt: number;
  budget: Record<string, number | undefined>;
  nodes: Array<{
    id: string;
    title: string;
    kind: string;
    status: string;
    roleId?: string;
    dependencies: string[];
    attempts: number;
    evidenceIds: string[];
    error?: string;
    acceptanceContract?: {
      revision: number;
      criteria: Array<{ id: string; description: string; required: boolean }>;
    };
  }>;
  evidence: ExecutionEvidenceView[];
  patches: ExecutionEvidenceView[];
  conflicts: Array<{ id: string; title: string; status: string }>;
  roleNodeIds: Record<string, string[]>;
  verification?: { verdict: string; evidenceIds: string[]; reasons: string[] };
  deliveryCase?: {
    graphId: string;
    revision: number;
    depth: string;
    riskLevel: string;
    stage: string;
    requirements: Array<{ id: string; statement: string; required: boolean }>;
    elaborationRounds: Array<{
      id: string;
      index: number;
      resolved: boolean;
      conflicts?: string[];
      missingItems?: string[];
      questions: Array<{
        id: string;
        prompt: string;
        options: string[];
        required?: boolean;
        answer?: string | string[];
        status: string;
      }>;
    }>;
    proposal?: {
      revision: number;
      summary: string;
      requiresApproval: boolean;
      approvedAt?: number;
      approvalEvidenceId?: string;
      nonGoals?: string[];
      risks?: string[];
      permissions?: string[];
      workspaceStrategy?: string;
      nodePlans?: Array<{
        nodeId: string;
        roleId?: string;
        writePaths: string[];
        acceptanceRevision?: number;
      }>;
    };
    proposalHistory: Array<{
      revision: number;
      summary: string;
      requirementIds?: string[];
      nodeIds?: string[];
    }>;
    decisions: Array<{ id: string; summary: string; rationale: string }>;
    artifacts: Array<{
      id: string;
      kind: string;
      evidenceId: string;
      digest?: string;
      requirementIds?: string[];
    }>;
  };
  reviews: Array<{
    scope: string;
    round: number;
    verdict: string;
    roleId: string;
    notes: string[];
    blockers: string[];
  }>;
  completionReport?: {
    summary: string;
    knownLimitations: string[];
    followUps: string[];
    requirementCoverage?: Array<{
      requirementId: string;
      covered: boolean;
      evidenceIds: string[];
    }>;
  };
}
export interface WorkflowSnapshot {
  id: string;
  title?: string;
  status?: string;
  [key: string]: unknown;
}
export interface SettingsSnapshot {
  values?: Record<string, unknown>;
  schema?: JsonSchema;
  configured?: Record<string, boolean>;
  credentials?: Record<string, { configured: boolean }>;
  [key: string]: unknown;
}
export interface JsonSchema {
  title?: string;
  description?: string;
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  secret?: boolean;
  writeOnly?: boolean;
}
export interface PluginConfigResponse {
  schema: JsonSchema;
  config: { values: Record<string, unknown>; secrets: Record<string, { configured: boolean }> };
  generation: number;
  restartRequired: false;
}

export interface SessionPreference {
  draft: string;
  scrollTop: number;
  detailsOpen: boolean;
  selectedPanel: string;
  delivery: 'queue' | 'steer';
  runId?: string;
  eventCursor?: number;
}
export interface WorkbenchPreferences {
  workspaceId?: string;
  sessionId?: string;
  model?: string;
  mode: RuntimeMode;
  permissionPreset: 'cautious' | 'balanced' | 'autonomous';
  settingsSection: SettingsSection;
  sessions: Record<string, SessionPreference>;
}
