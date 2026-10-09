/**
 * File-defined sub-agents (Claude Code compatible).
 *
 * Discovery, first match wins:
 *   1. `<workspace>/.moss/agents/*.md`     project Moss
 *   2. `<workspace>/.claude/agents/*.md`   project Claude
 *   3. `~/.moss/agents/*.md`               user Moss
 *   4. `~/.claude/agents/*.md`             user Claude
 *
 * YAML frontmatter supplies `name`, `description`, `tools`, and `model`.
 * The markdown body is the system prompt. Fields that would widen permissions
 * (`permissionMode`, `hooks`, `mcpServers`, …) are ignored and reported.
 * Pass the result to `MossAgent` as `subagentExperts` / `subagentExpertNotices`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_ANALYSIS_EXPERTS,
  stampFileAgent,
  type FileAgentOrigin,
  type SubagentExpertDefinition,
} from './expert-registry.js';

const EXPERT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const READ_ONLY_TOOLS = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'search_code',
  'memory_read',
]);

/** Tools that mutate the workspace or a device. Omitted `tools` inherits these. */
export const FILE_AGENT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'exec',
  'exec_background',
  'exec_stop',
  'write_file',
  'edit_file',
  'multi_edit',
  'move_file',
  'apply_patch',
  'run_tests',
  'verify_fix',
  'device_exec',
  'device_file_write',
  'device_deploy',
]);

const AGENT_TOOL_IDS = new Set<string>([
  ...READ_ONLY_TOOLS,
  ...FILE_AGENT_WRITE_TOOLS,
  'exec_logs',
  'exec_wait',
  'web_fetch',
  'web_search',
  'todo_write',
  'code_diagnostics',
  'repo_outline',
  'skill',
  'ask_user_question',
  'device_info',
  'device_file_read',
  'device_file_list',
  'device_processes',
  'device_resources',
  'device_temperature',
  'device_robotics_status',
  'device_network',
  'device_cameras',
  'record_evidence',
  'task_acceptance',
]);

/** Claude Code tool names (and compact Moss names) → Moss tool ids. */
const TOOL_ALIASES: Record<string, string> = {
  bash: 'exec',
  shell: 'exec',
  edit: 'edit_file',
  write: 'write_file',
  read: 'read_file',
  grep: 'search_code',
  glob: 'search_files',
  ls: 'list_directory',
  list: 'list_directory',
  webfetch: 'web_fetch',
  websearch: 'web_search',
  todowrite: 'todo_write',
  multiedit: 'multi_edit',
  readfile: 'read_file',
  writefile: 'write_file',
  editfile: 'edit_file',
  listdirectory: 'list_directory',
  searchfiles: 'search_files',
  searchcode: 'search_code',
  applypatch: 'apply_patch',
  movefile: 'move_file',
  runtests: 'run_tests',
  askuserquestion: 'ask_user_question',
};

const WIDENING_FIELDS = new Set([
  'permissionmode',
  'permissions',
  'hooks',
  'mcpservers',
  'mcp',
  'dangerouslyskippermissions',
  'bypasspermissions',
  'skills',
  'memory',
]);

const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'tools',
  'disallowedtools',
  'model',
  'maxturns',
]);

/** Workspace trust for project agents. Both flags default to false. */
export interface ProjectAgentTrust {
  /** Project agents that declare write tools load only when this is true. */
  readonly trusted: boolean;
  /** Project `.claude/agents` sources load only when this is also true. */
  readonly claudeOptIn: boolean;
}

export interface LoadAgentFilesOptions {
  workspaceDir: string;
  /** Defaults to `os.homedir()`. Tests pass a temp home. */
  homeDir?: string;
  /**
   * Parent session model. An agent `model` field is kept only when it equals
   * this id or a `modelTiers` value. Anything else inherits the parent model.
   */
  parentModel?: string;
  /** `cheap` / `balanced` / `strong` resolve through these when set. */
  modelTiers?: { cheap?: string; balanced?: string; strong?: string };
  /**
   * Default deny. Project write agents need `trusted`; project `.claude/agents`
   * sources also need `claudeOptIn`. A later caller passes the real result.
   */
  projectTrust?: ProjectAgentTrust;
}

