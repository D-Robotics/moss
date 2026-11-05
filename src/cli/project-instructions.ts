import fs from 'node:fs';
import path from 'node:path';
import micromatch from 'micromatch';
import { parseSkillFile } from '../core/skills/skill-registry.js';

/**
 * Project instructions — the workspace-level system prompt layer.
 *
 * The CLI has advertised auto-loaded project instructions since v0.14. This
 * module loads `AGENTS.md` / `CLAUDE.md` from the workspace, its ancestor
 * directories up to the repository root (the nearest `.git` marker), and the
 * user-level config directory (`<configDir>/AGENTS.md`). Layering matches how
 * Cursor and Claude Code treat instructions as a memory file: user-wide
 * preferences at the bottom, repo-wide conventions above them, directory
 * specifics closest to the code. Loaded once per process at agent init, after
 * the environment layer and before the runtime capability layers, so every turn
 * (chat, /task, sub-agents inheriting the parent prompt) sees the project's
 * build/test commands, layout and conventions.
 */

/** Per-file cap: a project file beyond this is truncated with an explicit notice. */
export const PROJECT_INSTRUCTION_MAX_FILE_BYTES = 32 * 1024;
/** Total cap across every loaded project instruction file. */
export const PROJECT_INSTRUCTION_MAX_TOTAL_BYTES = 48 * 1024;
/** Back-compat alias for the single-file cap's previous name. */
export const AGENTS_MD_MAX_BYTES = PROJECT_INSTRUCTION_MAX_FILE_BYTES;

/** Candidate file names in priority order; one file per directory is loaded. */
const CANDIDATES = ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'claude.md'] as const;

/** Walk at most this many ancestors looking for the repository root. */
const MAX_ANCESTOR_DEPTH = 12;

export interface ProjectInstructionOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  /**
   * User-level instruction directory (the CLI config dir, e.g. `~/.moss`). Its
   * `AGENTS.md`/`CLAUDE.md` applies to every workspace and is rendered first so
   * project files override it. Skipped when it equals the workspace.
   */
  userDir?: string;
}

interface LoadedInstruction {
  file: string;
  dir: string;
  label: string;
  text: string;
  truncated: boolean;
  droppedKb: number;
}

/** The first candidate instruction file present in `dir`, if any. */
export function findAgentsMdPath(dir: string): string | undefined {
  for (const name of CANDIDATES) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not present — try the next spelling
    }
  }
  return undefined;
}

