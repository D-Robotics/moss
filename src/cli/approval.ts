import * as path from 'node:path';
import * as readline from 'node:readline';
import micromatch from 'micromatch';
import type { AgentHooks, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import type { Tool, ToolSideEffectClass } from '../core/tools/tool-types.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import {
  normalizeSafetyModeConfig,
  loadConfigFile,
  saveConfigFile,
  type ConfigApprovalPolicy,
} from './config.js';
import { deriveEngineQuantas, type CliInteractionMode } from './interaction-mode.js';
import {
  extractRuleOperand,
  parsePermissionRuleSpec,
  resolvePermissionDecision,
  type PermissionRule,
  type ResolvedPermissionRules,
} from './permission-rules.js';
import { buildApprovalDetailLines, type ApprovalDetailContext } from './approval-detail.js';
import { getCliInteractionMode } from './interaction-mode.js';
import { setUserQuestionAsker } from '../core/tools/user-question-asker.js';
import type { CliDetailMode } from './output.js';
import { runNotificationHooks } from './hooks.js';

export {
  formatCliInteractionModeLabel,
  getCliInteractionMode,
  inferCliInteractionModeFromMessages,
  parseCliInteractionMode,
  setCliInteractionMode,
  subscribeCliInteractionMode,
  type CliInteractionMode,
} from './interaction-mode.js';

export type CliSafetyMode = 'read-only' | 'workspace-write' | 'full-access';

/**
 * Structured approval payload, so a UI does not have to re-parse the flattened
 * prompt string to recover what is being approved. The reference clients title
 * these dialogs by intent ("Create file", "Edit file", "Bash command") and ask
 * one question; this carries exactly that.
 */
export interface ApprovalDialog {
  /** Short imperative title, e.g. `Create file` / `Edit file` / `Bash command`. */
  title: string;
  /** The thing being acted on (path, command, device target). */
  subject?: string;
  /** Detail/diff lines, already sanitized and capped. */
  detail: string[];
  /** One-line scope, e.g. `workspace file change`. */
  scope?: string;
  /** The question the dialog asks. */
  question: string;
  /**
   * Option-2 label override (A6.52): `a`'s trust grant is class-dependent —
   * workspace file edits, session-trust-eligible tools, or nothing at all —
   * and the frozen generic label ("don't ask again this session") lied for
   * the classes where it grants nothing.
   */
  trustOptionLabel?: string;
  /** Whether option 2 can grant a real session-scoped trust. */
  trustOptionAvailable?: boolean;
  /** Option-3 label override (A6.53 network wording). */
  denyOptionLabel?: string;
}

import {
  buildCliApprovalView,
  getCliApprovalViewAsker,
  normalizeApprovalAnswer,
} from './approval-view.js';

export type AskUser = (
  question: string,
  abortSignal?: AbortSignal,
  dialog?: ApprovalDialog
) => Promise<string>;

let interactiveAsker: AskUser | null = null;
/** Separate channel for ask_user_question so TUI can render option pickers
 *  instead of the y/a/n permission chooser (which swallows numbered answers). */
const interactiveUserQuestionAsker: AskUser | null = null;

export interface CliToolApprovalOptions {
  approvalPolicy?: ConfigApprovalPolicy;
  trustedTools?: readonly string[];
  deniedTools?: readonly string[];
  workspaceDir?: string;

  device?: { host: string; user?: string; port?: number } | null;

  boardMode?: () => boolean;

  /**
   * v0.26 (T01): safetyModeOverride/autoApprove removed — the /yolo fullPower
   * bypass is retired; the interaction mode is the single mode axis (mode=full
   * derives full-access + never via deriveEngineQuantas).
   */
  /** Instance-scoped interaction mode for embedded or concurrent agents. */
  interactionMode?: () => CliInteractionMode;

  /**
   * v0.26 (T03): live rule-table getter — user + workspace + SESSION rules
   * merged. Called per tool call so /permissions add and 'a' take effect on
   * the very next call (PRD W2 运行中生效). Absent → an empty rule table;
   * embedded hosts that only set trustedTools/deniedTools get those
   * translated into rules internally.
   */
  permissionRules?: () => ResolvedPermissionRules;

  /**
   * v0.26 (T03): startup read-only ceiling (--read-only / env / migrated
   * cautious profile). Compresses ANY mode including full.
   */
  readOnlyCeiling?: boolean;

  detailMode?: CliDetailMode;

  /**
   * Answering "a" (don't ask again) also appends the tool to the user
   * config's trustedTools so the grant survives restarts. Wired only for
   * interactive sessions — scripted/test answers never touch a config file.
   * Safety checks still apply to trusted tools.
   */
  persistTrust?: boolean;
}

/** A CLI policy hook whose interactive asker can be scoped by an embedding host. @beta */
export type CliToolApprovalHook = NonNullable<AgentHooks['onBeforeToolExec']> & {
  setAsker(asker: AskUser | null): () => void;
  setInteractionModeResolver(resolve: (() => CliInteractionMode) | null): () => void;
};

export interface CliToolApprovalPreview {
  toolName: string;
  sideEffect: ToolSideEffectClass;
  safetyMode: CliSafetyMode;
  inputPreview: string;
  decisionContext: string;
  requiresApproval: boolean;
  trusted: boolean;
  trustedPattern?: string;
  denied: boolean;
  deniedPattern?: string;
  autoApproved: boolean;