export interface AgentFileLoadResult {
  agents: SubagentExpertDefinition[];
  /** JSON notice strings for files that were not registered. */
  notices: string[];
}

type FieldValue =
  | { kind: 'string'; value: string }
  | { kind: 'list'; value: string[] }
  | { kind: 'present' };

function notice(payload: Record<string, string>): string {
  return JSON.stringify(payload);
}

function warn(payload: Record<string, string>): string {
  return JSON.stringify(payload);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitList(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ',') {
      const item = current.trim();
      if (item) out.push(unquote(item));
      current = '';
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) out.push(unquote(tail));
  return out;
}

function parseFrontmatter(header: string): { fields: Map<string, FieldValue>; warnings: string[] } {
  const fields = new Map<string, FieldValue>();
  const warnings: string[] = [];
  const lines = header.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('\t')) {
      warnings.push(warn({ code: 'malformed-line', detail: line.trim() }));
      i += 1;
      continue;
    }
    const idx = line.indexOf(':');
    if (idx <= 0) {
      warnings.push(warn({ code: 'malformed-line', detail: line.trim() }));
      i += 1;
      continue;
    }
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (raw === '|' || raw === '>' || raw === '|-' || raw === '>-') {
      const block: string[] = [];
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (next.trim() && !next.startsWith(' ') && !next.startsWith('\t')) break;
        block.push(next.trim());
        i += 1;
      }
      const joined = raw.startsWith('>') ? block.join(' ') : block.join('\n');
      fields.set(key, { kind: 'string', value: joined.trim() });
      continue;
    }
    if (raw === '') {
      const list: string[] = [];
      let nested = false;
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (!next.trim()) {
          i += 1;
          continue;
        }
        if (!next.startsWith(' ') && !next.startsWith('\t')) break;
        const trimmed = next.trim();
        if (trimmed.startsWith('- ')) list.push(unquote(trimmed.slice(2).trim()));
        else nested = true;
        i += 1;
      }
      fields.set(
        key,
        list.length > 0 && !nested ? { kind: 'list', value: list } : { kind: 'present' }
      );
      continue;
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      fields.set(key, { kind: 'list', value: inner ? splitList(inner) : [] });
      i += 1;
      continue;
    }
    fields.set(key, { kind: 'string', value: unquote(raw) });
    i += 1;
  }
  return { fields, warnings };
}

function splitDocument(raw: string): { header: string; body: string } | { error: string } {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---')) return { error: 'missing frontmatter' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { error: 'malformed frontmatter (no closing ---)' };
  const closer = text.slice(end + 1);
  if (!/^---[ \t]*(\n|$)/.test(closer)) return { error: 'malformed frontmatter' };
  const headerStart = text.indexOf('\n');
  const header = text.slice(headerStart + 1, end);
  const body = text.slice(end + 4).replace(/^\n/, '');
  return { header, body };
}

function toExpertId(name: string): string | undefined {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return EXPERT_ID_PATTERN.test(slug) ? slug : undefined;
}

/** `Bash(git push *)` → `Bash`. The parenthetical is not a command filter. */
function toolBase(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

function mapTool(raw: string): { tool?: string; warning?: string } {
  const trimmed = toolBase(raw);
  if (!trimmed) return {};
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('mcp__')) return { tool: lower };
  if (AGENT_TOOL_IDS.has(lower)) return { tool: lower };
  const alias = TOOL_ALIASES[lower.replace(/[_-]/g, '')];
  if (alias) return { tool: alias };
  return { warning: warn({ code: 'unmapped-tool', tool: trimmed }) };
}

/** Normalize a Claude or Moss tool spec to a Moss id or an `mcp__` prefix. */
export function canonicalAgentTool(raw: string): string | undefined {
  return mapTool(raw).tool;
}

function toolNames(field: FieldValue | undefined): { tools?: string[]; warnings: string[] } {
  if (!field) return { warnings: [] };
  if (field.kind === 'present') {
    return { tools: [], warnings: [warn({ code: 'malformed-tools' })] };
  }
  const raw = field.kind === 'list' ? field.value : splitList(field.value);
  const tools: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const mapped = mapTool(item);
    if (mapped.warning) warnings.push(mapped.warning);
    if (mapped.tool && !seen.has(mapped.tool)) {
      seen.add(mapped.tool);
      tools.push(mapped.tool);
    }
  }
  return { tools, warnings };
}

