import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess, ProcessError } from '../utils/run-process.js';
import type { Tool } from '../core/tools/tool-types.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import {
  createSubagentTool,
  fanOutSubagentsTool,
  subagentStatusTool,
  subagentStopTool,
} from './create-subagent.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';
import { createBrowserTools } from './browser-tools.js';
import { backgroundExecTools } from './background-exec.js';
import { codeDiagnosticsTool } from './code-diagnostics.js';
import { visionAnalyzeTool } from '../vision/vision-tool.js';
import { screenshotCaptureTool } from './screenshot-capture.js';
import { batchDeviceTool } from './batch-device.js';
import { webBrowserAgentTool } from '../web-browser/browser-agent-tool.js';
import { structuredOutputTool } from '../structured-output/structured-output-tool.js';
import { evalTool } from '../eval/eval-tool.js';
import { harnessTools } from './harness-tools.js';
import {
  createPlanStepTool,
  createPlanTool,
  planStepTool,
  planTool,
} from '../plan-execute/plan-tools.js';
import type { PlanControllerStore } from '../plan-execute/plan-controller-store.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import {
  IS_WIN,
  EXEC_DEFAULT_TIMEOUT_MS,
  childEnv,
  toolError,
  globalToolStateManager,
} from './tool-helpers.js';
import { extractShellMutationPaths } from '../context/stale-read-invalidate.js';

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
export { loadSkillTool, skillhubSearchTool, skillhubInstallTool } from './skill-tools.js';

const SKILL_BODY_MAX_CHARS = 80_000;
const ALLOWED_SKILL_RISKS = new Set(['low', 'medium', 'high']);
const ALLOWED_SKILL_PERMISSIONS = new Set([
  'workspace_read',
  'workspace_write',
  'device_exec',
  'network',
]);
const ALLOWED_SKILL_APPROVAL_LEVELS = new Set(['none', 'confirm', 'strict']);

export function oneLine(input: unknown, fallback = ''): string {
  const value = typeof input === 'string' ? input : fallback;
  return value.replace(/\s+/g, ' ').trim();
}

export function stringList(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((item) => oneLine(item))
      .filter(Boolean)
      .map((item) => item.replace(/[;,]/g, ' '));
  }
  if (typeof input === 'string') {
    return input
      .split(/[;,]/)
      .map((item) => oneLine(item))
      .filter(Boolean)
      .map((item) => item.replace(/[;,]/g, ' '));
  }
  return [];
}

export function normalizeSkillSlug(input: unknown): string | null {
  const raw = oneLine(input);
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) return null;
  return slug;
}

export function frontmatterListLine(key: string, values: string[]): string[] {
  return values.length > 0 ? [`${key}: ${values.join(', ')}`] : [];
}

