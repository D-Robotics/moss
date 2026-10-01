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
  /** Absolute path of the SKILL.md body. */
  file: string;
}

export interface ParsedSkillFile {
  frontmatter: Record<string, string>;
  body: string;
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

function readSkillsFromDir(dir: string): SkillManifest[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseSkillFile(fs.readFileSync(file, 'utf8'));
      const name = parsed.frontmatter.name ?? entry.name;
      const description = parsed.frontmatter.description ?? '';
      if (!description) continue; // an undescribed skill cannot be discovered
      skills.push({
        name,
        description,
        ...(parsed.frontmatter.when ? { when: parsed.frontmatter.when } : {}),
        file,
      });
    } catch {
      /* unreadable skill files are skipped */
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Load skills from directories, earlier dirs winning on name collisions
 * (workspace before user config).
 */
export function loadSkills(dirs: readonly string[]): SkillManifest[] {
  const byName = new Map<string, SkillManifest>();
  for (const dir of dirs) {
    for (const skill of readSkillsFromDir(dir)) {
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
