import path from 'node:path';
import { runProcess, ProcessError } from '../utils/run-process.js';
import type { Tool } from '../core/tools/tool-types.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { assertShellWritesWithinRoots } from '../safety/shell-write-sandbox.js';
import {
  createSubagentTool,
  fanOutSubagentsTool,
  subagentStatusTool,
  subagentStopTool,
} from './create-subagent.js';
import { mergeSubagentPatchTool } from './merge-subagent-patch.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';
import { backgroundExecTools } from './background-exec.js';
import { codeDiagnosticsTool } from './code-diagnostics.js';
import { harnessTools } from './harness-tools.js';
import { deviceTools } from './device-tools.js';
import { evidenceTools } from './evidence-tools.js';
import { taskTools } from './task-tools.js';
import {
  IS_WIN,
  EXEC_DEFAULT_TIMEOUT_MS,
  globalToolStateManager,
  looksBinary,
  openChildEnv,
  takeShellNotices,
} from './tool-helpers.js';

export { looksBinary };

import {
  extractShellMutationPaths,
  shellCommandHasWriteAction,
} from '../context/stale-read-invalidate.js';
import { deviceEnvFootnote } from '../utils/safe-child-env.js';
import { createRedactingChunkWriter } from '../safety/tool-output-redact.js';
import {
  filesWithIncreasedPlaceholderCount,
  formatRedactedWritebackWarning,
  redactedShellWriteRefusal,
  snapshotMutationFiles,
} from '../safety/redacted-writeback.js';

// Re-export tools from extracted modules for backward compatibility.
export {
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  moveFileTool,
  listDirectoryTool,
} from './file-tools.js';
export { searchFilesTool, searchCodeTool } from './search-tools.js';
export { applyPatchTool } from './patch-tool.js';
export { todoWriteTool } from './todo-tool.js';
export { ToolStateManager } from './tool-helpers.js';
export {
  harnessTools,
  runTestsTool,
  verifyFixTool,
  summarizeVerificationResult,
  extractVerificationFailurePreview,
} from './harness-tools.js';
export { askUserQuestionTool } from './ask-user-question.js';

const WIN_POSIX_HINT =
  'On Windows the local shell is cmd/PowerShell: Unix-only utilities (e.g. uname, grep without Git) are unavailable. ' +
  'Use PowerShell equivalents or read workspace files.';