/** The nearest directory at or above `start` that contains a `.git` marker. */
export function findRepositoryRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch {
      // unreadable directory — keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * Directories whose instruction files apply, outermost first: the repository
 * root (when one is found) down to the workspace itself. Without a repository
 * marker only the workspace is used, so a stray `$HOME/AGENTS.md` is never
 * injected into an unrelated project.
 */
export function collectInstructionDirs(workspaceDir: string): string[] {
  const workspace = path.resolve(workspaceDir);
  const repoRoot = findRepositoryRoot(workspace);
  if (!repoRoot) return [workspace];
  const chain: string[] = [];
  let dir = workspace;
  for (let depth = 0; depth <= MAX_ANCESTOR_DEPTH; depth += 1) {
    chain.push(dir);
    if (dir === repoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return chain.reverse();
}

function labelFor(dir: string, workspace: string): string {
  if (dir === workspace) return 'workspace';
  const rel = path.relative(dir, workspace).split(path.sep).join('/');
  return rel ? `ancestor:${rel}` : 'ancestor';
}

function readInstructionFile(
  file: string,
  maxFileBytes: number
): { text: string; truncated: boolean; droppedKb: number } | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (bytes <= maxFileBytes) return { text: trimmed, truncated: false, droppedKb: 0 };
  const kept = Buffer.from(trimmed, 'utf8').subarray(0, maxFileBytes).toString('utf8');
  // A cut can land mid-code-unit: drop the trailing replacement char it would
  // produce rather than shipping a broken glyph into the prompt.
  const safe = kept.endsWith('\ufffd') ? kept.slice(0, -1) : kept;
  return {
    text: safe,
    truncated: true,
    droppedKb: Math.round((bytes - maxFileBytes) / 1024),
  };
}

/**
 * The prompt layer for the workspace's project instructions, or '' when there
 * are none. Oversized files are cut at the byte cap with a visible notice —
 * silent truncation would let the model assume it saw conventions it did not.
 */
export function buildAgentsMdLayer(
  workspaceDir: string,
  options: ProjectInstructionOptions = {}
): string {
  const maxFileBytes = options.maxFileBytes ?? PROJECT_INSTRUCTION_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? PROJECT_INSTRUCTION_MAX_TOTAL_BYTES;
  const workspace = path.resolve(workspaceDir);
  const dirs = collectInstructionDirs(workspace);
  const userDir = options.userDir ? path.resolve(options.userDir) : undefined;
  // User-level instructions sit below every project file: they are loaded last
  // (lowest budget priority) and rendered first (lowest precedence).
  const userLayer =
    userDir && userDir !== workspace && !dirs.includes(userDir) ? userDir : undefined;
  // Budget is spent from the most specific directory outward so workspace
  // instructions are never dropped in favour of a distant ancestor.
  const loaded: LoadedInstruction[] = [];
  let totalBytes = 0;
  let skipped = 0;
  const budgetOrder = [...dirs].reverse();
  if (userLayer) budgetOrder.push(userLayer);
  for (const dir of budgetOrder) {
    const file = findAgentsMdPath(dir);
    if (!file) continue;
    const read = readInstructionFile(file, maxFileBytes);
    if (!read) continue;
    const bytes = Buffer.byteLength(read.text, 'utf8');
    if (totalBytes + bytes > maxTotalBytes) {
      skipped += 1;
      continue;
    }
    totalBytes += bytes;
    loaded.push({
      file,
      dir,
      label: dir === userLayer ? 'user' : labelFor(dir, workspace),
      text: read.text,
      truncated: read.truncated,
      droppedKb: read.droppedKb,
    });
  }
  if (loaded.length === 0) return '';
  // Render from the outermost directory inward: the most specific instructions
  // sit closest to the conversation tail.
  loaded.reverse();
  const capKb = Math.floor(maxFileBytes / 1024);
  const skippedNote =
    skipped > 0
      ? ` — ${skipped} file(s) skipped over the ${Math.floor(maxTotalBytes / 1024)}KB total cap`
      : '';
  if (loaded.length === 1) {
    const only = loaded[0]!;
    const label = only.label === 'workspace' ? '' : ` (${only.label})`;
    if (!only.truncated) {
      return `[Project instructions — ${path.basename(only.file)}${label}${skippedNote}]\n${only.text}`;
    }
    return (
      `[Project instructions — ${path.basename(only.file)}${label} (truncated, ~${only.droppedKb}KB dropped — ` +
      `edit the file under ${capKb}KB to load it fully)${skippedNote}]\n${only.text}`
    );
  }
  const names = loaded.map((entry) => `${path.basename(entry.file)} (${entry.label})`).join(', ');
  const sections = loaded.map((entry) => {
    const suffix = entry.truncated ? ` [truncated, ~${entry.droppedKb}KB dropped]` : '';
    const separator = `--- ${path.basename(entry.file)} (${entry.label})${suffix} ---`;
    return `${separator}\n${entry.text}`;
  });
  return (
    `[Project instructions — ${loaded.length} files: ${names}${skippedNote}]\n\n` +
    sections.join('\n\n')
  );
}

// ── Scoped instruction rules (`.moss/rules/*.md`) ──────────────────────────
//
// Project instructions above are scope-by-directory: an ancestor AGENTS.md always
// applies. Rules are scope-by-path: a rule that only matters while editing
// `src/**/*.ts` should not cost tokens while reading docs. This is Cursor's
// `.cursor/rules` activation model, which is the only competitor design that
// separates "always loaded" from "loaded when relevant" for instruction text
// (see why-design §2.6).
//
// File format: Markdown with optional YAML-ish frontmatter that reuses the skill
// parser. `globs:` accepts comma- or space-separated patterns; a rule without
// globs is always loaded (same as an AGENTS.md section). Files are capped so one
// rule cannot crowd out the always-on instruction budget.

/** Per-rule cap; a rule is a scoped hint, not a documentation site. */
export const INSTRUCTION_RULE_MAX_BYTES = 8 * 1024;
/** Total cap across all loaded rules (always + matched). */
export const INSTRUCTION_RULE_MAX_TOTAL_BYTES = 16 * 1024;

export interface InstructionRule {
  /** `rule:<scope>:<name>` — stable across edits to the body. */
  id: string;
  file: string;
  scope: 'user' | 'workspace' | 'managed';
  globs: readonly string[];
  description?: string;
  /** Explicit `activation:` frontmatter (`always|globs|description|manual`). */
  declaredActivation?: InstructionRuleActivation;
  text: string;
}

export interface InstructionRuleOptions {
  workspace: string;
  userDir?: string;
  /**
   * Read-only managed rules for an organization: a directory of `*.md` files or
   * one file. Defaults to `MOSS_MANAGED_RULES`. Managed rules are loaded first,
   * win a name clash against user/workspace rules, and are never written back —
   * a project cannot override its organization's instructions.
   */
  managedPath?: string;
  maxRuleBytes?: number;
  maxTotalBytes?: number;
  /** Human-readable notes (e.g. a workspace rule shadowed by a managed one). */
  notices?: string[];
}

/** `activation:` frontmatter values; anything else is ignored (inferred). */
export function parseDeclaredActivation(
  value: string | undefined
): InstructionRuleActivation | undefined {
  const raw = (value ?? '').trim().toLowerCase();
  if (raw === 'always' || raw === 'globs' || raw === 'description' || raw === 'manual') return raw;
  return undefined;
}

/** Load one rule file for a scope that is not a directory of rules (managed). */
function loadOneRuleFile(
  file: string,
  scope: InstructionRule['scope'],
  maxRuleBytes: number,
  remainingBytes: number
): InstructionRule | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const parsed = parseSkillFile(raw);
  const body = parsed.body.trim();
  if (!body) return undefined;
  const globs = (parsed.frontmatter.globs ?? parsed.frontmatter.glob ?? '')
    .split(/[,\s]+/)
    .map((glob) => glob.trim())
    .filter(Boolean);
  const name = (parsed.frontmatter.name ?? path.basename(file, '.md')).trim();
  const description = (parsed.frontmatter.description ?? '').trim();
  const declaredActivation = parseDeclaredActivation(parsed.frontmatter.activation);
  const budget = Math.min(maxRuleBytes, remainingBytes);
  const text = body.length > budget ? `${body.slice(0, budget)}\n[rule truncated]` : body;
  return {
    id: `rule:${scope}:${name}`,
    file,
    scope,
    globs,
    ...(description ? { description } : {}),
    ...(declaredActivation ? { declaredActivation } : {}),
    text,
  };
}

function listRuleFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.md') && !name.startsWith('.') && !name.startsWith('_'))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Load scoped rules from `<workspace>/.moss/rules` and `<userDir>/rules`.
 * Workspace rules come after user rules so a workspace can override wording.
 */
export function loadInstructionRules(options: InstructionRuleOptions): InstructionRule[] {
  const maxRuleBytes = options.maxRuleBytes ?? INSTRUCTION_RULE_MAX_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? INSTRUCTION_RULE_MAX_TOTAL_BYTES;
  const dirs: Array<{ dir: string; scope: 'user' | 'workspace' }> = [];
  const managedRaw = options.managedPath ?? process.env.MOSS_MANAGED_RULES ?? '';
  const managedDir = managedRaw.trim().length > 0 ? path.resolve(managedRaw.trim()) : '';
  if (options.userDir && path.resolve(options.userDir) !== path.resolve(options.workspace)) {
    dirs.push({ dir: path.join(options.userDir, 'rules'), scope: 'user' });
  }
  dirs.push({ dir: path.join(options.workspace, '.moss', 'rules'), scope: 'workspace' });

  const rules: InstructionRule[] = [];
  let total = 0;
  // Managed rules come first so a same-named user/workspace rule cannot shadow
  // the organization's wording; they are read-only by construction (the loader
  // never opens them for writing) and `moss rules list` marks the scope.
  if (managedDir) {
    const managedFiles =
      fs.existsSync(managedDir) && fs.statSync(managedDir).isDirectory()
        ? listRuleFiles(managedDir)
        : [managedDir];
    for (const file of managedFiles) {
      if (total >= maxTotalBytes) break;
      if (!file.endsWith('.md') || !fs.existsSync(file)) continue;
      const loadedManaged = loadOneRuleFile(file, 'managed', maxRuleBytes, maxTotalBytes - total);
      if (!loadedManaged) continue;
      total += loadedManaged.text.length;
      rules.push(loadedManaged);
    }
  }
  const seen = new Set(rules.map((rule) => ruleName(rule).toLowerCase()));
  for (const { dir, scope } of dirs) {
    for (const file of listRuleFiles(dir)) {
      if (total >= maxTotalBytes) break;
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const parsed = parseSkillFile(raw);
      const body = parsed.body.trim();
      if (!body) continue;
      const globs = (parsed.frontmatter.globs ?? parsed.frontmatter.glob ?? '')
        .split(/[,\s]+/)
        .map((glob) => glob.trim())
        .filter(Boolean);
      const name = (parsed.frontmatter.name ?? path.basename(file, '.md')).trim();
      if (seen.has(name.toLowerCase())) {
        options.notices?.push(
          `${file} is shadowed by a higher-precedence rule named ${name} (managed rules win)`
        );
        continue;
      }
      seen.add(name.toLowerCase());
      const description = (parsed.frontmatter.description ?? '').trim();
      const declaredActivation = parseDeclaredActivation(parsed.frontmatter.activation);
      const budget = Math.min(maxRuleBytes, maxTotalBytes - total);
      const text = body.length > budget ? `${body.slice(0, budget)}\n[rule truncated]` : body;
      total += text.length;
      rules.push({
        id: `rule:${scope}:${name}`,
        file,
        scope,
        globs,
        ...(description ? { description } : {}),
        ...(declaredActivation ? { declaredActivation } : {}),
        text,
      });
    }
  }
  return rules;
}

/** True when a workspace-relative path activates the rule (always-rules match nothing here). */
export function ruleMatchesPaths(rule: InstructionRule, relativePaths: readonly string[]): boolean {
  if (rule.globs.length === 0) return false;
  return relativePaths.some((file) =>
    micromatch.isMatch(file, rule.globs as string[], { dot: true, nocase: true })
  );
}

/**
 * How a rule activates, using Cursor's `.cursor/rules` classes plus one more:
 * - `always`      — no globs and no description: an unconditional rule;
 * - `globs`       — a path pattern decides (auto attached);
 * - `description` — the rule text describes its own trigger; it is attached for
 *                   the turn whose user message scores a match against that
 *                   description (D9; deterministic token overlap, no model call);
 * - `manual`      — only a `description` without `activation:`: the body is
 *                   *not* injected automatically, `@rule:<name>` loads it.
 *
 * The `manual` branch is the fix for the inverted intent: a description means
 * "tell the model this rule exists and can be requested", not "apply it
 * everywhere". Rules that predate descriptions keep their old always-on
 * behavior because they have neither field. `activation:` is explicit and
 * overrides the inferred class (`activation: always` with a description stays
 * always-on).
 */
export type InstructionRuleActivation = 'always' | 'globs' | 'description' | 'manual';

export function ruleActivation(rule: InstructionRule): InstructionRuleActivation {
  const declared = rule.declaredActivation;
  if (declared === 'always') return 'always';
  if (declared === 'globs' && rule.globs.length > 0) return 'globs';
  if (declared === 'manual') return 'manual';
  if (declared === 'description') return rule.description ? 'description' : 'manual';
  if (rule.globs.length > 0) return 'globs';
  if (rule.description) return 'manual';
  return 'always';
}

/** Name a user writes after `@rule:`; the rule id carries a `rule:<scope>:` prefix. */
export function ruleName(rule: InstructionRule): string {
  const fromId = rule.id.split(':').pop();
  if (fromId) return fromId;
  return path.basename(rule.file, '.md');
}

/** `@rule:<name>` / `@rule/<name>` mentions in a user message. */
export function requestedRuleNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/@rule[:/]([\w.-]+)/gi)) {
    const name = match[1];
    if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

/** Manual rules the user explicitly asked for in this text. */
export function selectRequestedRules(
  rules: readonly InstructionRule[],
  text: string
): InstructionRule[] {
  const requested = new Set(requestedRuleNames(text));
  if (requested.size === 0) return [];
  return rules.filter((rule) => {
    const activation = ruleActivation(rule);
    if (activation !== 'manual' && activation !== 'description') return false;
    return requested.has(ruleName(rule).toLowerCase());
  });
}

/** Rules active for the given touched paths: always-on, glob matches and (when a
 * message is supplied) description matches. */
export function selectActiveRules(
  rules: readonly InstructionRule[],
  relativePaths: readonly string[],
  text?: string
): InstructionRule[] {
  const described =
    text !== undefined && text.trim().length > 0
      ? new Set(selectDescriptionRules(rules, text).map((rule) => rule.id))
      : new Set<string>();
  return rules.filter((rule) => {
    const activation = ruleActivation(rule);
    if (activation === 'always') return true;
    if (activation === 'globs') return ruleMatchesPaths(rule, relativePaths);
    if (activation === 'description') return described.has(rule.id);
    return false;
  });
}

// ── Description activation (D9) ───────────────────────────────────────────
//
// A rule whose frontmatter says `activation: description` declares its own
// trigger in prose ("device bring-up checklist"). Reusing a model call to decide
// would make the prompt nondeterministic and untestable, so the match is a
// transparent token overlap: the rule applies for this turn when at least
// `minMatchedTokens` of its description words appear in the user message and
// they cover `minCoverage` of the description. Both numbers are exposed so a
// probe can pin the semantics; a false positive costs one rule body, a false
// negative is fixed by `@rule:<name>`.

/** Words too common to mean anything in a trigger description. */
const DESCRIPTION_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'when',
  'before',
  'after',
  'into',
  'your',
  'you',
  'are',
  'not',
  'use',
  'using',
  'only',
  'also',
  'must',
  'should',
  'will',
  'can',
  'any',
  'all',
  'its',
  'their',
  'them',
  'then',
  'than',
  'there',
  'here',
  'have',
  'has',
  'had',
  'was',
  'were',
  'been',
  'being',
  'does',
  'did',
  'but',
  'per',
  'via',
  'out',
  'off',
  'over',
  'under',
  'more',
  'most',
  'some',
  'such',
  'each',
  'other',
  'own',
  'same',
  'just',
  'like',
  'make',
  'made',
  'get',
  'got',
  'new',
  'old',
  'one',
  'two',
  'first',
  'last',
  'rule',
  'rules',
  'file',
  'files',
  'code',
  'work',
  'working',
]);

