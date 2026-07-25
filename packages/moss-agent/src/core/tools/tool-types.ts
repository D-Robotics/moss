










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
  /** Per-run numeric ceilings for tool inputs. Hosts can constrain expensive
   *  parameters without hiding the tool or trusting the model to self-limit. */
  toolInputLimits?: Record<string, Record<string, number>>;
  /** Per-run tool arguments enforced by the host after model generation. */
  toolInputOverrides?: Record<string, Record<string, string | number | boolean>>;
  asyncTaskRegistry?: MossAsyncTaskRegistry;
  toolCallId?: string;
  /** Optional callback for live tool output — the TUI / headless renderer
   *  uses this to show incremental output from long-running commands (e.g.
   *  `npm install`, `pytest`) instead of buffering until the tool finishes. */
  onToolOutput?: (text: string) => void;
  spawnSubagent?: (params: {
    task: string;
    label?: string;
    cleanup?: 'keep' | 'delete';
    scope?: string;
    maxTurns?: number;
    timeoutMs?: number;
    /** Override the sub-agent's model (e.g. a cheaper model for exploration, a
     *  stronger one for a critical decision). The provider routes by model id. */
    model?: string;
    /** Override the sub-agent's system prompt for this run only (e.g. the
     *  plan-critic injects its critique prompt without touching parent state).
     *  When set, the child runs with this prompt instead of the parent's. */
    systemPromptOverride?: string;
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