export const execTool: Tool = {
  name: 'exec',
  description:
    'Run a shell command in the workspace (cwd does not persist). Prefer read_file, edit_file, multi_edit, search_files, search_code, run_tests, and verify_fix over cat/sed/find/grep. ' +
    'Use absolute paths; do not cd. Chain with && only when the next step must not run if this one fails. ' +
    'For servers, watchers, or anything that may not exit, set run_in_background or use exec_background, then exec_logs / exec_stop. ' +
    'Reads outside the workspace are allowed. Secret-like output, including Moss config and keys, is removed. Every MOSS_DEVICE_* value is hidden; a footnote lists names that are set — do not claim a hidden variable is unset.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
    permissionBoundary:
      'Host must enforce approval via AgentHooks.onBeforeToolExec. Do not allow unattended exec without explicit user consent.',
  },
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout_ms: {
        type: 'number',
        description:
          'Timeout in ms (default 120000). Use run_in_background for processes that do not exit.',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'Start in the background and return a handle. During /goal the command waits until exit or timeout_ms unless wait is false or settle_ms is set. Do not append "&".',
      },
      settle_ms: {
        type: 'number',
        description:
          'With run_in_background, watch this many ms for an immediate crash (default 1200, max 10000).',
      },
      wait: {
        type: 'boolean',
        description: 'With run_in_background, false returns after settle_ms even during /goal.',
      },
      label: {
        type: 'string',
        description: 'Optional label shown in exec_logs.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
    // Claude Code Bash parity: run_in_background on the main exec tool so the
    // model does not have to discover a separate exec_background tool.
    if (input.run_in_background === true) {
      const { execBackgroundTool } = await import('./background-exec.js');
      return execBackgroundTool.execute(
        {
          command: input.command,
          ...(typeof input.label === 'string' ? { label: input.label } : {}),
          ...(input.timeout_ms !== undefined ? { timeout_ms: input.timeout_ms } : {}),
          ...(input.settle_ms !== undefined ? { settle_ms: input.settle_ms } : {}),
          ...(input.wait !== undefined ? { wait: input.wait } : {}),
        },
        ctx
      );
    }
    const timeoutMs = Number(input.timeout_ms) || EXEC_DEFAULT_TIMEOUT_MS;
    if (IS_WIN && /\buname\b/i.test(input.command)) {
      return `Command skipped: uname is not available on Windows cmd.\n${WIN_POSIX_HINT}`;
    }
    const safetyCheck = isCommandDangerous(input.command);
    if (safetyCheck.blocked) {
      return `Command blocked: ${safetyCheck.reason}`;
    }
    if (ctx.execWriteRoots && ctx.execWriteRoots.length > 0) {
      try {
        await assertShellWritesWithinRoots(input.command, {
          cwd: ctx.workspaceDir,
          roots: ctx.execWriteRoots,
        });
      } catch (err) {
        return (
          `Command blocked: shell write escapes the workspace sandbox (${err instanceof Error ? err.message : String(err)}). ` +
          'Write to a path inside the workspace instead, or use write_file/edit_file (they enforce the same boundary).'
        );
      }
    }
    const commandText = String(input.command ?? '');
    const redactedWrite = redactedShellWriteRefusal(
      commandText,
      shellCommandHasWriteAction(commandText)
    );
    if (redactedWrite) return redactedWrite;
    const mutationSnap = snapshotMutationFiles(
      ctx.workspaceDir,
      extractShellMutationPaths(commandText)
    );
    const hideCredentialStream = /\.apikey-key\b/.test(commandText);
    const streamer = hideCredentialStream ? null : createRedactingChunkWriter(ctx.onToolOutput);
    const footnote = deviceEnvFootnote(String(input.command ?? ''));
    const opened = await openChildEnv(ctx.workspaceDir, ctx.abortSignal);
    const hooksNotice = (output = ''): string =>
      takeShellNotices(ctx.sessionKey, opened, commandText, output);
    try {
      const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
      const result = await runProcess(shell, {
        args: IS_WIN ? ['/c', input.command] : ['-c', input.command],
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.abortSignal,
        env: opened.env,
        cwd: ctx.workspaceDir,
        // Live streaming: forward stdout chunks to the host (TUI/headless
        // renderer) so long-running commands show output incrementally.
        // Line-buffered so a secret on its own line is redacted before display.
        ...(ctx.onToolOutput
          ? {
              onStdoutChunk: (chunk: string) => {
                streamer?.write(chunk);
              },
            }
          : {}),
      });
      const STDERR_MAX = 4096;
      const STDOUT_MAX = 80_000;
      const stderrRaw = result.stderr.trim();
      const stderrFmt = stderrRaw
        ? stderrRaw.length > STDERR_MAX
          ? `--- stderr (truncated ${stderrRaw.length}→${STDERR_MAX} chars) ---\n${stderrRaw.slice(0, STDERR_MAX)}`
          : `--- stderr ---\n${stderrRaw}`
        : '';
      // Detect binary output (e.g. `cat /bin/ls`) — runProcess captures as
      // UTF-8, so binary produces U+FFFD replacement chars + control chars.
      // Returning MB of garbage floods the model's context. If the output
      // looks binary, return a safe summary instead.
      const stdoutTrimmed = result.stdout.trim();
      let outText = looksBinary(stdoutTrimmed)
        ? `(binary output, ${stdoutTrimmed.length} chars — suppressed to avoid flooding context; use hexdump or xxd if you need to inspect it)`
        : stdoutTrimmed;
      if (!looksBinary(stdoutTrimmed) && outText.length > STDOUT_MAX) {
        const head = outText.slice(0, Math.floor(STDOUT_MAX * 0.7));
        const tail = outText.slice(-Math.floor(STDOUT_MAX * 0.25));
        outText =
          `${head}\n\n... [${outText.length - STDOUT_MAX} chars omitted] ...\n\n${tail}\n` +
          `(stdout truncated to ~${STDOUT_MAX} chars; re-run with a narrower command or pipe through tail/head/rg)`;
      }
      const exitNote =
        result.exitCode !== undefined && result.exitCode !== 0
          ? `exit_code: ${result.exitCode}\n`
          : '';
      const outParts = [exitNote + outText, stderrFmt].filter(Boolean);
      let text = outParts.join('\n\n') || '(no output)';
      // Shell file rewrites (sed -i, redirects, …) leave prior read_file bodies
      // and ToolStateManager prior-read credit stale — clear credit for high-
      // confidence paths so the next surgical edit must re-read (Claude FileEdit).
      const writebackWarning = formatRedactedWritebackWarning(
        filesWithIncreasedPlaceholderCount(mutationSnap)
      );
      if ((result.exitCode ?? 0) === 0) {
        const paths = extractShellMutationPaths(commandText);
        for (const rel of paths) {
          const abs = path.isAbsolute(rel) ? rel : path.resolve(ctx.workspaceDir, rel);
          globalToolStateManager.invalidateFileState(abs);
        }
        if (paths.length > 0) {
          text +=
            '\n\n[moss] Detected shell file mutation — prior read credit cleared for: ' +
            paths.join(', ') +
            '. Prefer edit_file/multi_edit/apply_patch; re-read before the next surgical edit.';
        }
      }
      streamer?.flush();
      return text + writebackWarning + footnote + hooksNotice(`${result.stdout}\n${result.stderr}`);
    } catch (err) {
      streamer?.flush();
      const writebackWarning = formatRedactedWritebackWarning(
        filesWithIncreasedPlaceholderCount(mutationSnap)
      );
      if (err instanceof ProcessError) {
        const output = [err.stdout.trim(), err.stderr.trim()].filter(Boolean).join('\n');
        const timedOut =
          /timeout|timed out|killed/i.test(err.message) || err.exitCode === null
            ? `\n(hint: raise timeout_ms or use exec_background for long-running processes; default timeout is ${EXEC_DEFAULT_TIMEOUT_MS}ms)`
            : '';
        return (
          `Command failed (exit ${err.exitCode}):\n${output || err.message}${timedOut}${writebackWarning}` +
          footnote +
          hooksNotice(`${err.stdout}\n${err.stderr}`)
        );
      }
      throw err;
    }
  },
};

