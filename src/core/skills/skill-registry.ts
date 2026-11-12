/**
 * Skill discovery and parsing (Agent Skills format).
 *
 * Skills live in `<scope>/skills/<name>/SKILL.md`; the body and the optional
 * `scripts/`, `references/`, `assets/` and `evals/` directories stay out of the
 * prompt. Only the catalog line (name + description) enters the prompt, and the
 * model loads the body through the `skill` tool.
 *
 * Discovery is explicit about scope: workspace (`.moss/skills`), shared
 * (`.agents/skills`, the cross-client convention), user (`<configDir>/skills`),
 * and bundled. Earlier scopes win on name collisions; the loser is reported
 * instead of vanishing silently.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import micromatch from 'micromatch';
import {
  SKILL_BODY_MAX_BYTES,
  SKILL_DESCRIPTION_MAX_CHARS,
  SKILL_NAME_MAX_CHARS,
  SKILL_RESOURCE_MAX_FILES,
  SKILL_SPEC_NAME_RE,
  type SkillIssue,
  type SkillManifest,
  type SkillResources,
  type SkillScope,
} from '../../contracts/skill.js';
import { renderSkillCatalog } from './skill-catalog.js';
import { asString, asStringList, parseFrontmatter } from './skill-parse.js';
import { loadSkillEvals } from './skill-evals.js';

export type {
  SkillManifest,
  SkillIssue,
  SkillScope,
  SkillResources,
} from '../../contracts/skill.js';

export interface ParsedSkillFile {
  frontmatter: Record<string, string>;
  body: string;
}

/** Spec-conforming name: lowercase letters/digits, hyphen-separated, ≤64. */
export function isSpecSkillName(name: string): boolean {
  return name.length <= SKILL_NAME_MAX_CHARS && SKILL_SPEC_NAME_RE.test(name);
}

/** Legacy catalog-name rule kept for rule files and backwards compatibility. */
export const CATALOG_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u;

export type SkillSkipReason = 'placeholder' | 'empty' | 'invalid-name' | 'hidden-dir';

export interface SkillSkip {
  file: string;
  reason: SkillSkipReason;
  /** Human explanation when the reason alone is vague (`empty`). */
  detail?: string;
}

/**
 * B289: one discovery order for every surface (runtime, `/skills`,
 * `moss skill list`, `moss skill validate`, `moss capabilities`). Each of them
 * used to spell its own list, so `/capabilities` reported 0 skills while the
 * first screen said 19 (the `.claude`/`.agents` conventions were missing there).
 */
export function defaultSkillDirSpecs(workspaceDir: string, configDir: string): SkillDir[] {
  return [
    { dir: path.join(workspaceDir, '.moss', 'skills'), scope: 'workspace' },
    { dir: path.join(workspaceDir, '.agents', 'skills'), scope: 'shared' },
    { dir: path.join(workspaceDir, '.claude', 'skills'), scope: 'shared' },
    { dir: path.join(configDir, 'skills'), scope: 'user' },
    { dir: path.join(os.homedir(), '.claude', 'skills'), scope: 'user' },
  ];
}

export interface SkillDir {
  dir: string;
  scope: SkillScope;
}

export interface LoadSkillsOptions {
  /** Called once per rejected SKILL.md. The caller shows one session notice. */
  onSkip?: (skip: SkillSkip) => void;
  /** Non-fatal problems (legacy name, over-long description, duplicates, resources). */
  onIssue?: (issue: SkillIssue) => void;
}

/** True when the whole value is one unfilled `{{…}}` placeholder. */
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

/** Why this name/description must not be registered at all (fatal), or undefined. */
export function skillSkipReason(name: string, description: string): SkillSkipReason | undefined {
  const trimmedName = name.trim();
  const trimmedDescription = description.trim();
  if (!trimmedName || !trimmedDescription) return 'empty';
  if (containsTemplatePlaceholder(trimmedName) || containsTemplatePlaceholder(trimmedDescription)) {
    return 'placeholder';
  }
  // Spec names are validated separately (legacy names are still loaded with an
  // issue); only names that cannot even be addressed in the catalog are fatal.
  if (!CATALOG_NAME_RE.test(trimmedName) && !isSpecSkillName(trimmedName)) return 'invalid-name';
  return undefined;
}