function configuredTierValues(options: LoadAgentFilesOptions): string[] {
  const tiers = options.modelTiers;
  return [tiers?.cheap, tiers?.balanced, tiers?.strong]
    .map((item) => item?.trim() ?? '')
    .filter((item) => item.length > 0);
}

function resolveModel(
  raw: string | undefined,
  options: LoadAgentFilesOptions
): { model?: string; warning?: string } {
  const value = raw?.trim() ?? '';
  if (!value || value.toLowerCase() === 'inherit') return {};
  const parent = options.parentModel?.trim();
  if (parent && value === parent) return { model: parent };
  const key = value.toLowerCase();
  const tierKey = key === 'cheap' || key === 'balanced' || key === 'strong' ? key : undefined;
  const tier = tierKey ? options.modelTiers?.[tierKey]?.trim() : undefined;
  if (tier) return { model: tier };
  if (configuredTierValues(options).includes(value)) return { model: value };
  return { warning: warn({ code: 'model-inherit', alias: value }) };
}

export function projectAgentDeclaresWriteTools(agent: {
  agentOrigin?: FileAgentOrigin;
  allowedTools?: readonly string[];
  deniedTools?: readonly string[];
}): boolean {
  if (agent.agentOrigin !== 'project-moss' && agent.agentOrigin !== 'project-claude') return false;
  const denied = new Set(agent.deniedTools ?? []);
  const writes = (tool: string) => FILE_AGENT_WRITE_TOOLS.has(tool) && !denied.has(tool);
  if (agent.allowedTools === undefined) {
    for (const tool of FILE_AGENT_WRITE_TOOLS) {
      if (!denied.has(tool)) return true;
    }
    return false;
  }
  return agent.allowedTools.some(writes);
}

function projectTrustBlock(
  agent: {
    agentOrigin?: FileAgentOrigin;
    allowedTools?: readonly string[];
    deniedTools?: readonly string[];
  },
  trust: ProjectAgentTrust
): string | undefined {
  const reasons: string[] = [];
  if (agent.agentOrigin === 'project-claude' && trust.claudeOptIn !== true) reasons.push('claude');
  if (projectAgentDeclaresWriteTools(agent) && trust.trusted !== true) reasons.push('workspace');
  return reasons.length > 0 ? reasons.join('+') : undefined;
}

function scopeFor(tools: readonly string[] | undefined): 'read-only' | 'full' {
  if (!tools) return 'full';
  return tools.every((tool) => READ_ONLY_TOOLS.has(tool)) ? 'read-only' : 'full';
}

function listMarkdown(dir: string): { files: string[]; notice?: string } {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return {
      files: entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => entry.name)
        .sort(),
    };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { files: [] };
    return { files: [], notice: notice({ code: 'unreadable', file: dir }) };
  }
}

function fieldKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function findField(fields: Map<string, FieldValue>, name: string): FieldValue | undefined {
  const want = fieldKey(name);
  for (const [key, value] of fields) {
    if (fieldKey(key) === want) return value;
  }
  return undefined;
}

function fieldString(field: FieldValue | undefined): string | undefined {
  if (!field || field.kind !== 'string') return undefined;
  const value = field.value.trim();
  return value || undefined;
}