/** Content words of a trigger text (lowercase, length >= 3, no stopwords). */
function descriptionTokens(text: string): string[] {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || DESCRIPTION_STOPWORDS.has(raw)) continue;
    tokens.add(raw);
  }
  return [...tokens];
}

export interface DescriptionRuleMatch {
  rule: InstructionRule;
  /** Share of the rule description's content words found in the message. */
  score: number;
  matched: string[];
}

export interface DescriptionMatchOptions {
  minMatchedTokens?: number;
  minCoverage?: number;
}

/** Description-activated rules whose trigger matches `text`, best first. */
export function matchDescriptionRules(
  rules: readonly InstructionRule[],
  text: string,
  options: DescriptionMatchOptions = {}
): DescriptionRuleMatch[] {
  const minMatchedTokens = options.minMatchedTokens ?? 2;
  const minCoverage = options.minCoverage ?? 0.34;
  const userTokens = new Set(descriptionTokens(text));
  const matches: DescriptionRuleMatch[] = [];
  for (const rule of rules) {
    if (ruleActivation(rule) !== 'description') continue;
    const tokens = descriptionTokens(rule.description ?? '');
    if (tokens.length === 0) continue;
    const matched = tokens.filter((token) => userTokens.has(token));
    if (matched.length < minMatchedTokens) continue;
    const score = matched.length / tokens.length;
    if (score < minCoverage) continue;
    matches.push({ rule, score, matched });
  }
  return matches.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));
}

