/**
 * Claude Code project config, opt-in.
 *
 * Tool-name mapping lets a Claude hook matcher such as `Bash` select Moss
 * tools. Reading `.claude/settings.json` and `.mcp.json` stays off until the
 * user accepts once per workspace (remembered under the user config dir).
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { McpServerConfig } from '../core/mcp/types.js';
import { isZhLocale } from './cli-locale.js';
import { HOOK_EVENT_KEYS, type HookCommandConfig, type HooksConfig } from './config.js';
import { describeMcpFile, type McpFileBrief } from './mcp-config.js';

const CLAUDE_TO_MOSS: Readonly<Record<string, readonly string[]>> = {
  Bash: ['exec', 'exec_background'],
  Edit: ['edit_file'],
  MultiEdit: ['multi_edit'],
  Write: ['write_file'],
  Read: ['read_file'],
  Grep: ['search_code'],
  Glob: ['search_files'],
  LS: ['list_directory'],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  TodoWrite: ['todo_write'],
  NotebookEdit: ['edit_file'],
  Task: ['create_subagent', 'fan_out_subagents'],
};

const mossNameToClaude = new Map<string, string>();
for (const [claude, mossNames] of Object.entries(CLAUDE_TO_MOSS)) {
  for (const moss of mossNames) {
    if (!mossNameToClaude.has(moss)) mossNameToClaude.set(moss, claude);
  }
}

export function claudeNamesForMossTool(toolName: string): readonly string[] {
  const names: string[] = [];
  for (const [claude, mossNames] of Object.entries(CLAUDE_TO_MOSS)) {
    if (mossNames.includes(toolName)) names.push(claude);
  }
  return names;
}

/** Claude tool name to put on a Claude-format hook payload. */
export function claudeToolName(toolName: string): string {
  return mossNameToClaude.get(toolName) ?? toolName;
}

const CLAUDE_FILE_PATH_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

/**
 * Claude hooks read `tool_input.file_path` for Read, Write, and Edit.
 * Moss file tools use `path`. Keep the Moss fields and add the Claude names.
 */
export function claudeToolInput(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (
    CLAUDE_FILE_PATH_TOOLS.has(claudeToolName(toolName)) &&
    typeof out.path === 'string' &&
    out.file_path === undefined
  ) {
    out.file_path = out.path;
  }
  return out;
}

/** Letters, digits, `_`, `-`, spaces, commas, and pipes: an exact list, not a regex. */
const CLAUDE_EXACT_MATCHER = /^[A-Za-z0-9_\- ,|]+$/;

