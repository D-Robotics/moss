import * as path from 'node:path';
import * as readline from 'node:readline';
import micromatch from 'micromatch';
import type { AgentHooks, ToolApprovalRequest } from '../core/agent/agent-hooks.js';
import type { Tool, ToolSideEffectClass } from '../core/tools/tool-types.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { assertSandboxPath } from '../safety/sandbox-paths.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import { normalizeSafetyModeConfig, type ConfigApprovalPolicy } from './config.js';
import { buildApprovalDetailLines, type ApprovalDetailContext } from './approval-detail.js';
import type { CliDetailMode } from './output.js';

export type CliSafetyMode = 'read-only' | 'workspace-write' | 'full-access';

type AskUser = (question: string) => Promise<string>;

let interactiveAsker: AskUser | null = null;


export type CliInteractionMode = 'plan' | 'default' | 'acceptEdits';

let currentInteractionMode: CliInteractionMode = 'default';

export function setCliInteractionMode(mode: CliInteractionMode): void {
  currentInteractionMode = mode;
}

export function getCliInteractionMode(): CliInteractionMode {
  return currentInteractionMode;
}

export interface CliToolApprovalOptions {
  approvalPolicy?: ConfigApprovalPolicy;
  trustedTools?: readonly string[];
  deniedTools?: readonly string[];
  workspaceDir?: string;
  
  device?: { host: string; user?: string; port?: number } | null;
  







  boardMode?: () => boolean;
  





  safetyModeOverride?: () => CliSafetyMode | undefined;
  






  autoApprove?: () => boolean;
  /** Instance-scoped interaction mode for embedded or concurrent agents. */
  interactionMode?: () => CliInteractionMode;
  
  detailMode?: CliDetailMode;
}

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
  return 'workspace-write';
}

function inferSideEffectClass(tool: Tool): ToolSideEffectClass {
  const explicit = tool.metadata?.sideEffectClass;
  if (explicit) return explicit;
  if (/(^|_)(read|list|search|get|status|diagnose|inspect|describe)(_|$)/i.test(tool.name)) {
    return 'readonly';
  }
  if (
    /(^|_)(write|delete|remove|patch|exec|run|install|start|stop|restart|send|post|create|update|set)(_|$)/i.test(
      tool.name
    )
  ) {
    return 'local_write';
  }
  return 'readonly';
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
    return [input.source, input.destination].filter((value): value is string => typeof value === 'string');
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
  workspaceDir: string | undefined,
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

function isWorkspaceTrustEligible(preview: Pick<CliToolApprovalPreview, 'workspaceFileMutation'>): boolean {
  return preview.workspaceFileMutation;
}








function isSessionTrustEligible(sideEffect: ToolSideEffectClass): boolean {
  return sideEffect === 'memory_write' || sideEffect === 'runtime_state' || sideEffect === 'subagent';
}

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


  if (!isSessionTrustEligible(preview.sideEffect)) return undefined;
  return 'allow this scope for the session';
}

export function renderCliApprovalPrompt(
  preview: CliToolApprovalPreview,
  input: Record<string, unknown>,
  detailCtx: ApprovalDetailContext = {}
): string {
  const target = approvalTargetSummary(preview.toolName, input);
  const detail = buildApprovalDetailLines(preview.toolName, preview.sideEffect, input, detailCtx);
  const always = approvalAlwaysSummary(preview);

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

  lines.push('');
  lines.push(`Scope: ${approvalScopeSummary(preview, input)}`);
  lines.push(
    always
      ? 'Allow once, [a]lways, or [N]o? '
      : 'Allow once or deny (device mutations always re-prompt). [y/N] '
  );

  return lines.join('\n');
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
  const command = request.tool.name === 'exec' && typeof request.input.command === 'string'
    ? request.input.command
    : undefined;
  const dangerousCommand = command ? isCommandDangerous(command) : undefined;
  const hardBlockReason = dangerousCommand?.blocked
    ? `Blocked dangerous command: ${sanitizeSecrets(dangerousCommand.reason || 'command violates the destructive-command safety policy')}`
    : undefined;
  const physicalConfirmationRequired = sideEffect === 'device_mutation';
  const autoApproved =
    !hardBlockReason &&
    !physicalConfirmationRequired &&
    !denied &&
    allowedBySafety &&
    requiresApproval &&
    autoApprovalConfigured;



  const boardAutoApproved =
    !hardBlockReason &&
    !physicalConfirmationRequired &&
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

async function defaultAskUser(question: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const finish = (answer: string) => {
      rl.close();
      resolve(answer);
    };
    rl.once('SIGINT', () => finish(''));
    rl.question(question, finish);
  });
}

