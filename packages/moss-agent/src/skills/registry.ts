





import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillMeta, SkillPermission } from './types.js';
import { getRootLogger } from '../logger.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { listBuiltinSkills } from './builtin.js';
import { errorMessage } from '../errors.js';

const log = getRootLogger().child('agent:skill-registry');

const SKILL_MATCH_STOP_WORDS = new Set([
  'about', 'action', 'and', 'are', 'for', 'from', 'help', 'into', 'items', 'note',
  'please', 'summarize', 'that', 'the', 'this', 'with', 'write', 'your',
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
    } catch {
      
    }
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
  return raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
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

export class SkillRegistry {
  private workspaceDir: string;
  private extraDirs: string[];
  private includeBuiltin: boolean;
  private includeBundledRdkSkills: boolean;
  private cache: SkillMeta[] = [];
  private lastLoadedAt = 0;

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
    const metas: SkillMeta[] = this.includeBuiltin ? listBuiltinSkills() : [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const fm = parseFrontmatter(raw);
        metas.push({
          name: fm.name || path.basename(path.dirname(file)),
          description: fm.description || 'Moss skill',
          sourcePath: file,
          version: fm.version || '0.1.0',
          tags: parseList(fm.tags),
          trigger: parseList(fm.trigger || fm.triggers),
          risk: (fm.risk as 'low' | 'medium' | 'high') || 'medium',
          permissions: parsePermissions(fm.permissions),
          runtimePolicy: {
            delegatePreference:
              (fm.delegate_preference as 'local' | 'board' | 'hybrid' | 'collaborative') ||
              'hybrid',
            requiresBoard: fm.requires_board === 'true',
            approvalLevel: (fm.approval_level as 'none' | 'confirm' | 'strict') || 'confirm',
            cooldownSeconds: Number(fm.cooldown ?? fm.cooldown_seconds ?? '0') || undefined,
            schedulerTemplate: fm.scheduler_template || undefined,
          },
          enabled: fm.enabled !== 'false',
          updatedAt: fs.statSync(file).mtimeMs,
        });
      } catch (err) {
        log.warn('failed to parse', { file, error: errorMessage(err) });
      }
    }
    this.cache = metas.sort((a, b) => b.updatedAt - a.updatedAt);
    this.lastLoadedAt = now;
    return this.cache;
  }

  list(): SkillMeta[] {
    return this.loadAll();
  }
  reload(): SkillMeta[] {
    return this.loadAll(true);
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
        m.enabled = enabled;
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
        q.split(/[^\p{L}\p{N}]+/u).filter(
          (token) => /^[a-z0-9]{3,}$/i.test(token) && !SKILL_MATCH_STOP_WORDS.has(token)
        )
      ),
    ];
    const scored = this.list().flatMap((s, index) => {
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
    }).sort((left, right) => right.score - left.score || left.index - right.index);
    if (scored.length === 0) return [];
    const explicitMatches = scored.filter((entry) => entry.score >= 90);
    return (explicitMatches.length > 0 ? explicitMatches : scored.slice(0, 1))
      .map((entry) => entry.skill);
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