export function hookMatcherMatches(
  matcher: string | undefined,
  toolName: string,
  claudeFormat: boolean
): boolean {
  const raw = matcher?.trim() ?? '';
  if (!raw || raw === '*') return true;
  const names = claudeFormat ? [toolName, ...claudeNamesForMossTool(toolName)] : [toolName];
  if (claudeFormat && CLAUDE_EXACT_MATCHER.test(raw)) {
    const alternatives = raw
      .split(/[|,]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return alternatives.some((part) => names.includes(part));
  }
  try {
    const re = new RegExp(raw);
    return names.some((name) => re.test(name));
  } catch {
    return names.includes(raw);
  }
}

function settingsPaths(workspaceDir: string): string[] {
  return [
    path.join(workspaceDir, '.claude', 'settings.json'),
    path.join(workspaceDir, '.claude', 'settings.local.json'),
  ];
}

function claudeAgentFilesExist(workspaceDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(workspaceDir, '.claude', 'agents'), { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => entry.isFile() && entry.name.endsWith('.md'));
}

export function claudeProjectConfigExists(workspaceDir: string): boolean {
  if (fs.existsSync(path.join(workspaceDir, '.mcp.json'))) return true;
  if (settingsPaths(workspaceDir).some((file) => fs.existsSync(file))) return true;
  return claudeAgentFilesExist(workspaceDir);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function commandFromEntry(entry: Record<string, unknown>): HookCommandConfig | undefined {
  const command = typeof entry.command === 'string' ? entry.command.trim() : '';
  if (!command) return undefined;
  if (entry.type !== undefined && entry.type !== 'command') return undefined;
  const hook: HookCommandConfig = { command, format: 'claude' };
  if (typeof entry.matcher === 'string' && entry.matcher.trim()) hook.matcher = entry.matcher;
  if (typeof entry.timeoutMs === 'number' && Number.isFinite(entry.timeoutMs)) {
    hook.timeoutMs = entry.timeoutMs;
  } else if (typeof entry.timeout === 'number' && Number.isFinite(entry.timeout)) {
    hook.timeoutMs = Math.round(entry.timeout * 1000);
  }
  return hook;
}

function hooksFromEvent(value: unknown): HookCommandConfig[] {
  if (!Array.isArray(value)) return [];
  const out: HookCommandConfig[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const nested = record.hooks;
    if (Array.isArray(nested)) {
      const matcher = typeof record.matcher === 'string' ? record.matcher : undefined;
      for (const child of nested) {
        const childRecord = asRecord(child);
        if (!childRecord) continue;
        const hook = commandFromEntry({ ...childRecord, ...(matcher ? { matcher } : {}) });
        if (hook) out.push(hook);
      }
      continue;
    }
    const hook = commandFromEntry(record);
    if (hook) out.push(hook);
  }
  return out;
}

function readHooksFile(filePath: string): HooksConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
  const root = asRecord(raw);
  const hooks = asRecord(root?.hooks);
  if (!hooks) return {};
  const parsed: HooksConfig = {};
  for (const key of HOOK_EVENT_KEYS) {
    const list = hooksFromEvent(hooks[key]);
    if (list.length > 0) parsed[key] = list;
  }
  return parsed;
}

export function readClaudeProjectHooks(workspaceDir: string): HooksConfig {
  const merged: HooksConfig = {};
  for (const file of settingsPaths(workspaceDir)) {
    if (!fs.existsSync(file)) continue;
    const hooks = readHooksFile(file);
    for (const key of HOOK_EVENT_KEYS) {
      const list = hooks[key];
      if (!list || list.length === 0) continue;
      merged[key] = [...(merged[key] ?? []), ...list];
    }
  }
  return merged;
}

export function claudeMcpPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.mcp.json');
}

/** Names and transports only. Env expansion happens later, when the servers load. */
export function describeClaudeMcp(workspaceDir: string): McpFileBrief[] {
  return describeMcpFile(claudeMcpPath(workspaceDir), {});
}

export function readClaudeMcpConfigs(
  workspaceDir: string,
  env: NodeJS.ProcessEnv = process.env,
  onWarning?: (message: string) => void
): McpServerConfig[] {
  return describeMcpFile(claudeMcpPath(workspaceDir), env, onWarning).map((brief) => brief.config);
}

const OPT_IN_FILE = 'claude-compat.json';

function workspaceKey(workspaceDir: string): string {
  try {
    return fs.realpathSync.native(workspaceDir);
  } catch {
    return path.resolve(workspaceDir);
  }
}

function readOptInStore(configDir: string): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(configDir, OPT_IN_FILE), 'utf8'));
    const record = asRecord(raw);
    if (!record) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeOptInStore(configDir: string, store: Record<string, boolean>): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, OPT_IN_FILE), `${JSON.stringify(store, null, 2)}\n`);
}

function isYes(answer: string): boolean {
  return /^(y|yes|是)$/i.test(answer.trim());
}

export function claudeOptInQuestion(zh: boolean): string {
  return zh
    ? '此项目包含 Claude 配置（.claude/ 或 .mcp.json）。加载其中的 hooks、MCP 和 agents？[y/N] '
    : 'This project has Claude config (.claude/ or .mcp.json). Load its hooks, MCP servers, and agents? [y/N] ';
}

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const finish = (answer: string) => {
      rl.close();
      resolve(isYes(answer));
    };
    rl.once('SIGINT', () => finish(''));
    rl.question(question, finish);
  });
}

export async function resolveClaudeCompatOptIn(input: {
  workspaceDir: string;
  configDir: string;
  interactive: boolean;
  ask?: (question: string) => Promise<boolean>;
  zh?: boolean;
}): Promise<boolean> {
  if (!claudeProjectConfigExists(input.workspaceDir)) return false;
  const key = workspaceKey(input.workspaceDir);
  const store = readOptInStore(input.configDir);
  if (typeof store[key] === 'boolean') return store[key];
  if (!input.interactive) return false;
  const zh = input.zh ?? isZhLocale();
  const yes = await (input.ask ?? askYesNo)(claudeOptInQuestion(zh));
  store[key] = yes;
  writeOptInStore(input.configDir, store);
  return yes;
}
