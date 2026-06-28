











import fs from 'node:fs';
import path from 'node:path';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';

export interface ApprovalDetailContext {
  workspaceDir?: string;
  device?: { host: string; user?: string; port?: number } | null;
}

const MAX_DETAIL_LINES = 18;
const MAX_DIFF_INPUT_LINES = 400;
const MAX_LINE_CHARS = 200;

function cleanLine(line: string): string {
  const stripped = Array.from(sanitizeSecrets(line))
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 9 || (code >= 32 && code !== 127);
    })
    .join('');
  return stripped.length > MAX_LINE_CHARS ? `${stripped.slice(0, MAX_LINE_CHARS - 1)}…` : stripped;
}

/**
 * Truncate lines to fit inline detail display (MAX_DETAIL_LINES).
 * Truncated content is replaced with an ellipsis line showing how many lines are hidden.
 */
function capLines(lines: string[], max = MAX_DETAIL_LINES): string[] {
  if (lines.length <= max) return lines;
  const hidden = lines.length - (max - 1);
  return [
    ...lines.slice(0, max - 1),
    `  … (+${hidden} more line${hidden === 1 ? '' : 's'} not shown for inline approval)`,
  ];
}


/**
 * Compute a unified-diff-style output for files being edited/written.
 * Uses longest-common-subsequence (LCS) for compact diff generation.
 *
 * Returns null if:
 * - oldText or newText exceeds MAX_DIFF_INPUT_LINES (400 lines)
 *   → Indicates file is too large for inline diff; caller will show summary instead
 *
 * Each diff line is prefixed with:
 * - '- ' for deleted lines
 * - '+ ' for added lines
 * - '  … (N unchanged lines)' for runs of unchanged context
 *
 * @param oldText Previous file content
 * @param newText New file content
 * @returns Diff lines formatted for approval display, or null if inputs too large
 */
export function diffLinesForApproval(oldText: string, newText: string): string[] | null {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  if (a.length > MAX_DIFF_INPUT_LINES || b.length > MAX_DIFF_INPUT_LINES) return null;
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  let contextRun = 0;
  const pushContextEllipsis = () => {
    if (contextRun > 0) {
      out.push(`  … (${contextRun} unchanged line${contextRun === 1 ? '' : 's'})`);
      contextRun = 0;
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      contextRun += 1;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushContextEllipsis();
      out.push(`- ${a[i]}`);
      i += 1;
    } else {
      pushContextEllipsis();
      out.push(`+ ${b[j]}`);
      j += 1;
    }
  }
  pushContextEllipsis();
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out;
}

function editFileDetail(input: Record<string, unknown>): string[] | null {
  const oldString = typeof input.old_string === 'string' ? input.old_string : undefined;
  const newString = typeof input.new_string === 'string' ? input.new_string : undefined;
  if (oldString === undefined || newString === undefined) return null;
  const diff = diffLinesForApproval(oldString, newString);
  if (!diff) return null;
  if (diff.every((line) => line.startsWith('  …'))) return null;
  return diff;
}

/**
 * Generate approval detail lines for write_file tool.
 * Shows a diff if file exists and is not too large; otherwise shows summary.
 *
 * If existing file is too large (>400 lines), returns a summary instead of diff:
 *   "overwrite: path (N → M lines; diff not available for large files)"
 */
