










import type { MossAsyncTaskRegistry } from '@rdk-moss/core/contracts/async-task';

export interface SubagentRunProgress {
  runId: string;
  scope: string;
  task: string;
  status: 'started' | 'running' | 'completed' | 'failed';
  phase?: 'starting' | 'turn' | 'tool' | 'completed' | 'failed';
  turn?: number;
  maxTurns?: number;
  toolResults?: number;
  lastTool?: string;
  error?: string;
  summaryPreview?: string;
  elapsedMs?: number;
}

export interface ToolContext {
  workspaceDir: string;
  bootstrapDir?: string;
  extraAllowedRoots?: string[];
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  abortSignal?: AbortSignal;
  asyncTaskRegistry?: MossAsyncTaskRegistry;
  toolCallId?: string;
  spawnSubagent?: (params: {
    task: string;
    label?: string;
    cleanup?: 'keep' | 'delete';
    scope?: string;
    maxTurns?: number;
    timeoutMs?: number;
    mode?: 'single' | 'fan-out' | 'pipeline';
    tasks?: Array<{ task: string; scope?: string }>;
    abortSignal?: AbortSignal;
    onProgress?: (progress: SubagentRunProgress) => void;
  }) => Promise<{
    runId: string;
    sessionKey: string;
    summary: string;
    success: boolean;
    turns?: number;
    toolResults?: number;
    durationMs?: number;
    error?: string;
  }>;
  maxSpawnDepth?: number;
  currentSpawnDepth?: number;
}







export type ToolSideEffectClass =
  | 'readonly'
  | 'local_write'
  | 'device_mutation'
  | 'credential'
  | 'external_message'
  | 'memory_write'
  | 'runtime_state'
  | 'subagent';

export type ToolPlanMode = 'allow' | 'audit' | 'requires_user_confirmation';

export interface ToolMetadata {
  permissionBoundary?: string;
  sideEffectClass?: ToolSideEffectClass;
  planMode?: ToolPlanMode;
  



  requiresApproval?: boolean;
  ui?: {
    surface?: 'timeline' | 'block' | 'silent';
  };
  
  timeoutMs?: number;
  
  transientRetry?: boolean;
}

export interface Tool<TInput = any> {
  name: string;
  description: string;
  metadata?: ToolMetadata;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  





  normalizeInput?: (input: TInput, ctx?: Pick<ToolContext, 'sessionKey' | 'sessionId'>) => TInput;
  execute: (input: TInput, ctx: ToolContext) => Promise<string>;
  executeStructured?: (input: TInput, ctx: ToolContext) => Promise<StructuredToolResult>;
}





export function canHostInjectToolWithEmptyInput(tool: Tool): boolean {
  const req = tool.inputSchema?.required;
  return !req || req.length === 0;
}


export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ToolResultOutcome = 'ok' | 'error' | 'denied' | 'blocked' | 'replayed' | 'suppressed';


export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;
  
  outcome?: ToolResultOutcome;
  
  durationMs?: number;
  
  aborted?: { by: 'user' | 'timeout' };
  structuredContent?: ToolContentBlock[];
}

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; alt?: string }
  | { type: 'resource'; uri: string; name?: string; mimeType?: string; text?: string };

export interface StructuredToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
}