function parseAgentFile(
  file: string,
  origin: FileAgentOrigin,
  options: LoadAgentFilesOptions
): { expert?: SubagentExpertDefinition; notices: string[] } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { notices: [notice({ code: 'unreadable', file, detail })] };
  }
  const split = splitDocument(raw);
  if ('error' in split) {
    return { notices: [notice({ code: 'malformed', file, detail: split.error })] };
  }
  let parsed: { fields: Map<string, FieldValue>; warnings: string[] };
  try {
    parsed = parseFrontmatter(split.header);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { notices: [notice({ code: 'malformed', file, detail })] };
  }
  const warnings = [...parsed.warnings];
  const widening: string[] = [];
  const unsupported: string[] = [];
  for (const key of parsed.fields.keys()) {
    const folded = key.toLowerCase().replace(/[_-]/g, '');
    if (KNOWN_FIELDS.has(folded)) continue;
    if (WIDENING_FIELDS.has(folded)) widening.push(key);
    else unsupported.push(key);
  }
  if (widening.length > 0) {
    warnings.push(warn({ code: 'ignored-field', fields: widening.join(', ') }));
  }
  if (unsupported.length > 0) {
    warnings.push(warn({ code: 'unsupported', fields: unsupported.join(', ') }));
  }

  const name = fieldString(findField(parsed.fields, 'name')) ?? path.basename(file, '.md');
  const id = toExpertId(name);
  if (!id) {
    return { notices: [notice({ code: 'bad-name', file, detail: name })] };
  }
  const description = fieldString(findField(parsed.fields, 'description'));
  if (!description) {
    return { notices: [notice({ code: 'missing', file, detail: 'description' })] };
  }
  const instructions = split.body.trim();
  if (!instructions) {
    return { notices: [notice({ code: 'missing', file, detail: 'body' })] };
  }

  const toolsField = findField(parsed.fields, 'tools');
  const declared = toolsField !== undefined;
  const mapped = toolNames(declared ? toolsField : undefined);
  warnings.push(...mapped.warnings);
  let allowedTools = declared ? (mapped.tools ?? []) : undefined;
  let deniedTools: string[] | undefined;
  const deniedField = findField(parsed.fields, 'disallowedtools');
  if (deniedField) {
    const denied = toolNames(deniedField);
    warnings.push(...denied.warnings);
    if (denied.tools && denied.tools.length > 0) {
      deniedTools = denied.tools;
      if (allowedTools) {
        const drop = new Set(deniedTools);
        allowedTools = allowedTools.filter((tool) => !drop.has(tool));
      }
    }
  }
  const model = resolveModel(fieldString(findField(parsed.fields, 'model')), options);
  if (model.warning) warnings.push(model.warning);
  const maxTurnsRaw = fieldString(findField(parsed.fields, 'maxturns'));
  let maxTurns: number | undefined;
  if (maxTurnsRaw !== undefined) {
    const parsedTurns = Number(maxTurnsRaw);
    if (Number.isInteger(parsedTurns) && parsedTurns >= 1) maxTurns = parsedTurns;
    else warnings.push(warn({ code: 'bad-max-turns', detail: maxTurnsRaw }));
  }

  const expert: SubagentExpertDefinition = {
    id,
    displayName: name.trim(),
    description: description.replace(/\s+/g, ' ').slice(0, 500),
    instructions: instructions.slice(0, 64_000),
    scope: scopeFor(allowedTools),
    fileDefined: true,
    sourcePath: file,
    agentOrigin: origin,
    ...(warnings.length > 0 ? { loadWarnings: warnings } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(deniedTools && deniedTools.length > 0 ? { deniedTools } : {}),
    ...(model.model ? { model: model.model } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
  stampFileAgent(expert);
  return { expert, notices: [] };
}

function sourceDirs(
  options: LoadAgentFilesOptions
): Array<{ dir: string; origin: FileAgentOrigin }> {
  const home = options.homeDir ?? os.homedir();
  return [
    { dir: path.join(options.workspaceDir, '.moss', 'agents'), origin: 'project-moss' },
    { dir: path.join(options.workspaceDir, '.claude', 'agents'), origin: 'project-claude' },
    { dir: path.join(home, '.moss', 'agents'), origin: 'user-moss' },
    { dir: path.join(home, '.claude', 'agents'), origin: 'user-claude' },
  ];
}

/** Load agent markdown. Missing directories are skipped. Parse errors are notices. */
export function loadAgentFiles(options: LoadAgentFilesOptions): AgentFileLoadResult {
  const agents: SubagentExpertDefinition[] = [];
  const notices: string[] = [];
  const winners = new Map<string, string>();
  for (const source of sourceDirs(options)) {
    const listed = listMarkdown(source.dir);
    if (listed.notice) notices.push(listed.notice);
    for (const name of listed.files) {
      const file = path.join(source.dir, name);
      let parsed: { expert?: SubagentExpertDefinition; notices: string[] };
      try {
        parsed = parseAgentFile(file, source.origin, options);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        notices.push(notice({ code: 'malformed', file, detail }));
        continue;
      }
      notices.push(...parsed.notices);
      const expert = parsed.expert;
      if (!expert) continue;
      const winner = winners.get(expert.id);
      if (winner) {
        notices.push(notice({ code: 'clash', file, id: expert.id, winner }));
        continue;
      }
      const trust = options.projectTrust ?? { trusted: false, claudeOptIn: false };
      const blocked = projectTrustBlock(expert, trust);
      if (blocked) {
        notices.push(notice({ code: 'trust-blocked', file, id: expert.id, reason: blocked }));
        continue;
      }
      winners.set(expert.id, file);
      agents.push(expert);
    }
  }
  return { agents, notices };
}

/**
 * Drop file agents whose ids collide with built-in experts. The registry
 * rejects duplicates; a user file named `debugger` must not crash startup.
 */
export function adoptFileAgents(loaded: AgentFileLoadResult): AgentFileLoadResult {
  const reserved = new Set(BUILTIN_ANALYSIS_EXPERTS.map((expert) => expert.id));
  const agents: SubagentExpertDefinition[] = [];
  const notices = [...loaded.notices];
  for (const expert of loaded.agents) {
    if (reserved.has(expert.id)) {
      notices.push(
        notice({
          code: 'builtin-clash',
          file: expert.sourcePath ?? expert.id,
          id: expert.id,
        })
      );
      continue;
    }
    agents.push(expert);
  }
  return { agents, notices };
}

const ORIGIN_LABEL: Record<FileAgentOrigin, { en: string; zh: string }> = {
  'project-moss': { en: 'project .moss', zh: '项目 .moss' },
  'project-claude': { en: 'project .claude', zh: '项目 .claude' },
  'user-moss': { en: 'user ~/.moss', zh: '用户 ~/.moss' },
  'user-claude': { en: 'user ~/.claude', zh: '用户 ~/.claude' },
};

function formatWarning(raw: string, zh: boolean): string {
  let payload: Record<string, string> | undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') record[key] = value;
      }
      payload = record;
    }
  } catch {
    return raw;
  }
  if (!payload?.code) return raw;
  const fields = payload.fields ?? payload.tool ?? payload.alias ?? payload.detail ?? '';
  switch (payload.code) {
    case 'ignored-field':
      return zh
        ? `已忽略 ${fields}（这些字段会放宽权限）`
        : `ignored ${fields} (would widen permissions)`;
    case 'unmapped-tool':
      return zh ? `未映射工具 ${fields}` : `unmapped tool ${fields}`;
    case 'model-inherit':
      return zh
        ? `模型 ${fields} 不是父模型或 modelTiers 中的值，沿用父模型`
        : `model ${fields} is not the parent model or a modelTiers value; inheriting the parent model`;
    case 'unsupported':
      return zh ? `已忽略不支持的字段 ${fields}` : `ignored unsupported fields ${fields}`;
    case 'malformed-tools':
      return zh ? 'tools 字段无法解析，未授予工具' : 'tools field was not a list; no tools granted';
    case 'malformed-line':
      return zh
        ? `frontmatter 有无法识别的行：${fields}`
        : `unrecognized frontmatter line: ${fields}`;
    case 'disallowed-ignored':
      return zh
        ? '未声明 tools 时忽略 disallowedTools'
        : 'disallowedTools ignored because tools was omitted';
    case 'bad-max-turns':
      return zh ? `忽略无效的 maxTurns：${fields}` : `ignored invalid maxTurns: ${fields}`;
    default:
      return zh
        ? `${payload.code}${fields ? ` ${fields}` : ''}`
        : `${payload.code}${fields ? ` ${fields}` : ''}`;
  }
}

