import fs from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceMemoryConfig {
  workspaceDir: string;
  /**
   * Optional process cwd. When under workspaceDir (or under the discovered
   * git root), instruction files are collected along the path from the project
   * root down to cwd — Codex `agents_md.rs` hierarchical loading parity.
   */
  cwd?: string;
  /**
   * Optional global user instruction files (e.g. ~/.config/moss/AGENTS.md).
   * Loaded first so project rules can refine them.
   */
  globalInstructionPaths?: readonly string[];
  /**
   * Project-instruction filenames to look for, in priority order within a
   * single directory. Defaults include AGENTS.override.md (Codex local override)
   * then AGENTS.md / CLAUDE.md / MOSS.md.
   */
  projectInstructionFiles?: readonly string[];
  /**
   * When true (default), walk ancestor directories up to the git root and merge
   * instruction files found there (and along root→cwd when cwd is set).
   */
  walkAncestors?: boolean;
  /** Max ancestor hops when walkAncestors is enabled (default 8). */
  maxAncestorHops?: number;
  /**
   * When true (default), append the hierarchical-AGENTS policy note so the
   * model knows deeper files override parent scope (Codex hierarchical.md).
   */
  includeHierarchicalPolicy?: boolean;
}

export interface WorkspaceMemoryContext {
  agentRules: string | null;
  agentRulesSource: string | null;
  agentRulesSources?: string[];
}

const MAX_FILE_SIZE = 12_000;
const MAX_TOTAL_SIZE = 28_000;
const DEFAULT_MAX_ANCESTOR_HOPS = 8;

/**
 * Codex-style candidates: AGENTS.override.md wins within a directory, then
 * AGENTS.md / Claude Code / Moss names. All present non-override files merge;
 * override replaces same-dir AGENTS.md content when both exist.
 */
export const DEFAULT_PROJECT_INSTRUCTION_FILES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'CLAUDE.md',
  'Claude.md',
  'MOSS.md',
];

/** Codex hierarchical.md distilled for the model. */
export const HIERARCHICAL_AGENTS_POLICY = [
  '## Hierarchical project instructions',
  'Project instruction files (AGENTS.md / CLAUDE.md / MOSS.md) govern the directory',
  'that contains them and all children beneath it. When two files disagree, the',
  'deeper path overrides the higher-level one. Direct user / system instructions',
  'outrank any project instruction file.',
].join('\n');

interface LoadedSection {
  source: string;
  content: string;
}

export class WorkspaceMemory {
  private readonly dir: string;
  private readonly cwd: string | undefined;
  private readonly globalPaths: readonly string[];
  private readonly candidates: readonly string[];
  private readonly walkAncestors: boolean;
  private readonly maxAncestorHops: number;
  private readonly includeHierarchicalPolicy: boolean;

  constructor(config: WorkspaceMemoryConfig) {
    this.dir = path.resolve(config.workspaceDir);
    this.cwd = config.cwd ? path.resolve(config.cwd) : undefined;
    this.globalPaths = config.globalInstructionPaths ?? [];
    this.candidates =
      config.projectInstructionFiles && config.projectInstructionFiles.length > 0
        ? config.projectInstructionFiles
        : DEFAULT_PROJECT_INSTRUCTION_FILES;
    this.walkAncestors = config.walkAncestors !== false;
    this.maxAncestorHops = Math.max(
      0,
      Math.floor(config.maxAncestorHops ?? DEFAULT_MAX_ANCESTOR_HOPS)
    );
    this.includeHierarchicalPolicy = config.includeHierarchicalPolicy !== false;
  }