export const webFetchTool: Tool = createWebFetchTool();
export const webSearchTool: Tool = createWebSearchTool();

import {
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  moveFileTool,
  listDirectoryTool,
} from './file-tools.js';
import { repoOutlineTool } from './repo-outline.js';
import { searchFilesTool, searchCodeTool } from './search-tools.js';
import { applyPatchTool } from './patch-tool.js';
import { todoWriteTool } from './todo-tool.js';
import { askUserQuestionTool } from './ask-user-question.js';
import { exitPlanTool, planGateEnabled } from './plan-gate.js';
import { toolSearchTool } from './tool-search.js';

// Tool naming convention:
// - Function/const names use camelCase (e.g., editFileTool, webFetchTool)
// - tool.name fields use snake_case (e.g., 'edit_file', 'web_fetch')
// This convention is relied upon by tool classification logic (e.g., classifyTool in onboarding.ts).
// Maintain consistency when adding new tools.
export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  moveFileTool,
  listDirectoryTool,
  repoOutlineTool,
  execTool,
  searchFilesTool,
  searchCodeTool,
  todoWriteTool,
  askUserQuestionTool,
  exitPlanTool,
  webFetchTool,
  webSearchTool,
  applyPatchTool,
  codeDiagnosticsTool,
  toolSearchTool,
  createSubagentTool,
  mergeSubagentPatchTool,
  fanOutSubagentsTool,
  subagentStatusTool,
  subagentStopTool,
  ...backgroundExecTools,
  ...harnessTools,
  ...deviceTools,
  ...evidenceTools,
  ...taskTools,
];

export function registerBuiltinTools(agent: { tools: { register: (tool: Tool) => void } }): void {
  for (const tool of builtinTools) {
    // exit_plan is only useful while the plan gate is on. Leaving it in the
    // prompt when MOSS_PLAN_GATE is unset spends tokens and invites a call
    // that cannot open the dialog. bench:ab plan-gate sets the env before
    // the process registers tools, so the on arm still receives it.
    if (tool.name === 'exit_plan' && !planGateEnabled()) continue;
    agent.tools.register(tool);
  }
}
