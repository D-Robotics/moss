











import fs from 'node:fs/promises';
import path from 'node:path';
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
import { planTool, planStepTool } from '../plan-execute/plan-tools.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import {
  IS_WIN,
  EXEC_DEFAULT_TIMEOUT_MS,
  childEnv,
  toolError,
} from './tool-helpers.js';

// Re-export tools from extracted modules for backward compatibility.
export { readFileTool, writeFileTool, editFileTool, moveFileTool, listDirectoryTool } from './file-tools.js';
export { searchFilesTool, searchCodeTool } from './search-tools.js';
export { applyPatchTool } from './patch-tool.js';
export { ToolStateManager } from './tool-helpers.js';

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

export function buildSkillMarkdown(input: Record<string, unknown>, skillName: string): string | null {
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

export const execTool: Tool = {
  name: 'exec',
  description:
    'Execute a shell command in the workspace directory. Returns stdout + stderr. Commands run with cwd set to the workspace. ' +
    'On Windows, this is the host PC shell (not a remote device); prefer device_exec when SSH is configured.\n' +
    '- Prefer the dedicated tools over shell equivalents: read_file over `cat`, edit_file over `sed`, search_files over `find`, search_code over `grep`/`rg`. Reserve exec for real shell work: installing deps, running tests/builds, git operations.\n' +
    '- Use absolute paths and avoid `cd`; the working directory is already the workspace and does not persist between calls.\n' +
    '- For long-running or blocking processes (dev servers, watchers, log tails) use exec_background instead of exec — a foreground exec that never returns will time out.',
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
          'Timeout in ms (default 120000). Raise it for slow builds/installs/training; for genuinely unbounded processes use exec_background instead.',
      },
    },
    required: ['command'],
  },
  async execute(input, ctx) {
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
      });
      const STDERR_MAX = 4096;
      const stderrRaw = result.stderr.trim();
      const stderrFmt = stderrRaw
        ? stderrRaw.length > STDERR_MAX
          ? `--- stderr (truncated ${stderrRaw.length}→${STDERR_MAX} chars) ---\n${stderrRaw.slice(0, STDERR_MAX)}`
          : `--- stderr ---\n${stderrRaw}`
        : '';
      const outParts = [result.stdout.trim(), stderrFmt].filter(Boolean);
      return outParts.join('\n\n') || '(no output)';
    } catch (err) {
      if (err instanceof ProcessError) {
        
        
        
        
        
        const output = [err.stdout.trim(), err.stderr.trim()].filter(Boolean).join('\n');
        return `Command failed (exit ${err.exitCode}):\n${output || err.message}`;
      }
      throw err;
    }
  },
};


export const webFetchTool: Tool = createWebFetchTool();

export const webSearchTool: Tool = createWebSearchTool();

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
      return `Installed skill ${skillName} at .moss/skills/${skillName}/SKILL.md`;
    } catch (err) {
      throw toolError('Error installing skill', err);
    }
  },
};






import { readFileTool, writeFileTool, editFileTool, moveFileTool, listDirectoryTool } from './file-tools.js';
import { searchFilesTool, searchCodeTool } from './search-tools.js';
import { applyPatchTool } from './patch-tool.js';

// Tool naming convention:
// - Function/const names use camelCase (e.g., editFileTool, webFetchTool)
// - tool.name fields use snake_case (e.g., 'edit_file', 'web_fetch')
// This convention is relied upon by tool classification logic (e.g., classifyTool in onboarding.ts)
// and capability pack registration. Maintain consistency when adding new tools.
export const builtinTools: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  moveFileTool,
  listDirectoryTool,
  execTool,
  searchFilesTool,
  searchCodeTool,
  webFetchTool,
  webSearchTool,
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
];




export function registerBuiltinTools(agent: { tools: { register: (tool: Tool) => void } }): void {
  for (const tool of builtinTools) {
    agent.tools.register(tool);
  }
}
