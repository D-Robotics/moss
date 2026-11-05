import type { MossAsyncTaskRegistry } from '../../contracts/index.js';
import type { ToolContentBlock, ToolResultOutcome } from '../../contracts/messages.js';
import type { Message } from '../session/session-jsonl.js';

export type { ToolContentBlock, ToolResultOutcome } from '../../contracts/messages.js';

export interface SubagentRunProgress {
  runId: string;
  scope: string;
  task: string;
  status: 'started' | 'running' | 'completed' | 'failed';
  phase?: 'starting' | 'turn' | 'tool' | 'finalizing' | 'completed' | 'failed';
  turn?: number;
  maxTurns?: number;
  toolResults?: number;
  lastTool?: string;
  error?: string;
  summaryPreview?: string;
  elapsedMs?: number;
  /** Isolated workspace location, available once it has been created. */
  workspacePath?: string;
}

/** O152 F9b: one L3 post-run change (no file content). */
export interface ProtectedPathChangeReport {
  path: string;
  kind: string;
  keys?: string[];
  reason?: string;
  restoreOutcome?: string;
}

export interface ToolContext {
  workspaceDir: string;
  /**
   * B70: the run's effective prompt budget. Tool results are capped to a share
   * of it on very small windows, where the standard per-tool budget cannot fit
   * alongside the prompt and would be rejected by the provider.
   */
  contextWindowTokens?: number;
  /**
   * Whether the run's model accepts image input (default true). Tools that
   * attach image blocks (`read_image`) explain the limitation when false.
   */
  supportsImages?: boolean;
  /** Host-resolved configuration files to compare after shell execution. */
  protectedConfigPaths?: readonly string[];
  /**
   * D14: local `exec`/background exec run inside an OS sandbox (macOS
   * seatbelt, Linux bubblewrap) because the user opted in. A missing backend
   * refuses the command instead of running it unsandboxed.
   */
  osSandbox?: boolean;
  /**
   * O96: lets a string-returning tool mark its result as an error structurally
   * (e.g. exec timeout / signal kill) instead of relying on output text.
   */
  markResultError?: () => void;
  /**
   * O152 F9b: post-run protected-path detection (L3) reported as structured
   * data, so the run outcome / exit code never depends on the (truncatable)
   * output text carrying the marker.
   */
  reportProtectedPathChanges?: (changes: readonly ProtectedPathChangeReport[]) => void;
  /** Preserve a child workspace location in the tool result if this call is aborted. */
  reportWorkspaceRecoveryPath?: (workspacePath: string) => void;
  bootstrapDir?: string;
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
  abortSignal?: AbortSignal;
  /**
   * Set by runTask/resumeTask for the turns of that goal. Background exec
   * then waits until the command exits or timeout_ms. An explicit settle_ms
   * or wait:false on the tool call keeps the short settle.
   */
  goalExecWait?: boolean;
  /** Per-run numeric ceilings for tool inputs. Hosts can constrain expensive
   *  parameters without hiding the tool or trusting the model to self-limit. */
  toolInputLimits?: Record<string, Record<string, number>>;
  /** Per-run tool arguments enforced by the host after model generation. */
  toolInputOverrides?: Record<string, Record<string, string | number | boolean>>;
  /** Workspace-write confinement for shell commands: statically-extracted
   *  write targets of exec/exec_background must fall under one of these roots
   *  (same containment the file tools enforce). Undefined = unconstrained
   *  (full-access hosts / embedders take responsibility). */
  execWriteRoots?: string[];
  asyncTaskRegistry?: MossAsyncTaskRegistry;
  toolCallId?: string;
  /** Optional callback for live tool output — the TUI / headless renderer
   *  uses this to show incremental output from long-running commands (e.g.
   *  `npm install`, `pytest`) instead of buffering until the tool finishes. */
  onToolOutput?: (text: string) => void;
  /** Host-owned interactive question channel scoped to this agent instance. */
  askUserQuestion?: (question: string, abortSignal?: AbortSignal) => Promise<string>;
  /**
   * Whether the user can see a question on this run. `ask_user_question`
   * applies it only to the process-wide fallback asker. Omitted means
   * `process.stdin.isTTY`. Tests inject the value.
   */
  stdinIsTTY?: boolean;
  /**
   * `deny` blocks task_define / record_evidence. Ordinary chat sets this so a
   * status question cannot open a task contract. `/goal` and `moss task` leave
   * it unset or `allow`.
   */
  taskContracts?: 'allow' | 'deny';
  spawnSubagent?: (params: {
    task: string;
    /** Parent-relative coordination hints; not an enforced write boundary. */
    writePaths?: readonly string[];
    /** Run this writable worker in an isolated git worktree (lease-patch merge). */
    worktree?: boolean;
    label?: string;
    cleanup?: 'keep' | 'delete';
    scope?: string;
    /** Host-only exact tool allowlist; model-facing schemas do not expose this field. */
    allowedTools?: readonly string[];
    /** Host-only denylist applied even when the allowlist is omitted. */
    deniedTools?: readonly string[];
    maxTurns?: number;
    timeoutMs?: number;
    /** Override the sub-agent's model (e.g. a cheaper model for exploration, a
     *  stronger one for a critical decision). The provider routes by model id. */
    model?: string;
    /** Override the sub-agent's system prompt for this run only (e.g. the
     *  plan-critic injects its critique prompt without touching parent state).
     *  When set, the child runs with this prompt instead of the parent's. */
    systemPromptOverride?: string;
    /** Host-trusted expert instructions appended to the inherited system prompt. */
    expertPrompt?: string;
    /** Prior sub-agent conversation replayed before `task` (subagent_resume). */
    priorMessages?: readonly Message[];
    mode?: 'single' | 'fan-out' | 'pipeline';
    tasks?: Array<{
      task: string;
      scope?: string;
      writePaths?: readonly string[];
      allowedTools?: readonly string[];
    }>;
    abortSignal?: AbortSignal;
    onProgress?: (progress: SubagentRunProgress) => void;
  }) => Promise<{
    runId: string;
    /** Full child conversation; persisted by subagent tools so resume can replay it. */
    messages?: readonly Message[];
    sessionKey: string;
    summary: string;
    success: boolean;
    protectedPathChanges?: readonly ProtectedPathChangeReport[];
    turns?: number;
    toolResults?: number;
    durationMs?: number;
    error?: string;
    workspaceLeaseId?: string;
    workspacePath?: string;
    patchId?: string;
    patchRef?: string;
    patchDigest?: string;
    changedPaths?: readonly string[];
  }>;
  mergeWorkspacePatch?: (
    leaseId: string,
    patchId: string
  ) => Promise<{ status: 'merged' | 'merge_conflict'; conflictingPaths: readonly string[] }>;
  /**
   * Host hook for a tool name missing from this call's list. MCP uses it to
   * wait out an in-flight connect (bounded by that server's connect timeout)
   * and return the tool once the catalog has it.
   */
  resolveMissingTool?: (name: string, signal?: AbortSignal) => Promise<Tool | undefined>;
  /**
   * Reveal a deferred tool group (for example `subagent`) so the next model
   * call includes those schemas. Returns the note to show the model.
   */
  revealDeferredTools?: (group: string) => string;
  /** When set, replaces the generic "Unknown tool" line (failed MCP server). */
  describeMissingTool?: (name: string) => string | undefined;
  /** Resolve a model-requested expert id through the host-trusted per-agent registry. */
  resolveSubagentExpert?: (id: string) =>
    | {
        id: string;
        displayName: string;
        instructions: string;
        scope: 'read-only' | 'device-read' | 'full';
        /** File-defined agents may use scope `full`; approval still applies. */
        fileDefined?: boolean;
        allowedTools?: readonly string[];
        deniedTools?: readonly string[];
        model?: string;
        maxTurns?: number;
        timeoutMs?: number;
      }
    | undefined;
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
  /**
   * O122/O128: never answer this tool from the loop's identical-call replay
   * cache. For read_file, execute() records the read scope the edit gate
   * checks; a replayed result skips that, so a full re-read never counted.
   */
  noReplay?: boolean;
  /**
   * Host opt-in for bounded fresh observations of changing resources. Only
   * applies to readonly tools with noReplay; it does not bypass approval,
   * failure limits or per-run observation budgets.
   */
  freshObservation?: boolean;
  planMode?: ToolPlanMode;