export function createCliToolApprovalHook(
  mode: CliSafetyMode,
  env: NodeJS.ProcessEnv = process.env,
  options: CliToolApprovalOptions = {}
): NonNullable<AgentHooks['onBeforeToolExec']> {
  const sessionTrustedTools = new Set<string>();
  const sessionTrustedWorkspaces = new Set<string>();
  const workspaceRoot = workspaceTrustRoot(options.workspaceDir);

  let headlessNoticeShown = false;

  return async (request: ToolApprovalRequest) => {
    const { tool } = request;


    const liveMode = options.safetyModeOverride?.() ?? mode;



    const fullPower =
      options.autoApprove?.() === true ||
      liveMode === 'full-access' ||
      hasAutoApproval(env, options);
    const preview = describeCliToolApproval(request, liveMode, env, {
      ...options,
      trustedTools: [...(options.trustedTools ?? []), ...sessionTrustedTools],
    });
    const trustedWorkspace =
      isWorkspaceTrustEligible(preview) && sessionTrustedWorkspaces.has(workspaceRoot);
    const workspaceBlockReason = await workspaceMutationBlockReason(
      preview,
      request.input,
      options.workspaceDir,
    );
    if (workspaceBlockReason) {
      return { approved: false, reason: workspaceBlockReason };
    }
    if (preview.hardBlockReason) {
      return { approved: false, reason: preview.hardBlockReason };
    }
    if (preview.denied) {
      return {
        approved: false,
        reason: `Tool "${tool.name}" is blocked by configured deniedTools.`,
      };
    }
    const interaction = options.interactionMode?.() ?? getCliInteractionMode();
    if (interaction === 'plan' && preview.sideEffect !== 'readonly') {
      return {
        approved: false,
        reason:
          'Plan mode: code exploration and planning only. ' +
          'Switch to "default" or "accept-edits" mode (use Shift+Tab) to execute changes. ' +
          `Then run "${tool.name}" again.`,
      };
    }
    if (!isAllowedInMode(liveMode, preview.sideEffect, options.boardMode?.() === true)) {
      return {
        approved: false,
        reason:
          `Tool "${tool.name}" is blocked by ${liveMode} safety mode (side effect: ${preview.sideEffect}). ` +
          'Relaunch with --full-access or use /permissions to allow it for this session.',
      };
    }
    if (!preview.requiresApproval) return { approved: true };

    if (preview.trusted && preview.sideEffect !== 'device_mutation') {
      return { approved: true };
    }

    if (trustedWorkspace) {
      return { approved: true };
    }

    if (preview.boardAutoApproved) {
      return { approved: true };
    }

    if (preview.autoApproved) {
      return { approved: true };
    }





    if (fullPower && preview.sideEffect !== 'device_mutation') {
      return { approved: true };
    }

    if (interaction === 'acceptEdits' && preview.acceptEditsEligible) {
      return { approved: true };
    }





    if (!process.stdin.isTTY && interactiveAsker === null) {
      if (options.detailMode !== 'quiet' && !headlessNoticeShown) {
        console.error(`[moss] Approval required but no interactive terminal is available: ${tool.name}`);
        headlessNoticeShown = true;
      }
      return {
        approved: false,
        reason:
          `Tool "${tool.name}" requires approval, but Moss is running non-interactively. ` +
          'Use an explicit autonomous/auto-approve policy only when unattended mutations are intended.',
      };
    }

    const prompt = renderCliApprovalPrompt(preview, request.input, {
      workspaceDir: options.workspaceDir,
      device: options.device,
    });
    const answer = (await (interactiveAsker ?? defaultAskUser)(prompt)).trim().toLowerCase();
    if (answer === 'a' || answer === 'always') {
      if (isWorkspaceTrustEligible(preview)) {
        sessionTrustedWorkspaces.add(workspaceRoot);
      } else if (isSessionTrustEligible(preview.sideEffect)) {
        sessionTrustedTools.add(tool.name);
      }


      return { approved: true };
    }
    if (answer === 'y' || answer === 'yes') {
      return { approved: true };
    }
    return { approved: false, reason: `User denied ${tool.name}.` };
  };
}
