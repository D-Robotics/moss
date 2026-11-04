/**
 * Skill contracts (Agent Skills format, plus Moss extensions).
 *
 * A skill is a directory: `SKILL.md` (frontmatter + instructions) and optional
 * `scripts/`, `references/`, `assets/`, `evals/`. The spec this implements is
 * https://agentskills.io/specification; Moss adds `when` (trigger hint, shown in
 * the catalog) and `globs` (deterministic path activation).
 *
 * Validation is lenient on purpose: an invalid name or an over-long description
 * must not make an installed skill disappear, but every deviation is reported as
 * a `SkillIssue` so `/skills --problems` and `moss skill validate` can say what
 * to fix.
 */

export const SKILL_NAME_MAX_CHARS = 64;
export const SKILL_DESCRIPTION_MAX_CHARS = 1024;
/** Hard cap on a SKILL.md body; the skill tool truncates at its declared budget. */
export const SKILL_BODY_MAX_BYTES = 64 * 1024;
export const SKILL_RESOURCE_MAX_FILES = 64;
export const SKILL_RESOURCE_MAX_BYTES = 1024 * 1024;

/** `shared` is the cross-client `.agents/skills/` convention. */
export type SkillScope = 'workspace' | 'shared' | 'user' | 'bundled';

/** Spec-conforming name: lowercase letters/digits, hyphen-separated, ≤64. */
export const SKILL_SPEC_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillIssueCode =
  | 'invalid-name'
  | 'legacy-name'
  | 'description-too-long'
  | 'body-too-long'
  | 'missing-frontmatter'
  | 'malformed-frontmatter'
  | 'unsupported-yaml'
  | 'placeholder'
  | 'empty'
  | 'hidden-dir'
  | 'duplicate-name'
  | 'unknown-field'
  | 'resource-oversize'
  | 'evals-invalid';

export interface SkillIssue {
  code: SkillIssueCode;
  /** One actionable line, safe to print. */
  message: string;
  file: string;
}

export interface SkillResources {
  /** Paths relative to the skill directory, sorted, capped. */
  references: string[];
  scripts: string[];
  assets: string[];
  /** `evals/evals.json` exists. */
  evals: boolean;
}

export function emptySkillResources(): SkillResources {
  return { references: [], scripts: [], assets: [], evals: false };
}

/**
 * Host-supplied skill catalog port. The host decides where skills come from
 * (filesystem scopes, bundled, remote); core renders the catalog, registers the
 * `skill` tool and re-reads this on every turn so a late install or a glob
 * activation reaches runs that already exist.
 */
export interface SkillCatalogPort {
  manifests(): readonly SkillManifest[];
  /** L1 catalog budget in characters; core default is 8,000. */
  budgetChars?: number;
}

/** One installed skill, as the agent sees it. */
export interface SkillManifest {
  name: string;
  description: string;
  /** Moss extension: trigger hint rendered into the catalog line. */
  when?: string;
  version?: string;
  license?: string;
  compatibility?: string;
  /**
   * Spec `allowed-tools`: narrows the tools offered for the rest of the run
   * once the skill loads. Never auto-approves a call (approval still runs).
   */
  allowedTools: string[];
  /** Spec `disallowed-tools`: tools hidden for the rest of the run. */
  disallowedTools: string[];
  metadata: Record<string, string>;
  /** Moss extension: workspace-relative globs that activate the skill's catalog entry. */
  globs: string[];
  scope: SkillScope;
  /** Skill directory (bundled uses a `builtin:` sentinel). */
  dir: string;
  /** SKILL.md path (bundled uses `builtin:<name>`). */
  file: string;
  /** Bundled skills inline the body; filesystem skills read it on demand. */
  body?: string;
  resources: SkillResources;
  issues: SkillIssue[];
  /** Name does not match the spec (spaces/unicode); still loaded, no spec slash token. */
  legacy: boolean;
}