export function buildSkillMarkdown(
  input: Record<string, unknown>,
  skillName: string
): string | null {
  const description = oneLine(input.description);
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!description || !body || body.length > SKILL_BODY_MAX_CHARS) return null;
  const risk = oneLine(input.risk, 'medium').toLowerCase();
  const approvalLevel = oneLine(input.approval_level, 'confirm').toLowerCase();
  if (!ALLOWED_SKILL_RISKS.has(risk) || !ALLOWED_SKILL_APPROVAL_LEVELS.has(approvalLevel))
    return null;
  const permissions = stringList(input.permissions).filter((permission) =>
    ALLOWED_SKILL_PERMISSIONS.has(permission)
  );
  const tags = stringList(input.tags);
  const trigger = stringList(input.trigger ?? input.triggers);
  return [
    '---',
    `name: ${skillName}`,
    `description: ${description}`,
    `version: ${oneLine(input.version, '0.1.0') || '0.1.0'}`,
    ...frontmatterListLine('tags', tags),
    ...frontmatterListLine('trigger', trigger),
    `risk: ${risk}`,
    ...frontmatterListLine('permissions', permissions),
    `approval_level: ${approvalLevel}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

const WIN_POSIX_HINT =
  'On Windows the local shell is cmd/PowerShell: Unix-only utilities (e.g. uname, grep without Git) are unavailable. ' +
  'Use PowerShell equivalents, read workspace files, or use device_* tools when SSH to a Linux board is configured.';

/**
 * Detect whether captured stdout looks like binary data (e.g. `cat /bin/ls`).
 * runProcess captures as UTF-8, so binary produces U+FFFD replacement chars
 * and control chars. If more than 10% of chars are non-printable, treat as binary so
 * the exec tool returns a safe summary instead of flooding the model's context.
 * @public
 */
export function looksBinary(text: string): boolean {
  if (!text || text.length < 20) return false;
  let nonPrintable = 0;
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0xfffd) {
      nonPrintable++;
      continue;
    }
    if (code === 0) {
      nonPrintable++;
      continue;
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
      continue;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

export const execTool: Tool = {
  name: 'exec',
  description:
    'Execute a shell command in the workspace directory. Returns stdout + stderr. Commands run with cwd set to the workspace. ' +
    'On Windows, this is the host PC shell (not a remote device); prefer device_exec when SSH is configured.\n' +
    '- Prefer the dedicated tools over shell equivalents: read_file over `cat`, edit_file/multi_edit over `sed`, search_files over `find`, search_code over `grep`/`rg`, run_tests/verify_fix over ad-hoc test scripts. Reserve exec for real shell work: installing deps, custom build scripts, git operations.\n' +
    '- Use absolute paths and avoid `cd`; the working directory is already the workspace and does not persist between calls.\n' +
    '- For long-running or blocking processes (dev servers, watchers, log tails) set run_in_background=true (Claude Code Bash parity) or call exec_background — a foreground exec that never returns will time out. You will be notified when a background command finishes; use exec_logs/exec_stop with the returned id.\n' +
    '- Prefer one focused command per call. Chain with `&&` only when the second step must not run if the first fails.',
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
          'Timeout in ms (default 120000). Raise it for slow builds/installs/training; for genuinely unbounded processes use run_in_background / exec_background instead.',
      },
      run_in_background: {
        type: 'boolean',
        description:
          'If true, start the command in the background and return a handle id immediately (Claude Code Bash run_in_background parity). Use exec_logs / exec_stop with that id. Do not append "&" to the command.',
      },
      label: {
        type: 'string',
        description: 'Optional label when run_in_background is true (shown in exec_logs listings).',
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
          label: typeof input.label === 'string' ? input.label : undefined,
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
    try {
      const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
      const result = await runProcess(shell, {
        args: IS_WIN ? ['/c', input.command] : ['-c', input.command],
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.abortSignal,
        env: childEnv(ctx.workspaceDir),
        cwd: ctx.workspaceDir,
        // Live streaming: forward stdout chunks to the host (TUI/headless
        // renderer) so long-running commands show output incrementally.
        ...(ctx.onToolOutput ? { onStdoutChunk: ctx.onToolOutput } : {}),
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
      if ((result.exitCode ?? 0) === 0) {
        const paths = extractShellMutationPaths(String(input.command ?? ''));
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
      return text;
    } catch (err) {
      if (err instanceof ProcessError) {
        const output = [err.stdout.trim(), err.stderr.trim()].filter(Boolean).join('\n');
        const timedOut =
          /timeout|timed out|killed/i.test(err.message) || err.exitCode === null
            ? `\n(hint: raise timeout_ms or use exec_background for long-running processes; default timeout is ${EXEC_DEFAULT_TIMEOUT_MS}ms)`
            : '';
        return `Command failed (exit ${err.exitCode}):\n${output || err.message}${timedOut}`;
      }
      throw err;
    }
  },
};

export const webFetchTool: Tool = createWebFetchTool();

/**
 * Read the bundled Bocha search API key (generated at pack time) or fall back
 * to the `BOCHA_API_KEY` env var (loaded from `.env` by `loadEnvFromAncestors`
 * during development). Returns `undefined` when neither is available — the
 * keyless Bing/DuckDuckGo fallback chain is used instead.
 */
function readBundledBochaKey(): string | undefined {
  // 1. env var (development: loaded from .env by loadEnvFromAncestors)
  if (process.env.BOCHA_API_KEY) return process.env.BOCHA_API_KEY;
  // 2. bundled file (packaged: generated by prepare-bundled-search-key.mjs)
  try {
    const keyPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'bundled-search-key.json'
    );
    if (existsSync(keyPath)) {
      const data = JSON.parse(readFileSync(keyPath, 'utf8'));
      return typeof data.bochaApiKey === 'string' && data.bochaApiKey
        ? data.bochaApiKey
        : undefined;
    }
  } catch {
    // ignore — no bundled key available
  }
  return undefined;
}

const bundledBochaKey = readBundledBochaKey();
/**
 * The bundled Bocha key (env `BOCHA_API_KEY` first, then the pack-time
 * `bundled-search-key.json`). Exported so callers that re-register
 * `web_search` with extra options (e.g. a region) can merge the key in
 * instead of dropping it — `ToolRegistry.register` overwrites by name, so a
 * re-registration without the key would silently lose the bundled key that
 * the builtin tool already loaded.
 */
export { bundledBochaKey };
export const webSearchTool: Tool = createWebSearchTool(
  bundledBochaKey ? { bochaApiKey: bundledBochaKey } : {}
);

export const installSkillTool: Tool = {
  name: 'install_skill',
  description:
    'Install or update a Moss SKILL.md in the current workspace .moss/skills directory. ' +
    'Use this when a reusable workflow should become an explicit skill that future Moss runs can discover.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Skill id. It is normalized to a lowercase slug and must not contain path separators.',
      },
      description: {
        type: 'string',
        description: 'One-line description used by the skill registry.',
      },
      body: {
        type: 'string',
        description: 'Markdown body of SKILL.md after the frontmatter.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional skill tags.',
      },
      trigger: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional phrases that should trigger the skill.',
      },
      risk: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Skill risk level (default medium).',
      },
      permissions: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['workspace_read', 'workspace_write', 'device_exec', 'network'],
        },
        description: 'Optional permissions requested by the skill.',
      },
      approval_level: {
        type: 'string',
        enum: ['none', 'confirm', 'strict'],
        description: 'Runtime approval level (default confirm).',
      },
      version: {
        type: 'string',
        description: 'Optional skill version (default 0.1.0).',
      },
      overwrite: {
        type: 'boolean',
        description: 'Overwrite an existing skill with the same normalized name (default false).',
      },
    },
    required: ['name', 'description', 'body'],
  },
  async execute(input, ctx) {
    try {
      const skillName = normalizeSkillSlug(input.name);
      if (!skillName)
        return 'Error: invalid skill name. Use letters, numbers, spaces, underscores, or hyphens; path separators are not allowed.';
      const markdown = buildSkillMarkdown(input, skillName);
      if (!markdown) {
        return 'Error: invalid skill content. Provide a non-empty description and body, valid risk/approval_level values, and keep body under 80000 characters.';
      }
      const paths = getMossWorkspacePaths(ctx.workspaceDir);
      const skillDir = path.join(paths.skillsDir, skillName);
      const skillPath = path.join(skillDir, 'SKILL.md');
      const overwrite = input.overwrite === true;
      try {
        await fs.stat(skillPath);
        if (!overwrite) {
          return `Error: skill ${skillName} already exists at .moss/skills/${skillName}/SKILL.md. Set overwrite=true to replace it.`;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await atomicWriteFile(skillPath, markdown);
      return (
        `Installed skill ${skillName} at .moss/skills/${skillName}/SKILL.md. ` +
        `Install only writes SKILL.md — call load_skill name="${skillName}" now to inject instructions for this turn ` +
        `(or say you only wanted it for future sessions).`
      );
    } catch (err) {
      throw toolError('Error installing skill', err);
    }
  },
};

import {
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  moveFileTool,
  listDirectoryTool,
} from './file-tools.js';
import { searchFilesTool, searchCodeTool } from './search-tools.js';
import { applyPatchTool } from './patch-tool.js';
import { todoWriteTool } from './todo-tool.js';
import { askUserQuestionTool } from './ask-user-question.js';
import {
  createLoadSkillTool,
  loadSkillTool,
  skillhubSearchTool,
  skillhubInstallTool,
} from './skill-tools.js';
import type { SkillRegistry } from '../skills/registry.js';

// Tool naming convention:
// - Function/const names use camelCase (e.g., editFileTool, webFetchTool)
// - tool.name fields use snake_case (e.g., 'edit_file', 'web_fetch')
// This convention is relied upon by tool classification logic (e.g., classifyTool in onboarding.ts)
// and capability pack registration. Maintain consistency when adding new tools.
export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  moveFileTool,
  listDirectoryTool,
  execTool,
  searchFilesTool,
  searchCodeTool,
  todoWriteTool,
  askUserQuestionTool,
  webFetchTool,
  webSearchTool,
  loadSkillTool,
  skillhubSearchTool,
  skillhubInstallTool,
  installSkillTool,
  ...createBrowserTools(),
  applyPatchTool,
  codeDiagnosticsTool,
  createSubagentTool,
  fanOutSubagentsTool,
  subagentStatusTool,
  subagentStopTool,
  ...backgroundExecTools,
  visionAnalyzeTool,
  screenshotCaptureTool,
  webBrowserAgentTool,
  structuredOutputTool,
  evalTool,
  planTool,
  planStepTool,
  batchDeviceTool,
  ...harnessTools,
];

export function registerBuiltinTools(agent: {
  tools: { register: (tool: Tool) => void };
  planControllerStore?: PlanControllerStore;
  executionStore?: import('../orchestration/index.js').ExecutionStore;
}): void {
  const skillRegistry = (agent as { config?: { skillRegistry?: SkillRegistry } }).config
    ?.skillRegistry;
  for (const tool of builtinTools) {
    const instanceTool =
      tool.name === 'plan' && agent.planControllerStore
        ? createPlanTool(agent.planControllerStore, agent.executionStore)
        : tool.name === 'plan_step' && agent.planControllerStore
          ? createPlanStepTool(agent.planControllerStore, agent.executionStore)
          : tool;
    agent.tools.register(
      instanceTool.name === 'load_skill' && skillRegistry
        ? createLoadSkillTool(skillRegistry)
        : instanceTool
    );
  }
}