  boardAutoApproved: boolean;
  /** True only for sandbox-enforced workspace file mutation tools. */
  workspaceFileMutation: boolean;
  /** True only when accept-edits may approve this exact operation class. */
  acceptEditsEligible: boolean;
  /** Hard block reason that no trust or auto-approval mode may bypass. */
  hardBlockReason?: string;
}

export function setCliApprovalAsker(asker: AskUser | null): void {
  interactiveAsker = asker;
  syncUserQuestionAskerPort();
}

/** @internal Test hook: the currently registered interactive asker (TUI specs). */
export function getCliApprovalAskerForTest(): AskUser | null {
  return interactiveAsker;
}

/** Mirror the effective asker into the core port so tools resolve it without
 *  importing the CLI layer (dynamic fallback preserved at every mutation). */
function syncUserQuestionAskerPort(): void {
  setUserQuestionAsker(interactiveUserQuestionAsker ?? interactiveAsker ?? undefined);
}

export function resolveCliSafetyMode(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): CliSafetyMode {
  if (argv.includes('--read-only')) return 'read-only';
  if (argv.includes('--workspace-write')) return 'workspace-write';
  if (argv.includes('--full-access')) return 'full-access';
  const raw = (env.MOSS_SAFETY_MODE || env.MOSS_CLI_SAFETY_MODE || '').toLowerCase().trim();
  const envMode = normalizeSafetyModeConfig(raw);
  if (envMode) return envMode;
  // v0.26 default flip (PRD W1): the out-of-box mode is `full` — the
  // no-signal fallback here matches it so the two resolution paths agree.
  return 'full-access';
}

function inferSideEffectClass(tool: Tool): ToolSideEffectClass {
  const explicit = tool.metadata?.sideEffectClass;
  if (explicit) return explicit;
  // A name is not a safety declaration. Even apparently read-only verbs can
  // hide mutations (for example `get_and_delete` or `search_and_send`).
  return 'local_write';
}

function tokenizeReadonlyShellCommand(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const char of trimmed) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (char === '$') return undefined;

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (
      char === ';' ||
      char === '&' ||
      char === '|' ||
      char === '<' ||
      char === '>' ||
      char === '`'
    ) {
      return undefined;
    }

    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = '';
      }
      continue;
    }

    token += char;
  }

  if (escaping || quote) return undefined;
  if (token) tokens.push(token);
  return tokens.length > 0 ? tokens : undefined;
}

function hasUnsafePathArgument(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    if (!token || token === '--') return false;
    const normalized = token.replace(/\\/g, '/');
    if (/^[A-Za-z]:\//.test(normalized)) return true;
    if (normalized.startsWith('/') || normalized.startsWith('~')) return true;
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../'))
      return true;
    if (token.startsWith('-')) {
      return /=(?:\/|~|[A-Za-z]:[\\/])/.test(token) || token.includes('../');
    }
    return false;
  });
}

function isReadonlyTail(tokens: readonly string[]): boolean {
  return !tokens.some(
    (token) => token === '-f' || token === '--follow' || token.startsWith('--follow=')
  );
}

function isReadonlySed(tokens: readonly string[]): boolean {
  if (
    tokens.some(
      (token) =>
        token === '-i' ||
        token.startsWith('-i') ||
        token === '--in-place' ||
        token.startsWith('--in-place=')
    )
  )
    return false;

  return true;
}

function isReadonlyFind(tokens: readonly string[]): boolean {
  const mutatingPredicates = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir']);
  return tokens.every((token) => !mutatingPredicates.has(token));
}

function isReadonlyGit(tokens: readonly string[]): boolean {
  const subcommand = tokens[1];
  if (!subcommand) return false;
  if (subcommand === 'branch') {
    const mutatingOptions = new Set([
      '-d',
      '-D',
      '-m',
      '-M',
      '-c',
      '-C',
      '--delete',
      '--move',
      '--copy',
      '--set-upstream-to',
      '--unset-upstream',
    ]);
    return tokens.slice(2).every((token) => token.startsWith('-') && !mutatingOptions.has(token));
  }
  if (subcommand === 'remote') {
    return tokens.length === 2 || (tokens.length === 3 && tokens[2] === '-v');
  }
  return new Set([
    'status',
    'diff',
    'log',
    'show',
    'rev-parse',
    'ls-files',
    'grep',
    'blame',
    'describe',
  ]).has(subcommand);
}

function isReadonlyExecCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  if (isCommandDangerous(command).blocked) return false;
  const tokens = tokenizeReadonlyShellCommand(command);
  if (!tokens) return false;
  const commandName = tokens[0];
  if (!commandName || commandName.includes('/') || commandName.includes('\\')) return false;
  if (hasUnsafePathArgument(tokens.slice(1))) return false;

  if (commandName === 'git') return isReadonlyGit(tokens);
  if (commandName === 'tail') return isReadonlyTail(tokens);
  if (commandName === 'sed') return isReadonlySed(tokens);
  if (commandName === 'find') return isReadonlyFind(tokens);

  return new Set([
    'pwd',
    'ls',
    'tree',
    'cat',
    'head',
    'wc',
    'stat',
    'file',
    'du',
    'rg',
    'grep',
  ]).has(commandName);
}