/** Backwards-compatible flat frontmatter view (rules, slash commands). */
export function parseSkillFile(text: string): ParsedSkillFile {
  const parsed = parseFrontmatter(text);
  return { frontmatter: parsed.flat, body: parsed.body };
}

/** `_template` and `.hidden` are authoring scratch, not installed skills. */
function isHiddenSkillFolder(name: string): boolean {
  return name.startsWith('_') || name.startsWith('.');
}

function withinLimit(file: string, maxBytes: number): boolean {
  try {
    return fs.statSync(file).size <= maxBytes;
  } catch {
    return false;
  }
}

/** List files under one optional resource directory, relative and sorted. */
function listResourceDir(skillDir: string, sub: string): string[] {
  const root = path.join(skillDir, sub);
  try {
    fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (out.length >= SKILL_RESOURCE_MAX_FILES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= SKILL_RESOURCE_MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        out.push(relative);
      }
    }
  };
  walk(root, '');
  return out;
}

export function scanSkillResources(skillDir: string): SkillResources {
  const resources: SkillResources = {
    references: listResourceDir(skillDir, 'references'),
    scripts: listResourceDir(skillDir, 'scripts'),
    assets: listResourceDir(skillDir, 'assets'),
    evals: fs.existsSync(path.join(skillDir, 'evals', 'evals.json')),
  };
  return resources;
}

export interface ParsedSkillManifest {
  manifest?: SkillManifest;
  skip?: SkillSkip;
  issues: SkillIssue[];
}