  private async hasGitMarker(dir: string): Promise<boolean> {
    try {
      await fs.stat(path.join(dir, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Collect directories farthest-first:
   * 1) path from git root (or workspace) down to cwd when cwd is nested
   * 2) otherwise ancestors of workspace up to git root
   */
  private async collectSearchDirs(): Promise<string[]> {
    const workspace = this.dir;
    const cwd = this.cwd && this.isUnder(this.cwd, workspace) ? this.cwd : workspace;

    // Prefer git root as the top of the hierarchy when present (Codex project root).
    let root = workspace;
    if (this.walkAncestors) {
      let current = workspace;
      for (let hop = 0; hop <= this.maxAncestorHops; hop++) {
        if (await this.hasGitMarker(current)) {
          root = current;
          break;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    // Build root → cwd chain (inclusive), then reverse is not needed if we push root-first.
    const chain: string[] = [];
    let cur = cwd;
    const seen = new Set<string>();
    // Walk up from cwd to root, then reverse.
    for (let hop = 0; hop < this.maxAncestorHops + 8; hop++) {
      if (seen.has(cur)) break;
      seen.add(cur);
      chain.push(cur);
      if (cur === root) break;
      if (!this.isUnder(cur, root) && cur !== root) {
        // cwd outside root — fall back to workspace-only chain
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    // farthest first
    const ordered = chain.reverse();

    // Ensure workspace is included
    if (!ordered.includes(workspace)) {
      ordered.push(workspace);
    }
    return ordered;
  }

  private isUnder(child: string, parent: string): boolean {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private displaySource(filePath: string): string {
    const rel = path.relative(this.dir, filePath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/');
    }
    return path.basename(filePath);
  }

  private async tryLoadFile(filePath: string): Promise<LoadedSection | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (!content.trim()) return null;
      const body =
        content.length > MAX_FILE_SIZE
          ? content.slice(0, MAX_FILE_SIZE) + '\n\n[... truncated]'
          : content;
      return { source: this.displaySource(filePath), content: body };
    } catch {
      return null;
    }
  }

  async loadContext(): Promise<WorkspaceMemoryContext> {
    const sections: LoadedSection[] = [];
    const seenContent = new Set<string>();

    // Global user instructions first (Codex global AGENTS.md).
    for (const g of this.globalPaths) {
      const loaded = await this.tryLoadFile(g);
      if (!loaded) continue;
      const hash = loaded.content.trim();
      if (seenContent.has(hash)) continue;
      seenContent.add(hash);
      sections.push({ source: `global:${path.basename(g)}`, content: loaded.content });
    }

    const dirs = await this.collectSearchDirs();
    for (const dir of dirs) {
      // Within a directory: if AGENTS.override.md exists, prefer it over AGENTS.md
      // but still load CLAUDE.md / MOSS.md.
      let skipAgentsMd = false;
      for (const candidate of this.candidates) {
        if (candidate === 'AGENTS.md' && skipAgentsMd) continue;
        const filePath = path.join(dir, candidate);
        const loaded = await this.tryLoadFile(filePath);
        if (!loaded) continue;
        if (candidate === 'AGENTS.override.md') skipAgentsMd = true;
        const hash = loaded.content.trim();
        if (seenContent.has(hash)) continue;
        seenContent.add(hash);
        sections.push(loaded);
      }
    }

    if (sections.length === 0) {
      return { agentRules: null, agentRulesSource: null, agentRulesSources: [] };
    }

    const parts: string[] = [];
    let total = 0;
    const included: string[] = [];
    for (const section of sections) {
      const header = `### ${section.source}\n\n`;
      const chunk = header + section.content;
      if (total + chunk.length > MAX_TOTAL_SIZE) {
        const remaining = MAX_TOTAL_SIZE - total - header.length - 32;
        if (remaining < 200) break;
        parts.push(header + section.content.slice(0, remaining) + '\n\n[... truncated]');
        included.push(section.source);
        break;
      }
      parts.push(chunk);
      included.push(section.source);
      total += chunk.length;
    }

    if (this.includeHierarchicalPolicy && included.length > 0) {
      const policy = HIERARCHICAL_AGENTS_POLICY;
      if (total + policy.length + 4 <= MAX_TOTAL_SIZE) {
        parts.push(policy);
      }
    }

    const agentRules = parts.join('\n\n');
    const agentRulesSource =
      included.length === 1 ? included[0]! : included.length <= 3 ? included.join(', ') : 'merged';

    return {
      agentRules,
      agentRulesSource,
      agentRulesSources: included,
    };
  }

  buildPromptLayer(ctx: WorkspaceMemoryContext): string {
    if (!ctx.agentRules) return '';
    const source = ctx.agentRulesSource ?? 'AGENTS.md';
    return `# Project Instructions (${source})\n\n${ctx.agentRules}`;
  }
}