function inferRequestSideEffectClass(request: ToolApprovalRequest): ToolSideEffectClass {
  const sideEffect = inferSideEffectClass(request.tool);
  if (
    request.tool.name === 'exec' &&
    sideEffect === 'local_write' &&
    isReadonlyExecCommand(request.input.command)
  ) {
    return 'readonly';
  }
  return sideEffect;
}

function isBoardScopedSideEffect(sideEffect: ToolSideEffectClass): boolean {
  return sideEffect === 'device_mutation' || sideEffect === 'local_write';
}

/**
 * Plan mode always permits reads, always denies device mutation, and requires
 * metadata.planMode === 'allow' for other planning helpers. This class-level
 * deny keeps accidental device_mutation + allow metadata fail-closed.
 */
export function isAllowedDuringPlanMode(tool: Tool, sideEffect: ToolSideEffectClass): boolean {
  if (sideEffect === 'device_mutation') return false;
  if (sideEffect === 'readonly') return true;
  return tool.metadata?.planMode === 'allow';
}

function isAllowedInMode(
  mode: CliSafetyMode,
  sideEffect: ToolSideEffectClass,
  boardMode = false
): boolean {
  if (sideEffect === 'readonly') return true;
  if (mode === 'read-only') return false;

  if (boardMode && isBoardScopedSideEffect(sideEffect)) return true;
  if (mode === 'workspace-write') {
    return (
      sideEffect === 'local_write' ||
      sideEffect === 'memory_write' ||
      sideEffect === 'runtime_state' ||
      sideEffect === 'subagent' ||
      sideEffect === 'external_message'
    );
  }
  return true;
}

/**
 * Determine if a tool requires user approval before execution.
 *
 * Special case: the 'exec' tool is approved without confirmation if its inferred
 * side effect is 'readonly' (e.g., 'exec ls', 'exec cat file.txt'). Commands with
 * side effects (e.g., 'exec rm') will require approval if side effect is not readonly.
 * See inferRequestSideEffectClass() for side effect detection logic.
 *
 * Exception: if tool metadata explicitly sets requiresApproval, that takes precedence.
 */
function needsApproval(request: ToolApprovalRequest, sideEffect: ToolSideEffectClass): boolean {
  if (request.tool.metadata?.requiresApproval !== undefined)
    return request.tool.metadata.requiresApproval;
  // Special case: 'exec' with detected readonly side effect doesn't need approval
  if (request.tool.name === 'exec' && sideEffect === 'readonly') return false;
  // Task OS M5: runtime_state is moss's own bookkeeping (.moss/ jsonl, task
  // contracts, evidence, todos) — an implementation detail, never a
  // user-visible mutation. Gating it on approval (which headless runs cannot
  // grant) breaks the task journey at step one; dangerous classes below
  // (local_write, device_mutation, external_message) still require approval.
  if (sideEffect === 'runtime_state') return false;
  return (
    sideEffect !== 'readonly' || request.tool.metadata?.planMode === 'requires_user_confirmation'
  );
}

function workspaceTrustRoot(workspaceDir: string | undefined): string {
  return path.resolve(workspaceDir || process.cwd());
}

const WORKSPACE_FILE_MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'move_file',
]);

function isWorkspaceFileMutation(toolName: string, sideEffect: ToolSideEffectClass): boolean {
  return sideEffect === 'local_write' && WORKSPACE_FILE_MUTATION_TOOLS.has(toolName);
}

function workspaceMutationPaths(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'move_file') {
    return [input.source, input.destination].filter(
      (value): value is string => typeof value === 'string'
    );
  }
  if (toolName === 'apply_patch' && typeof input.patch === 'string') {
    return Array.from(input.patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value));
  }
  return typeof input.path === 'string' ? [input.path] : [];
}

async function workspaceMutationBlockReason(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>,
  workspaceDir: string | undefined
): Promise<string | undefined> {
  if (!preview.workspaceFileMutation) return undefined;
  const root = workspaceDir || process.cwd();
  for (const filePath of workspaceMutationPaths(preview.toolName, input)) {
    try {
      await assertSandboxPath({ filePath, cwd: root, root });
    } catch (err) {
      return `Workspace file tool blocked path outside the sandbox: ${sanitizeSecrets(String(filePath))}. ${sanitizeSecrets(err instanceof Error ? err.message : String(err))}`;
    }
  }
  return undefined;
}

function isWorkspaceTrustEligible(
  preview: Pick<CliToolApprovalPreview, 'workspaceFileMutation'>
): boolean {
  return preview.workspaceFileMutation;
}

/**
 * v0.26 (T03): the old isSessionTrustEligible special case (which excluded
 * device_exec from 'a') is retired — "don't ask again" now writes a SESSION
 * allow rule for the whole tool, device tools included (PRD W2: the rule
 * system replaces the class-level exclusion). Every tool that reaches the
 * asker can therefore be granted.
 */

function previewInput(input: Record<string, unknown>): string {
  const raw = sanitizeSecrets(JSON.stringify(input, null, 2));
  return raw.length > 1200 ? `${raw.slice(0, 1200)}\n... [truncated ${raw.length} chars]` : raw;
}

function stripPromptControlChars(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
}

function cleanPromptText(value: string): string {
  return stripPromptControlChars(sanitizeSecrets(value)).replace(/\s+/g, ' ').trim();
}

/**
 * Compact a value to fit in approval prompts.
 * Handles multiline input by preserving the first line and marking as (multiline) if needed.
 * Limit is in characters; default 220.
 */