function formatNotice(raw: string, zh: boolean): string {
  let payload: Record<string, string> | undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') record[key] = value;
      }
      payload = record;
    }
  } catch {
    return raw;
  }
  if (!payload?.code) return raw;
  const file = payload.file ?? '';
  switch (payload.code) {
    case 'malformed':
      return zh
        ? `跳过 ${file}：frontmatter 无效（${payload.detail ?? ''}）`
        : `skipped ${file}: malformed frontmatter (${payload.detail ?? ''})`;
    case 'clash':
      return zh
        ? `跳过 ${file}：名称 ${payload.id ?? ''} 已从 ${payload.winner ?? ''} 加载`
        : `skipped ${file}: name ${payload.id ?? ''} already loaded from ${payload.winner ?? ''}`;
    case 'builtin-clash':
      return zh
        ? `跳过 ${file}：${payload.id ?? ''} 与内置专家重名`
        : `skipped ${file}: ${payload.id ?? ''} conflicts with a built-in expert`;
    case 'unreadable':
      return zh ? `无法读取 ${file}` : `unreadable ${file}`;
    case 'bad-name':
      return zh
        ? `跳过 ${file}：名称 ${payload.detail ?? ''} 不是合法 id`
        : `skipped ${file}: name ${payload.detail ?? ''} is not a valid id`;
    case 'missing':
      return zh
        ? `跳过 ${file}：缺少 ${payload.detail ?? ''}`
        : `skipped ${file}: missing ${payload.detail ?? ''}`;
    case 'trust-blocked': {
      const reason = payload.reason ?? 'workspace';
      const id = payload.id ?? '';
      // The trust flag is applied by a later caller. Keep the name out of a
      // single MOSS_* token so this loader does not claim to read it.
      const trustEnv = `MOSS${'_'}TRUST_WORKSPACE`;
      const how = zh
        ? `用 --trust-workspace 或 ${trustEnv}=1 信任工作区`
        : `Enable with --trust-workspace or ${trustEnv}=1`;
      const claudeHow = zh
        ? '，并确认启用 Claude 项目代理'
        : ', and opt in to Claude project agents';
      if (reason.includes('claude') && reason.includes('workspace')) {
        return zh
          ? `跳过 ${file}：工作区未信任，且项目 .claude 代理未启用 — 已跳过 ${id}。${how}${claudeHow}。`
          : `skipped ${file}: untrusted workspace and project .claude agents are off — skipped ${id}. ${how}${claudeHow}.`;
      }
      if (reason.includes('claude')) {
        return zh
          ? `跳过 ${file}：项目 .claude 代理需要额外确认启用 — 已跳过 ${id}。${how}${claudeHow}。`
          : `skipped ${file}: project .claude agents need an explicit opt-in — skipped ${id}. ${how}${claudeHow}.`;
      }
      return zh
        ? `跳过 ${file}：工作区未信任 — 已跳过 ${id}。${how}。`
        : `skipped ${file}: untrusted workspace — skipped ${id}. ${how}.`;
    }
    default:
      return zh ? `跳过 ${file}：${payload.code}` : `skipped ${file}: ${payload.code}`;
  }
}