  requiresApproval?: boolean;
  ui?: {
    surface?: 'timeline' | 'block' | 'silent';
  };

  timeoutMs?: number;

  transientRetry?: boolean;

  /**
   * Keep this tool's results in full when older results are folded.
   * Errors, unfinished checklists, user answers, and subagent conclusions
   * are not recoverable from a head/tail stub.
   */
  retainResult?: boolean;

  /**
   * The tool needs a user-question asker. Hidden when the run has none
   * (headless `-p`). Kept when the agent, a process asker on a TTY, or
   * `hooks.enrichToolContext` supplies one. The name is not the signal.
   */
  requiresUserQuestion?: boolean;

  /**
   * Output budget in estimated tokens before the middle is elided. Declared
   * here instead of in a name-keyed table (`tool-output-truncate.ts`), so a
   * tool cannot silently fall back to the generic default when a name changes
   * or a table entry is missed. Installed by `builtinTools` at module init;
   * unset means the generic default.
   */
  maxResultTokens?: number;

  /**
   * How to recover the elided middle of an oversized result ("page it with
   * offset/limit", "narrow the command"). Shown inside the elision notice so
   * the model does not re-read the whole thing (Task OS M12 finding #2).
   */
  truncationHint?: string;

  /**
   * Tool classification for loop-guard/thrash policy. Declared on the tool so a
   * new tool cannot silently inherit the generic bucket; see `tool-classes.ts`.
   */
  classification?: {
    singleCallExempt?: boolean;
    discovery?: boolean;
    surgicalEdit?: boolean;
    verifyShell?: boolean;
    fileMutation?: boolean;
    shellCommand?: boolean;
  };

  /**
   * Short description used instead of `description` when lean tool surface mode
   * is on (`MOSS_LEAN_TOOLS=1`): small-context models pay for every declaration
   * on every turn, so the long-form guidance stays for the default surface while
   * the model still sees what the tool is for, when NOT to use it, and the one
   * safety rule that matters.
   */
  leanDescription?: string;

  /**
   * Registered (SDK hosts and old transcripts still resolve the name) but not
   * offered to the model. Used when one newer tool subsumes several old ones and
   * the old names must keep working.
   */
  hiddenFromModel?: boolean;
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

export interface ToolResult {
  toolUseId: string;
  content: string;
  isError?: boolean;

  outcome?: ToolResultOutcome;

  durationMs?: number;

  aborted?: { by: 'user' | 'timeout' };
  structuredContent?: ToolContentBlock[];

  /** Structured failure metadata retained for host policy, retry, and diagnostics. */
  error?: {
    code: string;
    message: string;
    hint?: string;
    recoverable?: boolean;
    cause?: unknown;
    context?: Record<string, unknown>;
  };
}

export interface StructuredToolResult {
  content: ToolContentBlock[];
  isError?: boolean;
}