/** Parse one SKILL.md into a manifest, applying the spec limits. */
export function readSkillManifest(
  file: string,
  fallbackName: string,
  scope: SkillScope
): ParsedSkillManifest {
  const issues: SkillIssue[] = [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { skip: { file, reason: 'empty' }, issues };
  }
  const parsed = parseFrontmatter(raw);
  for (const issue of parsed.issues) {
    issues.push({ code: issue.code, message: issue.message, file });
  }
  if (Object.keys(parsed.fields).length === 0) {
    issues.push({
      code: 'missing-frontmatter',
      message: 'SKILL.md has no frontmatter; skill needs at least name and description',
      file,
    });
  }
  const name = (asString(parsed.fields.name) ?? fallbackName).trim();
  let description = (asString(parsed.fields.description) ?? '').trim();
  const reason = skillSkipReason(name, description);
  if (reason && reason !== 'invalid-name') {
    // B303: `reason: empty` alone told the author nothing; say which required
    // frontmatter field is missing.
    const missing: string[] = [];
    if (!name) missing.push('"name"');
    if (!description) missing.push('"description"');
    const detail =
      reason === 'empty' && missing.length > 0
        ? `frontmatter needs a non-empty ${missing.join(' and ')}`
        : undefined;
    return { skip: { file, reason, ...(detail ? { detail } : {}) }, issues };
  }
  if (!isSpecSkillName(name)) {
    issues.push({
      code: 'legacy-name',
      message: `name "${name}" does not match the spec (lowercase letters/digits, hyphen-separated, ≤${SKILL_NAME_MAX_CHARS}); it stays loadable but is not portable`,
      file,
    });
  }
  if (description.length > SKILL_DESCRIPTION_MAX_CHARS) {
    issues.push({
      code: 'description-too-long',
      message: `description is ${description.length} chars (spec max ${SKILL_DESCRIPTION_MAX_CHARS}); truncated in the catalog`,
      file,
    });
    description = description.slice(0, SKILL_DESCRIPTION_MAX_CHARS);
  }
  const body = parsed.body;
  if (Buffer.byteLength(body, 'utf8') > SKILL_BODY_MAX_BYTES) {
    issues.push({
      code: 'body-too-long',
      message: `SKILL.md body is over ${SKILL_BODY_MAX_BYTES} bytes; the skill tool will truncate it`,
      file,
    });
  }
  const dir = path.dirname(file);
  const resources = scanSkillResources(dir);
  for (const issue of loadSkillEvals(dir).issues) issues.push(issue);
  const metadataField = parsed.fields.metadata;
  const metadata: Record<string, string> =
    metadataField && typeof metadataField === 'object' && !Array.isArray(metadataField)
      ? metadataField
      : {};
  for (const sub of ['scripts', 'references', 'assets'] as const) {
    for (const relative of resources[sub]) {
      const absolute = path.join(dir, sub, relative);
      if (!withinLimit(absolute, 1024 * 1024)) {
        issues.push({
          code: 'resource-oversize',
          message: `${sub}/${relative} exceeds 1 MiB and will not be offered to the model`,
          file,
        });
      }
    }
  }
  // Spec spelling `when_to_use` (Claude) and Moss's original `when` both work.
  const when = (asString(parsed.fields.when) ?? asString(parsed.fields['when_to_use']))?.trim();
  const version = asString(parsed.fields.version) ?? metadata.version;
  const license = asString(parsed.fields.license);
  const compatibility = asString(parsed.fields.compatibility);
  const allowedTools = asStringList(parsed.fields['allowed-tools']);
  const disallowedTools = asStringList(parsed.fields['disallowed-tools']);
  // Spec `disable-model-invocation: true` (any case, YAML 1.1 booleans): the
  // skill stays user-invocable through its slash command but leaves the model's
  // catalog, so a deploy/release procedure cannot be auto-selected.
  const rawDisable = asString(parsed.fields['disable-model-invocation']);
  let modelInvocable = true;
  if (rawDisable !== undefined) {
    const normalized = rawDisable.trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(normalized)) modelInvocable = false;
    else if (['false', 'no', 'off', '0'].includes(normalized)) modelInvocable = true;
    else {
      issues.push({
        code: 'unknown-disable-model-invocation',
        file,
        message: `disable-model-invocation "${rawDisable}" is not a boolean; the skill stays model-invocable`,
      });
    }
  }
  // D11: `context: fork` runs the body in an isolated sub-agent; anything else
  // is a configuration issue instead of silently running inline.
  const rawContext = asString(parsed.fields['context']);
  const context = rawContext === 'fork' ? ('fork' as const) : undefined;
  if (rawContext !== undefined && context === undefined) {
    issues.push({
      code: 'unknown-context',
      file,
      message: `context "${rawContext}" is not supported (only "fork"); the skill runs inline`,
    });
  }
  // D11: `background: true` starts the body as a background sub-agent task.
  const rawBackground = asString(parsed.fields['background']);
  const background =
    rawBackground === undefined ? undefined : rawBackground.trim().toLowerCase() === 'true';
  if (
    rawBackground !== undefined &&
    rawBackground.trim().toLowerCase() !== 'true' &&
    rawBackground.trim().toLowerCase() !== 'false'
  ) {
    issues.push({
      code: 'unknown-background',
      file,
      message: `background "${rawBackground}" is not true/false; the skill runs inline`,
    });
  }
  const model = asString(parsed.fields['model']);
  const rawEffort = asString(parsed.fields['effort']);
  const effort =
    rawEffort === 'low' || rawEffort === 'medium' || rawEffort === 'high' ? rawEffort : undefined;
  if (rawEffort !== undefined && effort === undefined) {
    issues.push({
      code: 'unknown-effort',
      file,
      message: `effort "${rawEffort}" is not low/medium/high; ignored`,
    });
  }
  const globs = asStringList(parsed.fields.globs);
  // D11: `hooks: hooks.json` — a skill-owned hook file next to SKILL.md. The
  // path must stay inside the skill dir so a downloaded skill cannot point the
  // hook runner at an arbitrary file.
  const rawHooks = asString(parsed.fields['hooks'])?.trim();
  let hooks: string | undefined;
  if (rawHooks !== undefined) {
    const normalized = rawHooks.replace(/\\/g, '/');
    const escapes =
      normalized.length === 0 || path.isAbsolute(rawHooks) || normalized.split('/').includes('..');
    if (escapes) {
      issues.push({
        code: 'unsafe-hooks-path',
        file,
        message: `hooks "${rawHooks}" must be a relative path inside the skill directory; ignored`,
      });
    } else {
      hooks = normalized;
    }
  }
  return {
    issues,
    manifest: {
      name,
      description,
      ...(when ? { when } : {}),
      ...(version ? { version } : {}),
      ...(license ? { license } : {}),
      ...(compatibility ? { compatibility } : {}),
      allowedTools,
      disallowedTools,
      modelInvocable,
      ...(context ? { context } : {}),
      ...(background === true ? { background: true } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(hooks ? { hooks } : {}),
      metadata,
      globs,
      scope,
      dir,
      file,
      resources,
      issues,
      legacy: !isSpecSkillName(name),
    },
  };
}