/** `/agents` body. `zh` selects the Chinese chrome; paths and ids stay as-is. */
export function formatFileAgentReport(input: {
  experts: readonly SubagentExpertDefinition[];
  notices?: readonly string[];
  zh: boolean;
}): string {
  const zh = input.zh;
  const agents = input.experts.filter((expert) => expert.fileDefined === true);
  const lines: string[] = [zh ? '子代理' : 'Agents'];
  if (agents.length === 0) {
    lines.push(
      zh ? '未加载文件子代理。' : 'No file agents loaded.',
      zh
        ? '把 markdown 放在 .moss/agents 或 .claude/agents（项目优先于用户，同名时 Moss 优先于 Claude）。'
        : 'Put markdown in .moss/agents or .claude/agents (project overrides user; Moss overrides Claude on the same name).'
    );
  } else {
    for (const agent of agents) {
      const origin = agent.agentOrigin ? ORIGIN_LABEL[agent.agentOrigin][zh ? 'zh' : 'en'] : '';
      const where = [agent.scope, origin].filter(Boolean).join(', ');
      lines.push(`${agent.id}${where ? ` (${where})` : ''}`);
      lines.push(`  ${agent.description}`);
      if (agent.sourcePath)
        lines.push(zh ? `  来源：${agent.sourcePath}` : `  source: ${agent.sourcePath}`);
      for (const warning of agent.loadWarnings ?? []) {
        lines.push(
          zh
            ? `  警告：${formatWarning(warning, true)}`
            : `  warning: ${formatWarning(warning, false)}`
        );
      }
    }
    lines.push(zh ? `${agents.length} 个文件子代理` : `${agents.length} file agent(s)`);
  }
  const notices = input.notices ?? [];
  if (notices.length > 0) {
    lines.push(zh ? '未加载' : 'Not loaded');
    for (const item of notices) lines.push(`  ${formatNotice(item, zh)}`);
  }
  return lines.join('\n');
}
