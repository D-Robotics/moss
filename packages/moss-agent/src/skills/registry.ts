import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  SkillDependencyKind,
  SkillMeta,
  SkillPermission,
  SkillRegistryDiagnostic,
  SkillRegistrySnapshot,
} from './types.js';
import { getRootLogger } from '../logger.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { listBuiltinSkills } from './builtin.js';
import { errorMessage } from '../errors.js';

const log = getRootLogger().child('agent:skill-registry');

const SKILL_MATCH_STOP_WORDS = new Set([
  'about',
  'action',
  'and',
  'are',
  'for',
  'from',
  'help',
  'into',
  'items',
  'note',
  'please',
  'summarize',
  'that',
  'the',
  'this',
  'with',
  'write',
  'your',
]);

export const DEFAULT_EXTRA_SKILL_ROOTS: readonly string[] = [
  '~/.claude/skills',
  '~/.agents/skills',
];

export function expandTilde(p: string, home = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

export function resolveDefaultSkillRoots(
  configured?: readonly string[],
  home = os.homedir()
): string[] {
  const raw = configured ?? DEFAULT_EXTRA_SKILL_ROOTS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const resolved = path.resolve(expandTilde(entry.trim(), home));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    try {
      if (fs.statSync(resolved).isDirectory()) out.push(resolved);
    } catch {}
  }
  return out;
}

export function resolveBundledRdkSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'assets', 'rdk-knowledge', 'skills');
}

export interface SkillRegistryOptions {
  workspaceDir: string;
  extraDirs?: string[];
  includeBuiltin?: boolean;

  includeBundledRdkSkills?: boolean;
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const map: Record<string, string> = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    if (/^\s/.test(line)) continue;

    if (/^\s*[-#]/.test(line)) continue;
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;

    map[key] = line
      .slice(i + 1)
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, '$2');
  }
  return map;
}

function parseList(raw?: string): string[] {
  if (!raw) return [];
  const normalized = raw.trim().replace(/^\[|\]$/g, '');
  return normalized
    .split(/[;,]/)
    .map((s) => s.trim().replace(/^(['"])([\s\S]*)\1$/, '$2'))
    .filter(Boolean);
}

function parseInlineMetadata(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) result[key] = value.map(String).join(',');
      else if (value !== null && ['string', 'number', 'boolean'].includes(typeof value)) {
        result[key] = String(value);
      }
    }
    return result;
  } catch {
    return {};
  }
}

function parsePermissions(raw?: string): SkillPermission {
  const perms = new Set(parseList(raw).map((s) => s.toLowerCase()));
  return {
    workspaceRead: perms.has('workspace_read'),
    workspaceWrite: perms.has('workspace_write'),
    deviceExec: perms.has('device_exec'),
    network: perms.has('network'),
  };
}

function compactHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function normalizeIdentityPart(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  );
}

function sourceScope(sourcePath: string): string {
  const normalized = sourcePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.startsWith('builtin://')) return 'builtin';
  if (normalized.includes('/rdk-knowledge/skills/')) return 'rdk';
  if (normalized.includes('/.moss/skills/') || normalized.includes('/.agents/skills/')) {
    return 'workspace';
  }
  if (normalized.includes('/.claude/skills/') || normalized.includes('/.config/moss/skills/')) {
    return 'global';
  }
  return 'file';
}

export function deriveSkillStableId(
  skill: Pick<SkillMeta, 'name' | 'sourcePath' | 'stableId'>
): string {
  const declared = skill.stableId?.trim();
  if (declared) return normalizeIdentityPart(declared);
  return `${sourceScope(skill.sourcePath)}:${normalizeIdentityPart(skill.name)}`;
}

function normalizeSkillMeta(skill: SkillMeta, content: string): SkillMeta {
  return {
    ...skill,
    stableId: deriveSkillStableId(skill),
    contentHash: compactHash(content),
    summary: skill.summary?.trim() || skill.description,
    inputs: [...new Set(skill.inputs ?? [])],
    outputs: [...new Set(skill.outputs ?? [])],
    requires: [...new Set(skill.requires ?? [])],
    before: [...new Set(skill.before ?? [])],
    after: [...new Set(skill.after ?? [])],
    conflicts: [...new Set(skill.conflicts ?? [])],
  };
}

function referenceFields(skill: SkillMeta): Array<[SkillDependencyKind, string[]]> {
  return [
    ['requires', skill.requires ?? []],
    ['before', skill.before ?? []],
    ['after', skill.after ?? []],
    ['conflicts', skill.conflicts ?? []],
  ];
}

