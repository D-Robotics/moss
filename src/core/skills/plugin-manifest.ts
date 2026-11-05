/**
 * D1 capability packs (plugin-lite): an RDK capability is a skill + a slash
 * command + a sub-agent + a hook + an MCP server. Installing five directories by
 * hand is unversioned and untestable, so a pack declares its components once in
 * `plugin.json` and `moss plugins install` copies them into the workspace.
 *
 * What this is NOT: a registry or marketplace. Packs are local directories
 * (a git clone is a valid pack); there is no download, no search, no publishing.
 * The manifest is deliberately small and every component path is validated to
 * stay inside the pack root.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './skill-parse.js';

export interface PluginManifest {
  /** Stable pack id; also the install directory name. */
  name: string;
  version: string;
  description?: string;
  /** Directories (relative to the pack root) whose skill folders to install. */
  skills?: string[];
  /** Directories of `.md` slash-command files. */
  commands?: string[];
  /** Directories of `.md` sub-agent files. */
  agents?: string[];
  /** JSON file: `{ "<Event>": [ { command, matcher? }, ... ] }`. */
  hooks?: string;
  /** JSON file: `{ "mcpServers": { "<name>": {...} } }`. */
  mcp?: string;
}

export interface PluginFile {
  /** Path relative to the pack root. */
  from: string;
  /** Path relative to the workspace root. */
  to: string;
  sha256: string;
}

export interface HookEntry {
  event: string;
  hook: Record<string, unknown>;
}

export interface PluginValidation {
  root: string;
  manifest?: PluginManifest;
  errors: string[];
  warnings: string[];
  files: PluginFile[];
  hooks: HookEntry[];
  mcpServers: Record<string, unknown>;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const COMPONENT_KEYS = ['skills', 'commands', 'agents', 'hooks', 'mcp'] as const;

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function relativeInside(root: string, candidate: string): string | undefined {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative;
}

function listMarkdown(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.md') && !name.startsWith('.'))
    .sort()
    .map((name) => path.join(dir, name));
}

function readJsonFile(file: string): { value?: unknown; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: 'cannot be read' };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { error: 'is not valid JSON' };
  }
}

function walkTree(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) out.push(absolute);
    }
  };
  visit(dir);
  return out;
}

/** A skill folder is valid when it has a SKILL.md with a name and description. */
function validateSkillDir(dir: string, root: string, validation: PluginValidation): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const parsed = parseFrontmatter(fs.readFileSync(skillFile, 'utf8'));
    if (!parsed.fields.name || !parsed.fields.description) {
      validation.errors.push(
        `${path.relative(root, skillFile)}: SKILL.md needs frontmatter name and description`
      );
      continue;
    }
    // Record the whole skill tree (references/scripts/assets), not just
    // SKILL.md — an installed pack would be incomplete without them.
    for (const file of walkTree(path.join(dir, entry.name))) {
      validation.files.push({
        from: path.relative(root, file),
        to: path.join(
          '.moss',
          'skills',
          entry.name,
          path.relative(path.join(dir, entry.name), file)
        ),
        sha256: sha256File(file),
      });
    }
  }
}

/**
 * Read and validate a pack directory. Never throws: a broken pack is a list of
 * errors so `moss plugins validate` can report every problem at once.
 */