/** Rules to inject for this message by their description trigger. */
export function selectDescriptionRules(
  rules: readonly InstructionRule[],
  text: string,
  options?: DescriptionMatchOptions
): InstructionRule[] {
  return matchDescriptionRules(rules, text, options).map((match) => match.rule);
}

/**
 * Path-like tokens in a user message: `@src/a.ts`, `src/a.ts`, `./x/y.mjs`.
 * Used to activate rules on the first turn, before any tool has touched a path.
 * Deliberately conservative — a false positive only costs a few hundred tokens,
 * a false negative delays the rule until the first edit.
 */
export function extractPathTokens(text: string): string[] {
  const matches = text.match(/@?[\w.~/-]*[\w-]+\.[A-Za-z0-9]{1,8}\b/g) ?? [];
  const out = new Set<string>();
  for (const raw of matches) {
    const token = raw
      .replace(/^@/, '')
      .replace(/^\.\//, '')
      .replace(/[),.;:]+$/, '');
    if (!token.includes('/') && !token.includes('.')) continue;
    out.add(token);
  }
  return [...out];
}

/** Render active rules as one prompt layer; header names each rule and its globs. */
export function formatInstructionRules(title: string, rules: readonly InstructionRule[]): string {
  if (rules.length === 0) return '';
  const sections = rules.map((rule) => {
    const activation = ruleActivation(rule);
    const scope = activation === 'globs' ? rule.globs.join(',') : activation;
    return `--- ${title}: ${rule.id} (${scope}) ---\n${rule.text}`;
  });
  return `${sections.join('\n\n')}`;
}

/**
 * Index of rules whose body is not (always) in the prompt: the model sees what
 * exists and that the user can name it, without paying for every body up front.
 * Description-activated rules get a line too — when their trigger words do not
 * match a turn, `@rule:<name>` is still a way to force the body in.
 */
export function formatAvailableRules(rules: readonly InstructionRule[]): string {
  const lines = rules
    .filter((rule) => {
      const activation = ruleActivation(rule);
      return activation === 'manual' || activation === 'description';
    })
    .map((rule) => {
      const activation = ruleActivation(rule);
      const hint = activation === 'description' ? ' (auto on matching messages)' : '';
      return `- @rule:${ruleName(rule)} — ${rule.description ?? '(no description)'}${hint}`;
    });
  if (lines.length === 0) return '';
  return [
    'Project rules that are available on request (not part of this prompt):',
    ...lines,
    'Load one only when the user asks for it by name (`@rule:<name>`): the body then joins the conversation.',
  ].join('\n');
}