function resolveReference(reference: string, byRef: Map<string, SkillMeta>): SkillMeta | undefined {
  return byRef.get(reference.trim().toLowerCase());
}

function validateSkillMetadata(skills: SkillMeta[]): SkillRegistryDiagnostic[] {
  const diagnostics: SkillRegistryDiagnostic[] = [];
  const byRef = new Map<string, SkillMeta>();
  const byStableId = new Map<string, SkillMeta>();
  for (const skill of skills) {
    const stableId = skill.stableId ?? deriveSkillStableId(skill);
    const previous = byStableId.get(stableId);
    if (previous) {
      diagnostics.push({
        code: 'duplicate-stable-id',
        skill: skill.name,
        message: `Stable id ${stableId} is also used by ${previous.name}`,
      });
    } else {
      byStableId.set(stableId, skill);
    }
    for (const alias of [stableId, skill.name, ...getSkillAliases(skill)]) {
      if (!byRef.has(alias.toLowerCase())) byRef.set(alias.toLowerCase(), skill);
    }
  }

  const edges = new Map<string, Set<string>>();
  for (const skill of skills) edges.set(skill.stableId!, new Set());
  for (const skill of skills) {
    for (const [kind, references] of referenceFields(skill)) {
      for (const reference of references) {
        const target = resolveReference(reference, byRef);
        if (!target) {
          diagnostics.push({
            code: 'unknown-reference',
            skill: skill.name,
            reference,
            kind,
            message: `${kind} reference ${reference} does not resolve`,
          });
          continue;
        }
        if (target.stableId === skill.stableId) {
          diagnostics.push({
            code: 'self-reference',
            skill: skill.name,
            reference,
            kind,
            message: `${kind} must not reference the skill itself`,
          });
          continue;
        }
        if (kind === 'requires' || kind === 'after')
          edges.get(target.stableId!)!.add(skill.stableId!);
        if (kind === 'before') edges.get(skill.stableId!)!.add(target.stableId!);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleReported = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(Math.max(0, start)), id];
      const key = [...new Set(cycle)].sort().join('|');
      if (!cycleReported.has(key)) {
        cycleReported.add(key);
        const skill = byStableId.get(id);
        diagnostics.push({
          code: 'dependency-cycle',
          skill: skill?.name ?? id,
          message: `Dependency cycle: ${cycle.join(' -> ')}`,
        });
      }
      return;
    }
    visiting.add(id);
    stack.push(id);
    for (const next of edges.get(id) ?? []) visit(next, stack);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id, []);
  return diagnostics;
}

/** Name + directory + tags + triggers for skill lookup (slash, load_skill). @public */
export function getSkillAliases(meta: SkillMeta): string[] {
  const dirName = path.basename(path.dirname(meta.sourcePath));
  return [
    ...new Set(
      [meta.name, dirName, ...meta.tags, ...meta.trigger]
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

function collectSkillFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSkillFiles(full));
    } else if (entry.isFile() && entry.name.toUpperCase() === 'SKILL.MD') {
      out.push(full);
    }
  }
  return out;
}

/** Generated recovery Skills are activated only by the trusted A/B coordinator. */
export function isExperimentManagedSkillPath(sourcePath: string): boolean {
  if (!sourcePath || sourcePath.startsWith('builtin://')) return false;
  try {
    return fs.existsSync(path.join(path.dirname(sourcePath), 'TRUSTED-PATCH.json'));
  } catch {
    return false;
  }
}

export class SkillRegistry {
  private workspaceDir: string;
  private extraDirs: string[];
  private includeBuiltin: boolean;
  private includeBundledRdkSkills: boolean;
  private cache: SkillMeta[] = [];
  private cacheDiagnostics: SkillRegistryDiagnostic[] = [];
  private lastLoadedAt = 0;
  private readonly inlineSkills = new Map<string, SkillMeta>();
  private readonly inlineEnabled = new Map<string, boolean>();

  constructor(opts: SkillRegistryOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.extraDirs = opts.extraDirs ?? [];
    this.includeBuiltin = opts.includeBuiltin ?? true;
    this.includeBundledRdkSkills = opts.includeBundledRdkSkills ?? true;
  }

  addExtraDir(dir: string): void {
    if (!this.extraDirs.includes(dir)) {
      this.extraDirs.push(dir);
      this.lastLoadedAt = 0;
    }
  }