function writeFileDetail(
  input: Record<string, unknown>,
  ctx: ApprovalDetailContext
): string[] | null {
  const filePath = typeof input.path === 'string' ? input.path : undefined;
  const content = typeof input.content === 'string' ? input.content : undefined;
  if (!filePath || content === undefined) return null;

  let existing: string | null = null;
  if (ctx.workspaceDir) {
    try {
      const resolved = path.resolve(ctx.workspaceDir, filePath);
      // Validate path is within workspace
      if (
        resolved.startsWith(path.resolve(ctx.workspaceDir) + path.sep) ||
        resolved === path.resolve(ctx.workspaceDir)
      ) {
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
          existing = fs.readFileSync(resolved, 'utf8');
        }
      }
    } catch {
      existing = null;
    }
  }

  const newLines = content.split('\n');

  // File doesn't exist yet
  if (existing === null) {
    return [
      `new file: ${filePath} (${newLines.length} line${newLines.length === 1 ? '' : 's'})`,
      ...newLines.map((line) => `+ ${line}`),
    ];
  }

  // File exists; try to generate diff
  const existingLines = existing.split('\n');
  const diff = diffLinesForApproval(existing, content);

  if (!diff) {
    // File too large for diff; show summary
    return [
      `overwrite: ${filePath} (${existingLines.length} → ${newLines.length} lines; diff not available for large files)`,
    ];
  }

  // Show diff if there are changes; otherwise indicate no change
  if (diff.every((line) => line.startsWith('  …'))) {
    return [`no content change: ${filePath}`];
  }

  return [`overwrite: ${filePath}`, ...diff];
}

function applyPatchDetail(input: Record<string, unknown>): string[] | null {
  const patch = typeof input.patch === 'string' ? input.patch : undefined;
  if (!patch) return null;
  const body = patch.split('\n').filter((line) => !/^\*\*\* (Begin|End) Patch/.test(line));
  return body.length ? body : null;
}

/**
 * Generate approval detail lines for device-related tools (e.g., ssh_command).
 * Shows target device and command in a compact format.
 */
function deviceDetail(input: Record<string, unknown>, ctx: ApprovalDetailContext): string[] {
  const target = ctx.device
    ? `${ctx.device.user || 'root'}@${ctx.device.host}:${ctx.device.port || 22}`
    : 'connected device';

  const parts: string[] = [target];

  const command = typeof input.command === 'string' ? input.command : undefined;
  if (command) {
    // Truncate very long commands to fit inline
    const displayCmd = command.length > 100 ? `${command.slice(0, 97)}…` : command;
    parts.push(`| command: ${displayCmd}`);
  }

  const timeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : undefined;
  if (timeout) {
    parts.push(`| timeout: ${Math.round(timeout / 1000)}s`);
  }

  return [parts.join(' ')];
}





/**
 * Build formatted detail lines for tool approval display.
 *
 * Generates visual summary of what a tool will do based on side effect class and tool name.
 * Calls specialized detail generators (deviceDetail, diffLinesForApproval, etc.) which return:
 * - Null: no details available for this tool
 * - Empty array: tool matches but has no relevant inputs
 * - Lines: formatted strings ready for display
 *
 * All lines are:
 * - Sanitized (secrets removed)
 * - Truncated at MAX_LINE_CHARS characters with ellipsis
 * - Capped at MAX_DETAIL_LINES total (excess lines replaced with "… +N more lines" marker)
 *
 * @param toolName Tool identifier (e.g., 'edit_file', 'apply_patch', 'ssh_command')
 * @param sideEffect Side effect class (readonly, local_write, device_mutation, etc.)
 * @param input Tool input parameters
 * @param ctx Approval detail context (workspace path, connected device)
 * @returns Formatted lines ready for display in approval prompt
 */
export function buildApprovalDetailLines(
  toolName: string,
  sideEffect: string,
  input: Record<string, unknown>,
  ctx: ApprovalDetailContext = {}
): string[] {
  let lines: string[] | null = null;

  // Dispatch to tool-specific detail generator
  if (sideEffect === 'device_mutation') {
    lines = deviceDetail(input, ctx);
  } else if (toolName === 'edit_file') {
    lines = editFileDetail(input);
  } else if (toolName === 'write_file') {
    lines = writeFileDetail(input, ctx);
  } else if (toolName === 'apply_patch') {
    lines = applyPatchDetail(input);
  }

  if (!lines || lines.length === 0) return [];

  // Sanitize, truncate, and cap all detail lines
  return capLines(lines.map(cleanLine));
}