export function validatePlugin(root: string): PluginValidation {
  const validation: PluginValidation = {
    root: path.resolve(root),
    errors: [],
    warnings: [],
    files: [],
    hooks: [],
    mcpServers: {},
  };
  const base = validation.root;
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    validation.errors.push(`not a directory: ${base}`);
    return validation;
  }
  const manifestFile = path.join(base, 'plugin.json');
  const read = readJsonFile(manifestFile);
  if (read.error) {
    validation.errors.push(`plugin.json ${read.error}`);
    return validation;
  }
  const raw = read.value;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    validation.errors.push('plugin.json must be a JSON object');
    return validation;
  }
  const record = raw as Record<string, unknown>;
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  if (!NAME_RE.test(name)) {
    validation.errors.push('name must be lowercase letters/digits/._- (max 64 chars)');
  }
  const version = typeof record.version === 'string' ? record.version.trim() : '';
  if (!VERSION_RE.test(version)) {
    validation.errors.push('version must be semver, e.g. 0.1.0');
  }
  const description =
    typeof record.description === 'string' ? record.description.trim() : undefined;
  if (description && description.length > 200) {
    validation.warnings.push('description is longer than 200 characters');
  }
  const manifest: PluginManifest = {
    name,
    version,
    ...(description ? { description } : {}),
  };
  let componentCount = 0;
  for (const key of COMPONENT_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    componentCount += 1;
    if (key === 'skills' || key === 'commands' || key === 'agents') {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        validation.errors.push(`${key} must be an array of relative directories`);
        continue;
      }
      const dirs: string[] = [];
      for (const entry of value as string[]) {
        const relative = relativeInside(base, entry);
        if (relative === undefined) {
          validation.errors.push(`${key} entry escapes the pack root: ${entry}`);
          continue;
        }
        const dir = path.resolve(base, entry);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
          validation.errors.push(`${key} directory does not exist: ${entry}`);
          continue;
        }
        dirs.push(entry);
        if (key === 'skills') validateSkillDir(dir, base, validation);
        if (key === 'commands' || key === 'agents') {
          const files = listMarkdown(dir);
          if (files.length === 0) validation.warnings.push(`${entry} has no .md files`);
          for (const file of files) {
            validation.files.push({
              from: path.relative(base, file),
              to:
                key === 'commands'
                  ? path.join('.moss', 'commands', path.basename(file))
                  : path.join('.moss', 'agents', path.basename(file)),
              sha256: sha256File(file),
            });
          }
        }
      }
      manifest[key] = dirs;
      continue;
    }
    // hooks / mcp: a single JSON file path.
    if (typeof value !== 'string') {
      validation.errors.push(`${key} must be a path to a JSON file`);
      continue;
    }
    const relative = relativeInside(base, value);
    if (relative === undefined) {
      validation.errors.push(`${key} path escapes the pack root: ${value}`);
      continue;
    }
    const file = path.resolve(base, value);
    if (!fs.existsSync(file)) {
      validation.errors.push(`${key} file does not exist: ${value}`);
      continue;
    }
    const parsed = readJsonFile(file);
    if (parsed.error) {
      validation.errors.push(`${value} ${parsed.error}`);
      continue;
    }
    if (key === 'hooks') {
      const hooks = parsed.value;
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
        validation.errors.push(`${value} must be an object of event → hook list`);
        continue;
      }
      for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
        if (!Array.isArray(list)) {
          validation.errors.push(`${value}: ${event} must be an array`);
          continue;
        }
        for (const hook of list) {
          if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
            validation.errors.push(`${value}: ${event} entries must be objects`);
            continue;
          }
          validation.hooks.push({ event, hook: hook as Record<string, unknown> });
        }
      }
      manifest.hooks = value;
    } else {
      const parsedMcp = parsed.value;
      const servers =
        parsedMcp && typeof parsedMcp === 'object' && !Array.isArray(parsedMcp)
          ? ((parsedMcp as { mcpServers?: unknown }).mcpServers ?? parsedMcp)
          : undefined;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        validation.errors.push(`${value} must be {"mcpServers": {...}} or a server map`);
        continue;
      }
      validation.mcpServers = { ...(servers as Record<string, unknown>) };
      manifest.mcp = value;
    }
  }
  if (componentCount === 0) {
    validation.errors.push('a pack must declare at least one of skills/commands/agents/hooks/mcp');
  }
  validation.manifest = manifest;
  return validation;
}

/** Compact one-line summary for `moss plugins list` / validate. */
export function describePlugin(manifest: PluginManifest): string {
  const parts = [
    `skills=${String(manifest.skills?.length ?? 0)}`,
    `commands=${String(manifest.commands?.length ?? 0)}`,
    `agents=${String(manifest.agents?.length ?? 0)}`,
    `hooks=${manifest.hooks ? 'yes' : 'no'}`,
    `mcp=${manifest.mcp ? 'yes' : 'no'}`,
  ];
  return parts.join(' ');
}