  /** Install an immutable, instance-local skill and return an idempotent disposer. @beta */
  registerInline(skill: SkillMeta): () => void {
    const normalized = normalizeSkillMeta({ ...skill }, skill.body ?? skill.description);
    const id = normalized.stableId!;
    if (
      this.inlineSkills.has(id) ||
      this.loadAll().some((candidate) => candidate.stableId === id)
    ) {
      throw new Error(`skill already registered: ${id}`);
    }
    const frozen = Object.freeze({ ...normalized });
    this.inlineSkills.set(id, frozen);
    this.inlineEnabled.set(id, frozen.enabled !== false);
    this.lastLoadedAt = 0;
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.inlineSkills.get(id) === frozen) {
        this.inlineSkills.delete(id);
        this.inlineEnabled.delete(id);
      }
      this.lastLoadedAt = 0;
    };
  }

  hasStableId(id: string): boolean {
    return this.loadAll().some((skill) => skill.stableId === id);
  }

  extraDirsSnapshot(): string[] {
    return [...this.extraDirs];
  }

  loadAll(force = false): SkillMeta[] {
    const now = Date.now();
    if (!force && now - this.lastLoadedAt < 3000 && this.cache.length > 0) {
      return this.cache;
    }
    const paths = getMossWorkspacePaths(this.workspaceDir);

    const sources = [
      paths.skillsDir,
      paths.agentSkillsDir,
      paths.legacySkillsDir,
      paths.legacyAgentSkillsDir,

      ...(this.includeBundledRdkSkills ? [resolveBundledRdkSkillsDir()] : []),
      ...this.extraDirs,
    ];
    const seenFiles = new Set<string>();
    const files: string[] = [];
    for (const dir of sources) {
      for (const file of collectSkillFiles(dir)) {
        const resolved = path.resolve(file);
        if (seenFiles.has(resolved)) continue;
        seenFiles.add(resolved);
        files.push(resolved);
      }
    }
    const metas: SkillMeta[] = this.includeBuiltin
      ? listBuiltinSkills().map((skill) =>
          normalizeSkillMeta({ ...skill }, skill.body ?? skill.description)
        )
      : [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const fm = parseFrontmatter(raw);
        const config = { ...parseInlineMetadata(fm.metadata), ...fm };
        metas.push(
          normalizeSkillMeta(
            {
              name: fm.name || path.basename(path.dirname(file)),
              description: fm.description || 'Moss skill',
              sourcePath: file,
              version: fm.version || '0.1.0',
              tags: parseList(config.tags),
              trigger: parseList(config.trigger || config.triggers),
              risk: (config.risk as 'low' | 'medium' | 'high') || 'medium',
              permissions: parsePermissions(config.permissions),
              runtimePolicy: {
                delegatePreference:
                  (config.delegate_preference as 'local' | 'board' | 'hybrid' | 'collaborative') ||
                  'hybrid',
                requiresBoard: config.requires_board === 'true',
                approvalLevel:
                  (config.approval_level as 'none' | 'confirm' | 'strict') || 'confirm',
                cooldownSeconds:
                  Number(config.cooldown ?? config.cooldown_seconds ?? '0') || undefined,
                schedulerTemplate: config.scheduler_template || undefined,
              },
              stableId: config.stable_id || undefined,
              summary: config.summary || undefined,
              inputs: parseList(config.inputs),
              outputs: parseList(config.outputs),
              requires: parseList(config.requires),
              before: parseList(config.before),
              after: parseList(config.after),
              conflicts: parseList(config.conflicts),
              enabled: config.enabled !== 'false' && !isExperimentManagedSkillPath(file),
              updatedAt: fs.statSync(file).mtimeMs,
            },
            raw
          )
        );
      } catch (err) {
        log.warn('failed to parse', { file, error: errorMessage(err) });
      }
    }
    metas.push(
      ...[...this.inlineSkills.entries()].map(([id, skill]) => ({
        ...skill,
        enabled: this.inlineEnabled.get(id) ?? skill.enabled,
      }))
    );
    this.cache = metas.sort((a, b) => b.updatedAt - a.updatedAt);
    this.cacheDiagnostics = validateSkillMetadata(this.cache);
    this.lastLoadedAt = now;
    return this.cache;
  }

  list(): SkillMeta[] {
    return this.loadAll();
  }
  reload(): SkillMeta[] {
    return this.loadAll(true);
  }

  diagnostics(): SkillRegistryDiagnostic[] {
    this.loadAll();
    return this.cacheDiagnostics.map((diagnostic) => ({ ...diagnostic }));
  }

  snapshot(): SkillRegistrySnapshot {
    const skills = this.loadAll().filter((skill) => skill.enabled !== false);
    const compact = skills
      .map((skill) => ({
        id: skill.stableId,
        content: skill.contentHash,
        name: skill.name,
        description: skill.description,
        summary: skill.summary,
        tags: skill.tags,
        trigger: skill.trigger,
        inputs: skill.inputs,
        outputs: skill.outputs,
        requires: skill.requires,
        before: skill.before,
        after: skill.after,
        conflicts: skill.conflicts,
        runtimePolicy: skill.runtimePolicy,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return {
      digest: compactHash(JSON.stringify(compact)),
      skills: [...skills],
      diagnostics: this.diagnostics(),
    };
  }

  /**
   * Enable or disable a skill by name (in-memory, per-session; not persisted
   * to disk). Disabling a skill stops it from matching in matchByText (and
   * thus from being auto-injected) and from being surfaced as a /<skillname>
   * command. Works for both file-backed and builtin skills. Returns true if a
   * skill with that name was found and toggled.
   */
  setEnabled(name: string, enabled: boolean): boolean {
    const target = name.trim().toLowerCase();
    const metas = this.loadAll();
    let hit = false;
    for (const m of metas) {
      if (m.name.trim().toLowerCase() === target) {
        if (m.stableId && this.inlineSkills.has(m.stableId)) {
          this.inlineEnabled.set(m.stableId, enabled);
          this.lastLoadedAt = 0;
        } else {
          m.enabled = enabled;
        }
        hit = true;
      }
    }
    return hit;
  }

  matchByText(text: string): SkillMeta[] {
    const q = text.toLowerCase().trim();
    if (!q) return [];
    const asciiWords = [
      ...new Set(
        q
          .split(/[^\p{L}\p{N}]+/u)
          .filter((token) => /^[a-z0-9]{3,}$/i.test(token) && !SKILL_MATCH_STOP_WORDS.has(token))
      ),
    ];
    const scored = this.list()
      .flatMap((s, index) => {
        if (!s.enabled) return [];
        const nameL = s.name.toLowerCase();
        const descL = s.description.toLowerCase();
        const nameSpaced = nameL.replace(/-/g, ' ');
        let score = 0;
        if (nameL === q || nameSpaced === q) score = Math.max(score, 120);
        if (nameL.includes(q) || nameSpaced.includes(q) || q.includes(nameSpaced)) {
          score = Math.max(score, 100);
        }
        for (const trigger of s.trigger) {
          const normalizedTrigger = trigger.toLowerCase().trim();
          if (normalizedTrigger && q.includes(normalizedTrigger)) {
            score = Math.max(score, 110 + Math.min(20, normalizedTrigger.length));
          }
        }
        if (descL.includes(q)) score = Math.max(score, 90);
        if (asciiWords.length > 0) {
          const nameHay = nameSpaced;
          const descHay = descL.replace(/-/g, ' ');
          const haystackWords = new Set(
            `${nameHay} ${descHay}`.split(/[^a-z0-9]+/i).filter(Boolean)
          );
          const matchedWordCount = asciiWords.filter((token) => haystackWords.has(token)).length;
          const requiredMatches = asciiWords.length === 1 ? 1 : 2;
          if (matchedWordCount >= requiredMatches) {
            score = Math.max(score, 20 + matchedWordCount);
          }
        }
        return score > 0 ? [{ skill: s, score, index }] : [];
      })
      .sort((left, right) => right.score - left.score || left.index - right.index);
    if (scored.length === 0) return [];
    const explicitMatches = scored.filter((entry) => entry.score >= 90);
    return (explicitMatches.length > 0 ? explicitMatches : scored.slice(0, 1)).map(
      (entry) => entry.skill
    );
  }

  rankByPreferredRefs(skills: SkillMeta[], preferredRefs: string[] = []): SkillMeta[] {
    if (preferredRefs.length === 0 || skills.length <= 1) return skills;
    const preferred = new Set(
      preferredRefs.map((item) => item.trim().toLowerCase()).filter(Boolean)
    );
    return [...skills].sort((left, right) => {
      const lp = getSkillAliases(left).some((a) => preferred.has(a));
      const rp = getSkillAliases(right).some((a) => preferred.has(a));
      if (lp === rp) return 0;
      return lp ? -1 : 1;
    });
  }
}
