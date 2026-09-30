import type { SpawnToolScope } from './spawn-profile.js';
import type { SubagentRunProgress } from '../tools/tool-types.js';

export interface SubAgentConfig {
  runId: string;

  parentRunId: string;

  scope: SpawnToolScope;

  task: string;

  /** Parent-relative paths that an implementation worker may modify. */
  writePaths?: readonly string[];

  /**
   * Run this writable sub-agent in an isolated git worktree detached at the
   * parent's HEAD; changes come back as a lease patch the parent merges with
   * `git apply --3way` (worktree-isolation.ts). Concurrent writers cannot
   * stomp each other or the parent workspace.
   */
  worktree?: boolean;

  /** Optional exact host allowlist, always intersected with the selected scope. */
  allowedTools?: readonly string[];

  /** Optional model override for this sub-agent (e.g. a cheaper model for
   *  exploration, a stronger model for a critical decision). The runner clones
   *  the parent's modelDef with this id; the provider routes by model id, so
   *  the sub-agent actually runs on the overridden model. Context-window
   *  re-detection for the override is a follow-up (parent's contextTokens is
   *  used as a fallback). */
  model?: string;

  /** Optional per-call system-prompt override. When set, the child agent runs
   *  with this as its system prompt instead of the parent's, used by the
   *  plan-critic to inject its critique prompt without touching parent state.
   *  When set, childSystemPromptParts is undefined (the override is a single
   *  block, not split into stable/dynamic for prefix-cache). */
  systemPromptOverride?: string;

  /** Host-trusted expert instructions appended without replacing base safety policy. */
  expertPrompt?: string;

  /** Optional context-tokens override paired with `model` (the host resolves
   *  the overridden model's context window and injects it here). Falls back to
   *  the parent's contextTokens when unset. */
  contextTokens?: number;

  maxTurns?: number;

  timeoutMs?: number;

  previousStepResult?: {
    runId: string;
    summary: string;
    success: boolean;
  };

  onProgress?: (progress: SubagentRunProgress) => void;
}

export interface SubAgentResult {
  runId: string;
  summary: string;
  toolResults: number;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  workspaceLeaseId?: string;
  patchId?: string;
  patchRef?: string;
  patchDigest?: string;
  changedPaths?: readonly string[];
}

export type SubAgentRunner = (
  config: SubAgentConfig,
  signal: AbortSignal
) => Promise<SubAgentResult>;