function readSkillsFromDir(
  dir: string,
  scope: SkillScope,
  options: LoadSkillsOptions
): SkillManifest[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillManifest[] = [];
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    // Dotfile managers and shared skill packs usually symlink skill folders
    // into ~/.claude/skills; treat a symlink to a directory as a skill folder.
    // Only one level is walked, so a self-referential link cannot recurse.
    let isDirectory = entry.isDirectory();
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = fs.statSync(child).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (!isDirectory) continue;
    const file = path.join(child, 'SKILL.md');
    // One level only: a SKILL.md under references/ belongs to its parent skill.
    if (isHiddenSkillFolder(entry.name)) {
      if (fs.existsSync(file)) options.onSkip?.({ file, reason: 'hidden-dir' });
      continue;
    }
    if (!fs.existsSync(file)) continue;
    const parsed = readSkillManifest(file, entry.name, scope);
    for (const issue of parsed.issues) options.onIssue?.(issue);
    if (parsed.skip) {
      options.onSkip?.(parsed.skip);
      continue;
    }
    if (parsed.manifest) skills.push(parsed.manifest);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/**
 * Load skills from scoped directories. Earlier entries win on name collisions;
 * the loser is reported as a `duplicate-name` issue on its own manifest.
 */
export function loadSkillCatalog(
  dirs: readonly SkillDir[],
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
  const withSkip = { ...options, ...(onSkip ? { onSkip } : {}) };
  for (const { dir, scope } of dirs) {
    for (const skill of readSkillsFromDir(dir, scope, withSkip)) {
      const existing = byName.get(skill.name);
      if (!existing) {
        byName.set(skill.name, skill);
        continue;
      }
      const issue: SkillIssue = {
        code: 'duplicate-name',
        message: `skill "${skill.name}" (${scope}, ${skill.file}) is shadowed by the ${existing.scope} skill; rename one of them`,
        file: existing.file,
      };
      existing.issues.push(issue);
      options.onIssue?.(issue);
    }
  }
  return [...byName.values()];
}

/** Backwards-compatible loader for plain directory lists. */
export function loadSkills(
  dirs: readonly string[],
  options: LoadSkillsOptions = {}
): SkillManifest[] {
  return loadSkillCatalog(
    dirs.map((dir) => ({
      dir,
      scope: dir.includes(`${path.sep}.agents${path.sep}`) ? 'shared' : 'user',
    })),
    options
  );
}

/**
 * Which skills belong in the catalog for the paths this run has touched.
 * `globs` is deterministic activation (path evidence from a tool call or the
 * user message), not a guess: a skill without globs is always listed.
 */
export function selectActiveSkills(
  skills: readonly SkillManifest[],
  relativePaths: readonly string[]
): SkillManifest[] {
  if (relativePaths.length === 0) return skills.filter((skill) => skill.globs.length === 0);
  return skills.filter(
    (skill) =>
      skill.globs.length === 0 ||
      relativePaths.some((file) =>
        micromatch.isMatch(file, skill.globs as string[], { dot: true, nocase: true })
      )
  );
}

export function findSkill(
  skills: readonly SkillManifest[],
  name: string
): SkillManifest | undefined {
  return skills.find((s) => s.name === name);
}

/** Compatibility wrapper: renders the catalog with the default budget. */
export function buildSkillsPromptLayer(skills: readonly SkillManifest[]): string | undefined {
  return renderSkillCatalog(skills).text;
}

/** Prompt layer for the no-skills case: anchors the model to Moss's own directories. */
export function buildEmptySkillsHintLayer(dirs: readonly string[]): string {
  return [
    '## Available skills',
    'No skills installed. Moss discovers skills only from:',
    ...dirs.map((dir) => `- ${path.join(dir, '<name>', 'SKILL.md')}`),
    'This includes the cross-client .agents/skills and .claude/skills folders.',
  ].join('\n');
}