function compactPromptValue(value: unknown, limit = 220): string | undefined {
  if (typeof value !== 'string') return undefined;

  // Check for multiline input before cleaning
  const hasMultiline = /\n/.test(value);
  const stripped = stripPromptControlChars(sanitizeSecrets(value));

  if (hasMultiline) {
    const firstLine = stripped.split('\n')[0];
    const cleaned = cleanPromptText(firstLine).trim();
    if (!cleaned) return undefined;
    const suffix = ' (multiline)';
    const availableLimit = limit - suffix.length;
    return cleaned.length > availableLimit
      ? `${cleaned.slice(0, availableLimit - 1)}…${suffix}`
      : `${cleaned}${suffix}`;
  }

  const cleaned = cleanPromptText(stripped);
  if (!cleaned) return undefined;
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

function compactInputValue(
  input: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = compactPromptValue(input[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * Extract file paths from patch if in standard format.
 * Format: *** Update|Add|Delete File: <path>
 * Fallback: if format unrecognized or too many files, show summary instead.
 */
function patchPathSummary(input: Record<string, unknown>): string | undefined {
  const patch = typeof input.patch === 'string' ? input.patch : undefined;
  if (!patch) return undefined;

  // Try standard format first
  const paths = Array.from(patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm))
    .map((match) => cleanPromptText(match[1] ?? ''))
    .filter(Boolean);

  if (paths.length > 0) {
    if (paths.length === 1) return paths[0];
    return `${paths.slice(0, 3).join(', ')}${paths.length > 3 ? `, +${paths.length - 3} more` : ''}`;
  }

  // Fallback: if no paths extracted, show patch size summary
  const lineCount = patch.split('\n').length;
  return `patch (${lineCount} lines)`;
}

function approvalTargetSummary(
  toolName: string,
  input: Record<string, unknown>
): string | undefined {
  const command = compactInputValue(input, ['command', 'cmd', 'shell_command']);
  if (command) return command;
  const source = compactInputValue(input, ['source', 'src']);
  const destination = compactInputValue(input, ['destination', 'dest', 'target']);
  if (source && destination) return `${source} -> ${destination}`;
  const patch = patchPathSummary(input);
  if (patch) return patch;
  if (toolName === 'multi_edit' && Array.isArray(input.edits)) {
    const paths: string[] = [];
    for (const item of input.edits) {
      if (!item || typeof item !== 'object') continue;
      const filePath = (item as Record<string, unknown>).path;
      if (typeof filePath === 'string' && filePath.trim()) paths.push(cleanPromptText(filePath));
    }
    if (paths.length > 0) {
      const shown = paths.slice(0, 3);
      const extra = paths.length - shown.length;
      return extra > 0 ? `${shown.join(', ')}, +${extra} more` : shown.join(', ');
    }
  }
  const directTarget = compactInputValue(input, [
    'path',
    'file_path',
    'filepath',
    'file',
    'url',
    'uri',
    'href',
    'task',
    'description',
    'query',
    'id',
  ]);
  if (directTarget) return directTarget;
  return cleanPromptText(toolName);
}

function approvalActionSummary(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>
): string {
  const toolName = preview.toolName;
  const hasCommand = compactInputValue(input, ['command', 'cmd', 'shell_command']) !== undefined;
  if (hasCommand && preview.sideEffect === 'device_mutation') return 'run a command on the device';
  if (hasCommand && /background/i.test(toolName)) return 'start a background command';
  if (hasCommand) return 'run a local command';
  if (preview.sideEffect === 'memory_write') return 'update memory';
  if (preview.sideEffect === 'runtime_state') return 'change session state';
  if (preview.sideEffect === 'subagent') return 'start a sub-agent task';
  if (preview.sideEffect === 'credential') return 'use credentials';
  if (preview.sideEffect === 'external_message') return 'send an external message';
  if (preview.sideEffect === 'device_mutation') return 'change the connected device';
  if (/apply_patch|patch/i.test(toolName)) return 'apply a patch';
  if (/write|create/i.test(toolName)) return 'write a file';
  if (/edit|replace|update/i.test(toolName)) return 'edit a file';
  if (/delete|remove/i.test(toolName)) return 'delete something';
  return `use ${cleanPromptText(toolName)}`;
}

function approvalScopeSummary(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>
): string {
  const hasCommand = compactInputValue(input, ['command', 'cmd', 'shell_command']) !== undefined;
  switch (preview.sideEffect) {
    case 'local_write':
      return hasCommand ? 'workspace command' : 'workspace file change';
    case 'device_mutation':
      return 'connected device';
    case 'memory_write':
      return 'Moss memory';
    case 'runtime_state':
      return 'current session';
    case 'subagent':
      return 'sub-agent';
    case 'credential':
      return 'credentials';
    case 'external_message':
      return 'external message';
    case 'readonly':
      return 'read-only';
  }
}

function approvalAlwaysSummary(preview: CliToolApprovalPreview): string | undefined {
  if (isWorkspaceTrustEligible(preview)) return 'trust workspace file edits for this session';
  // v0.26 (T03): 'a' writes a session allow rule for ANY tool (device_exec
  // included) — the rule system replaced the class-level eligibility gate.
  return `allow ${preview.toolName} for the session`;
}

export interface TaskApprovalContext {
  taskId: string;
  goal: string;
  phase: string;
  attempt?: number;
  targetDeviceId?: string;
}

/**
 * Task OS §11 — approval as task experience. Renders the why/impact block:
 * what operation, which task it serves, why now, what it affects, and what
 * happens if declined. Absent task context or explicit reason → no block
 * (legacy prompt unchanged).
 */
export function buildTaskApprovalBlock(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>,
  task?: TaskApprovalContext
): string[] {
  const reason =
    typeof input.reason === 'string' && input.reason.trim()
      ? input.reason.trim()
      : task
        ? task.phase === 'verifying' || task.phase === 'reverifying'
          ? 'verification cannot proceed without this step'
          : 'required by the current task plan step'
        : undefined;
  if (!task && reason === undefined) return [];

  const command =
    typeof input.command === 'string' || typeof input.cmd === 'string'
      ? String(input.command ?? input.cmd)
      : '';
  const remotePath = typeof input.remote_path === 'string' ? input.remote_path : undefined;

  let impact: string;
  if (preview.sideEffect === 'device_mutation') {
    if (/\b(restart|stop|kill|reboot|poweroff|systemctl)\b/i.test(command)) {
      impact = 'the affected device service will be interrupted (typically seconds)';
    } else if (remotePath) {
      impact = `the file at ${remotePath} on the device will be overwritten`;
    } else {
      impact = 'device state changes (command runs on the live device)';
    }
  } else if (preview.sideEffect === 'local_write') {
    impact = 'workspace files change';
  } else {
    impact = approvalScopeSummary(preview, input);
  }

  const lines = ['', 'Task context:'];
  lines.push(
    `  operation: ${approvalActionSummary(preview, input)}${command ? ` — ${command.slice(0, 120)}` : ''}`
  );
  if (task) {
    lines.push(
      `  task: ${task.goal.slice(0, 80)} (${task.phase}${task.attempt ? `, attempt ${task.attempt}` : ''})`
    );
  }
  if (task?.targetDeviceId) {
    lines.push(`  target device: ${task.targetDeviceId}`);
  }
  if (reason) lines.push(`  reason: ${reason}`);
  lines.push(`  impact: ${impact}`);
  if (task) {
    lines.push('  if declined: the task stays blocked (needs user) until approved or skipped');
  }
  return lines;
}

export function renderCliApprovalPrompt(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>,
  detailCtx: ApprovalDetailContext = {},
  task?: TaskApprovalContext
): string {
  const target = approvalTargetSummary(preview.toolName, input);
  const detail = buildApprovalDetailLines(preview.toolName, preview.sideEffect, input, detailCtx);
  const always = approvalAlwaysSummary(preview);
  const taskBlock = buildTaskApprovalBlock(preview, input, task);

  const lines = [
    '',
    `Background: ${preview.decisionContext}`,
    '',
    `Moss wants to ${approvalActionSummary(preview, input)}`,
    target ? `  ${target}` : '(no target information available)',
  ];

  if (detail.length > 0) {
    lines.push('Details:');
    lines.push(...detail);
  }

  if (taskBlock.length > 0) {
    lines.push(...taskBlock);
  }

  lines.push('');
  lines.push(`Scope: ${approvalScopeSummary(preview, input)}`);
  if (always) {
    lines.push('([a]lways trusts sandboxed workspace file edits — this Moss session only)');
    lines.push('Allow once, [a]lways, or [N]o? ');
  } else {
    lines.push('Allow once or deny (device mutations always re-prompt). [y/N] ');
  }

  return lines.join('\n');
}

/**
 * Dialog title in the reference clients' vocabulary. moss's extra surfaces
 * (device mutations) get their own honest titles rather than being folded into
 * the file/shell ones.
 */
export function approvalDialogTitle(toolName: string): string {
  switch (toolName) {
    case 'write_file':
      return 'Create file';
    case 'edit_file':
    case 'apply_patch':
    case 'multi_edit':
      return 'Edit file';
    case 'web_fetch':
      return 'Fetch';
    case 'bash':
    case 'shell':
    case 'exec':
    case 'run_command':
      return 'Bash command';
    case 'device_file_write':
      return 'Write file on device';
    case 'device_exec':
      return 'Run command on device';
    default:
      return toolName.replace(/_(file|command)$/, '').replace(/_/g, ' ') || 'Approve';
  }
}

function approvalDialogQuestion(title: string, subject: string | undefined): string {
  if (!subject) return 'Do you want to proceed?';
  if (title === 'Create file') return `Do you want to create ${subject}?`;
  if (title === 'Edit file') return `Do you want to make this edit to ${subject}?`;
  if (title === 'Bash command') return 'Do you want to proceed?';
  if (title === 'Write file on device') return `Do you want to write ${subject} on the device?`;
  if (title === 'Run command on device') return `Do you want to run this on the device?`;
  return 'Do you want to proceed?';
}

/** Build the structured dialog for a pending approval. */
export function describeApprovalDialog(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>,
  detailCtx: ApprovalDetailContext = {},
  options: { persistTrust?: boolean } = {}
): ApprovalDialog {
  const title = approvalDialogTitle(preview.toolName);
  const subject = approvalTargetSummary(preview.toolName, input) || undefined;
  // A6.52 + v0.26 (T03): say what `a` ACTUALLY grants. Workspace file edits
  // trust the sandboxed edit family; every OTHER tool now gets a session
  // allow rule (device_exec included — the class-level exclusion was replaced
  // by the rule system, PRD W2). With persistTrust, `a` also writes to the
  // config, so the label says so instead of promising a session-only grant.
  const grantScope = options.persistTrust ? ' (saved)' : ' this session';
  const trustOptionLabel = isWorkspaceTrustEligible(preview)
    ? `Yes, and don\u2019t ask again for file edits${grantScope}`
    : `Yes, and always allow ${preview.toolName}${grantScope}`;
  return {
    title,
    ...(subject ? { subject } : {}),
    detail: buildApprovalDetailLines(preview.toolName, preview.sideEffect, input, detailCtx),
    scope: approvalScopeSummary(preview, input),
    question: approvalDialogQuestion(title, subject),
    ...(trustOptionLabel ? { trustOptionLabel } : {}),
    // v0.26: 'a' always grants at least a session allow rule.
    trustOptionAvailable: true,
    ...(preview.toolName === 'web_fetch'
      ? { denyOptionLabel: 'No, and tell moss what to do differently (esc)' }
      : {}),
  };
}

function hasAutoApproval(env: NodeJS.ProcessEnv, options: CliToolApprovalOptions): boolean {
  return (
    options.approvalPolicy === 'never' ||
    env.MOSS_CLI_AUTO_APPROVE === '1' ||
    env.MOSS_AUTO_APPROVE === '1'
  );
}

function findConfiguredToolPattern(
  toolName: string,
  patterns: readonly string[]
): string | undefined {
  return patterns.find(
    (pattern) =>
      pattern === toolName ||
      micromatch.isMatch(toolName, pattern, {
        contains: false,
        dot: true,
        nocase: false,
        noextglob: true,
        nonegate: true,
      })
  );
}

export function describeCliToolApproval(
  request: ToolApprovalRequest,
  mode: CliSafetyMode,
  env: NodeJS.ProcessEnv = process.env,
  options: CliToolApprovalOptions = {}
): CliToolApprovalPreview {
  const sideEffect = inferRequestSideEffectClass(request);
  const deniedPattern = findConfiguredToolPattern(request.tool.name, options.deniedTools ?? []);
  const trustedPattern = findConfiguredToolPattern(request.tool.name, options.trustedTools ?? []);
  const denied = deniedPattern !== undefined;
  const trusted = trustedPattern !== undefined;
  const autoApprovalConfigured = hasAutoApproval(env, options);
  const boardMode = options.boardMode?.() === true;
  const allowedBySafety = isAllowedInMode(mode, sideEffect, boardMode);
  const requiresApproval = needsApproval(request, sideEffect);
  const workspaceFileMutation = isWorkspaceFileMutation(request.tool.name, sideEffect);
  const acceptEditsEligible = workspaceFileMutation;
  const command =
    request.tool.name === 'exec' && typeof request.input.command === 'string'
      ? request.input.command
      : undefined;
  const dangerousCommand = command ? isCommandDangerous(command) : undefined;
  const hardBlockReason = dangerousCommand?.blocked
    ? `Blocked dangerous command: ${sanitizeSecrets(dangerousCommand.reason || 'command violates the destructive-command safety policy')}`
    : undefined;
  const autoApproved =
    !hardBlockReason && !denied && allowedBySafety && requiresApproval && autoApprovalConfigured;

  const boardAutoApproved =
    !hardBlockReason &&
    boardMode &&
    !denied &&
    allowedBySafety &&
    requiresApproval &&
    isBoardScopedSideEffect(sideEffect);
  let decisionContext = 'readonly tool; approval is not required';

  if (denied) {
    decisionContext = `Blocked by configured deniedTools (${deniedPattern})`;
  } else if (hardBlockReason) {
    decisionContext = hardBlockReason;
  } else if (!allowedBySafety) {
    decisionContext = `Blocked by ${mode} safety mode. Relaunch with --full-access to allow this tool.`;
  } else if (requiresApproval && trusted) {
    decisionContext = `Trusted by configured trustedTools (${trustedPattern}). Auto-approving.`;
  } else if (requiresApproval && boardAutoApproved) {
    decisionContext = 'Auto-approved by board mode (/connect) after safety checks.';
  } else if (requiresApproval && autoApproved) {
    decisionContext = 'Auto-approved by approval policy after safety checks.';
  } else if (requiresApproval) {
    decisionContext = `Approval required by ${mode} safety mode. This tool has ${sideEffect} side effects.`;
  }

  return {
    toolName: request.tool.name,
    sideEffect,
    safetyMode: mode,
    inputPreview: previewInput(request.input),
    decisionContext,
    requiresApproval,
    trusted,
    trustedPattern,
    denied,
    deniedPattern,
    autoApproved,
    boardAutoApproved,
    workspaceFileMutation,
    acceptEditsEligible,
    ...(hardBlockReason ? { hardBlockReason } : {}),
  };
}

async function defaultAskUser(question: string, abortSignal?: AbortSignal): Promise<string> {
  if (!process.stdin.isTTY) return '';
  // Attention needed: fire the Notification lifecycle hook (terminal bell,
  // desktop notify, etc.) before blocking on the prompt.
  void runNotificationHooks({ reason: 'approval_required', message: question.slice(0, 200) });
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const finish = (answer: string) => {
      abortSignal?.removeEventListener('abort', onAbort);
      rl.close();
      resolve(answer);
    };
    const onAbort = () => finish('');
    if (abortSignal?.aborted) return finish('');
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    rl.once('SIGINT', () => finish(''));
    rl.question(question, finish);
  });
}

/**
 * "Don't ask again" that survives restarts (v0.26 T03): append the granted
 * tools to the user config's `permissions.allow` rule list (the trustedTools
 * write side moved to the permissions block, PRD W2). File edits persist the
 * whole edit family in one press (the session grant is workspace-wide, not
 * per tool); everything else persists the exact tool. Gated by persistTrust,
 * so scripted and test answers never touch a real config file. Allowed tools
 * still run through every safety check — an allow rule only removes the
 * prompt; deny rules and hard blocks still win.
 */
function persistAllowRule(preview: CliToolApprovalPreview, toolName: string): void {
  try {
    const granted = isWorkspaceTrustEligible(preview)
      ? [...WORKSPACE_FILE_MUTATION_TOOLS]
      : [toolName];
    const current = loadConfigFile();
    const permissions = current.permissions ?? {};
    const allow = [...new Set([...(permissions.allow ?? []), ...granted])];
    const changed = allow.length !== (permissions.allow ?? []).length;
    if (!changed) return;
    saveConfigFile({ ...current, permissions: { ...permissions, allow } });
  } catch {
    /* a failed save only costs re-asking next session */
  }
}

export function createCliToolApprovalHook(
  mode: CliSafetyMode,
  env: NodeJS.ProcessEnv = process.env,
  options: CliToolApprovalOptions = {}
): CliToolApprovalHook {
  // v0.26 (T03): session allow rules from 'a' — whole-tool grants (device_exec
  // included, PRD W2). Workspace FILE trust keeps its own set (the sandboxed
  // edit family is a workspace-wide grant, design §3.4).
  const sessionAllowRules = new Set<string>();
  const sessionTrustedWorkspaces = new Set<string>();
  const workspaceRoot = workspaceTrustRoot(options.workspaceDir);
  let instanceAsker: AskUser | null = null;
  let instanceInteractionMode: (() => CliInteractionMode) | null = null;

  let headlessNoticeShown = false;

  const hook: NonNullable<AgentHooks['onBeforeToolExec']> = async (
    request: ToolApprovalRequest
  ) => {
    const { tool } = request;

    // ── live assembly (the hook ONLY assembles; ordering lives in
    // permission-rules.resolvePermissionDecision, design §7-4) ──
    const interaction: CliInteractionMode =
      instanceInteractionMode?.() ?? options.interactionMode?.() ?? getCliInteractionMode();
    // The mode axis derives the safety mode (T01): mode=full → full-access +
    // never. The legacy `mode` constructor argument and the env auto-approve
    // keys fold in as full-equivalent overrides (§3.3: they ARE mode
    // overrides) so direct embedders keep their semantics inside the single
    // decision order. Legacy trustedTools/deniedTools options translate to
    // rules the same way.
    const effectiveMode: CliInteractionMode =
      interaction === 'full' || hasAutoApproval(env, options) || mode === 'full-access'
        ? 'full'
        : interaction;
    const quantas = deriveEngineQuantas(effectiveMode);
    const liveMode: CliSafetyMode = options.readOnlyCeiling ? 'read-only' : quantas.safetyMode;

    const configRules: readonly PermissionRule[] = options.permissionRules?.().rules ?? [];
    const legacyTrusted = (options.trustedTools ?? []).map((toolName) =>
      parsePermissionRuleSpec(toolName, 'session', 'allow')
    );
    const legacyDenied = (options.deniedTools ?? []).map((toolName) =>
      parsePermissionRuleSpec(toolName, 'session', 'deny')
    );
    const sessionRules: PermissionRule[] = [...sessionAllowRules].map((toolName) =>
      parsePermissionRuleSpec(toolName, 'session', 'allow')
    );
    // deny union first (deny rules win regardless of list order), then
    // allow/ask; trusted/allowed duplicates are harmless (first match wins
    // per level).
    const ruleTable: readonly PermissionRule[] = [
      ...configRules.filter((rule) => rule.level === 'deny'),
      ...legacyDenied,
      ...configRules.filter((rule) => rule.level !== 'deny'),
      ...legacyTrusted,
      ...sessionRules,
    ];
    const resolvedRules: ResolvedPermissionRules = {
      rules: ruleTable,
      sources: options.permissionRules?.().sources ?? {},
    };

    const sideEffect = inferRequestSideEffectClass(request);
    const requiresApproval = needsApproval(request, sideEffect);
    const workspaceFileMutation = isWorkspaceFileMutation(tool.name, sideEffect);
    const operand = extractRuleOperand(tool.name, request.input);

    const decisionInput = {
      toolName: tool.name,
      sideEffect,
      operand,
      requiresApproval,
      mode: effectiveMode,
      readOnlyCeiling: options.readOnlyCeiling === true,
      boardMode: options.boardMode?.() === true,
      acceptEditsEligible: workspaceFileMutation,
      planModeAllowed: tool.metadata?.planMode === 'allow',
    };

    const preview = describeCliToolApproval(request, liveMode, env, {
      ...options,
      trustedTools: [...(options.trustedTools ?? []), ...sessionAllowRules],
    });
    const trustedWorkspace =
      isWorkspaceTrustEligible(preview) && sessionTrustedWorkspaces.has(workspaceRoot);

    // ── hard safety checks (any mode, before any policy) ──
    const workspaceBlockReason = await workspaceMutationBlockReason(
      preview,
      request.input,
      options.workspaceDir
    );
    if (workspaceBlockReason) {
      return { approved: false, reason: workspaceBlockReason };
    }
    if (preview.hardBlockReason) {
      return { approved: false, reason: preview.hardBlockReason };
    }

    // ── the permission decision order (single implementation) ──
    const outcome = resolvePermissionDecision(decisionInput, resolvedRules);

    switch (outcome.decision) {
      case 'deny':
        return { approved: false, reason: `Tool "${tool.name}" ${outcome.reason}.` };
      case 'block':
        return {
          approved: false,
          reason: `Tool "${tool.name}" is blocked (${outcome.reason}). ${
            effectiveMode === 'plan'
              ? 'Switch to "manual", "accept-edits", or "full" mode (use Shift+Tab) to execute changes. '
              : 'The read-only ceiling only lifts with --workspace-write/--full-access. '
          }Then run "${tool.name}" again.`,
        };
      case 'allow':
        // Workspace file trust (the 'a' family grant) rides on top of the
        // ordered allow — same outcome, kept for the sandboxed edit family.
        if (outcome.reason === 'no-approval-needed') return { approved: true };
        return { approved: true };
      case 'ask-rule':
      case 'ask':
        break;
    }

    if (trustedWorkspace) {
      return { approved: true };
    }

    // read-only tools with planMode: 'allow' (planning helpers) run without a
    // second confirmation (plan ceiling already let them through above).
    if (effectiveMode === 'plan' && tool.metadata?.planMode === 'allow') {
      return { approved: true };
    }

    const asker = instanceAsker ?? interactiveAsker;
    if (!process.stdin.isTTY && asker === null) {
      if (options.detailMode !== 'quiet' && !headlessNoticeShown) {
        console.error(
          `[moss] Approval required but no interactive terminal is available: ${tool.name}`
        );
        headlessNoticeShown = true;
      }
      return {
        approved: false,
        reason:
          `Tool "${tool.name}" requires approval, but Moss is running non-interactively. ` +
          'To let it run: switch the mode to full — `/mode full` in an interactive session, ' +
          '`--full-access` (this process only), or `moss config set permissions.defaultMode=full` ' +
          '(persistent); add narrow allow rules with /permissions for single tools. ' +
          'This gate is inherited by sub-agents: delegating the same call via ' +
          'create_subagent or fan_out_subagents will be denied too, so do not retry it that way.',
      };
    }

    // Task OS §11: attach the live task context so approvals read as task
    // decisions (what/why/impact), not raw tool prompts.
    let taskCtx: TaskApprovalContext | undefined;
    try {
      const { findLatestLiveTaskSnapshot } = await import('../core/task/task-store.js');
      const snapshot = await findLatestLiveTaskSnapshot(options.workspaceDir ?? workspaceRoot);
      if (snapshot) {
        taskCtx = {
          taskId: snapshot.taskId,
          goal: snapshot.goal,
          phase: snapshot.phase,
          attempt: snapshot.attempt,
          ...(snapshot.targetDeviceId || options.device?.host
            ? { targetDeviceId: snapshot.targetDeviceId ?? options.device?.host }
            : {}),
        };
      }
    } catch {
      /* task context is enrichment — approvals work without it */
    }

    const prompt = renderCliApprovalPrompt(
      preview,
      request.input,
      {
        workspaceDir: options.workspaceDir,
        device: options.device,
      },
      taskCtx
    );
    const dialog = describeApprovalDialog(
      preview,
      request.input,
      { workspaceDir: options.workspaceDir, device: options.device },
      { persistTrust: options.persistTrust }
    );
    // Precedence: a structured UI (which renders the dialog itself) wins over
    // the flattened-prompt asker; headless/tests keep using the string path.
    const viewAsker = getCliApprovalViewAsker();
    const answer = viewAsker
      ? normalizeApprovalAnswer(await viewAsker(buildCliApprovalView(dialog), request.abortSignal))
      : (await (asker ?? defaultAskUser)(prompt, request.abortSignal, dialog)).trim().toLowerCase();

    // "Yes, but let me add something first": run the tool, and the UI stages the
    // composer for the user's follow-up. Not a session-wide trust grant.
    if (answer === 'amend') {
      return { approved: true };
    }
    if (answer === 'a' || answer === 'always') {
      if (isWorkspaceTrustEligible(preview)) {
        sessionTrustedWorkspaces.add(workspaceRoot);
      } else {
        // v0.26 (T03): 'a' writes a session allow rule for the whole tool —
        // device_exec included (the old class-level exclusion is replaced by
        // the rule system, PRD W2). The next tool call resolves it through
        // the live rule table without prompting.
        sessionAllowRules.add(tool.name);
      }
      if (options.persistTrust) persistAllowRule(preview, tool.name);

      return { approved: true };
    }
    if (answer === 'y' || answer === 'yes') {
      return { approved: true };
    }
    return { approved: false, reason: `User denied ${tool.name}.` };
  };
  const configurable = hook as CliToolApprovalHook;
  configurable.setAsker = (asker: AskUser | null) => {
    instanceAsker = asker;
    return () => {
      if (instanceAsker === asker) instanceAsker = null;
    };
  };
  configurable.setInteractionModeResolver = (resolve: (() => CliInteractionMode) | null) => {
    instanceInteractionMode = resolve;
    return () => {
      if (instanceInteractionMode === resolve) instanceInteractionMode = null;
    };
  };
  return configurable;
}
