/**
 * Lightweight skills (v0.16-S3): SKILL.md files with YAML-ish frontmatter
 * (name / description / when) discovered from `.moss/skills/` (workspace) and
 * `<configDir>/skills/` (user). Progressive disclosure: only the index line
 * (name + description) enters the system prompt; the full body is loaded on
 * demand through the readonly `skill` tool.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SkillManifest {
  name: string;
  description: string;
  /** Optional hint for when the model should pick this skill. */
  when?: string;
  /** Absolute path of the SKILL.md body. Bundled skills may use a sentinel plus `body`. */
  file: string;
  /** Inline body. When set, the skill tool does not read `file`. */
  body?: string;
}

export interface ParsedSkillFile {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Skill and slash-command names. Letters and digits from any script, then
 * `.` `_` `:` `-`. A value that is entirely a `{{…}}` placeholder is not a name.
 */
export const CATALOG_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u;

export type SkillSkipReason = 'placeholder' | 'empty' | 'invalid-name' | 'hidden-dir';

export interface SkillSkip {
  file: string;
  reason: SkillSkipReason;
}

export interface LoadSkillsOptions {
  /** Called once per rejected SKILL.md. The caller shows one session notice. */
  onSkip?: (skip: SkillSkip) => void;
}

/**
 * True when the whole value is one unfilled `{{…}}` placeholder.
 * A description that merely mentions `{{var}}` is real text.
 */
const ENTIRE_TEMPLATE_PLACEHOLDER_RE = /^\{\{[^{}]+\}\}$/;

export function containsTemplatePlaceholder(value: string): boolean {
  return ENTIRE_TEMPLATE_PLACEHOLDER_RE.test(value.trim());
}

/**
 * Slash alias for a skill name. The catalog keeps the original name (`My Skill`,
 * `c++-helper`); `/` commands cannot contain a space, so the slash surface uses
 * this form. A name that is still illegal after the collapse gets no `/` command.
 */
export function skillSlashName(name: string): string {
  return name.trim().replace(/\s+/g, '-');
}

/**
 * Why this name/description must not be registered, or undefined when it is a
 * real skill. Placeholder wins over the name pattern so `{{name}}` is reported
 * as an unfilled template, not as a generic bad name.
 */
export function skillSkipReason(name: string, description: string): SkillSkipReason | undefined {
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  if (!trimmedName || !trimmedDescription) return 'empty';
  if (containsTemplatePlaceholder(trimmedName) || containsTemplatePlaceholder(trimmedDescription)) {
    return 'placeholder';
  }
  if (!CATALOG_NAME_RE.test(trimmedName)) return 'invalid-name';
  return undefined;
}

export function parseSkillFile(text: string): ParsedSkillFile {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return { frontmatter: {}, body: normalized };
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: normalized };
  const header = normalized.slice(3, end).trim();
  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  const frontmatter: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body };
}

/** `_template` and `.hidden` are authoring scratch, not installed skills. */
function isHiddenSkillFolder(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.');
}

function readSkillManifest(
  file: string,
  fallbackName: string,
  onSkip?: (skip: SkillSkip) => void
): SkillManifest | undefined {
  let parsed: ParsedSkillFile;
  try {
    parsed = parseSkillFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const name = (parsed.frontmatter.name ?? fallbackName).trim();
  const description = (parsed.frontmatter.description ?? '').trim();
  const reason = skillSkipReason(name, description);
  // `invalid-name` stays in the catalog and the skill tool. Only the slash
  // surface refuses it, and only when the alias is still not a command name.
  if (reason && reason !== 'invalid-name') {
    onSkip?.({ file, reason });
    return undefined;
  }
  return {
    name,
    description,
    ...(parsed.frontmatter.when ? { when: parsed.frontmatter.when } : {}),
    file,
  };
}

function readSkillsFromDir(dir: string, onSkip?: (skip: SkillSkip) => void): SkillManifest[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    const file = path.join(child, 'SKILL.md');
    // One level only, as main does. A SKILL.md under reference/ or templates/
    // belongs to the skill that contains it and is not another skill.
    // `_template` and dot folders are scratch even after the frontmatter is filled in.
    if (isHiddenSkillFolder(entry.name)) {
      if (fs.existsSync(file)) onSkip?.({ file, reason: 'hidden-dir' });
      continue;
    }
    if (!fs.existsSync(file)) continue;
    const skill = readSkillManifest(file, entry.name, onSkip);
    if (skill) skills.push(skill);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Load skills from directories, earlier dirs winning on name collisions
 * (workspace before user config). One level of folders only. Unfilled
 * templates and folders named `_…` or `.…` are not registered; `onSkip`
 * names each rejected file once.
 */
export function loadSkills(
  dirs: readonly string[],
  options: LoadSkillsOptions = {}
): SkillManifest[] {
  const byName = new Map<string, SkillManifest>();
  const announced = new Set<string>();
  const onSkip = options.onSkip
    ? (skip: SkillSkip) => {
        if (announced.has(skip.file)) return;
        announced.add(skip.file);
        options.onSkip?.(skip);
      }
    : undefined;
  for (const dir of dirs) {
    for (const skill of readSkillsFromDir(dir, onSkip)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()];
}

/**
 * Progressive-disclosure index layer for the system prompt. Budget: one line
 * per skill, ~40 tokens each — the body stays out until the skill tool loads
 * it.
 */
export function buildSkillsPromptLayer(skills: readonly SkillManifest[]): string | undefined {
  if (skills.length === 0) return undefined;
  const lines = [
    '## Available skills',
    'Load a skill body on demand with the `skill` tool (input: {"name": "..."}).',
  ];
  for (const s of skills) {
    lines.push(`- ${s.name}: ${s.description}${s.when ? ` (when: ${s.when})` : ''}`);
  }
  return lines.join('\n');
}

/**
 * Prompt layer for the no-skills case: anchors the model to Moss's own skill
 * directories so it answers skill questions from config instead of shelling
 * out to scan other tools' skill folders (~/.claude/skills, ~/.codex/skills).
 */
export function buildEmptySkillsHintLayer(dirs: readonly string[]): string {
  return [
    '## Available skills',
    'No skills installed. Moss discovers skills only from:',
    ...dirs.map((dir) => `- ${path.join(dir, '<name>', 'SKILL.md')}`),
    "Answer skill questions from this list; other tools' skill folders (e.g. ~/.claude/skills) are not loaded by Moss.",
  ].join('\n');
}

export function findSkill(
  skills: readonly SkillManifest[],
  name: string
): SkillManifest | undefined {
  return skills.find((s) => s.name === name);
}
