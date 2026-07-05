import type { SkillMeta } from './types.js';

const BUILTIN_UPDATED_AT = 0;

export const BUILTIN_SKILLS: SkillMeta[] = [
  {
    name: 'superpower-methodical-builder',
    description:
      'Use for substantial coding, product, architecture, UX, model-selection, or quality-critical work: define done, compare paths, implement cleanly, and verify.',
    sourcePath: 'builtin://superpower-methodical-builder/SKILL.md',
    version: '1.0.0',
    tags: ['superpower', 'planning', 'architecture', 'verification'],
    trigger: [
      'substantial work',
      'architecture',
      'multi-file',
      'quality-critical',
      'methodical-builder',
    ],
    risk: 'low',
    permissions: {},
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
  {
    name: 'superpower-systematic-debugging',
    description:
      'Use when fixing bugs, regressions, test failures, or unexpected behavior: reproduce, minimize, identify root cause, fix narrowly, and add regression coverage.',
    sourcePath: 'builtin://superpower-systematic-debugging/SKILL.md',
    version: '1.0.0',
    tags: ['superpower', 'debugging', 'bugfix', 'regression'],
    trigger: ['bug', 'failure', 'regression', 'unexpected behavior', 'systematic-debugging'],
    risk: 'low',
    permissions: {},
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
  {
    name: 'superpower-test-driven-development',
    description:
      'Use for behavior changes and bug fixes: write or identify a failing test before production code, make it pass, then refactor while green.',
    sourcePath: 'builtin://superpower-test-driven-development/SKILL.md',
    version: '1.0.0',
    tags: ['superpower', 'tdd', 'testing', 'bugfix'],
    trigger: ['tdd', 'test first', 'failing test', 'behavior change', 'bug fix'],
    risk: 'low',
    permissions: {},
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
  {
    name: 'moss-upgrade-and-migration-contract',
    description:
      'Use when changing workspace storage, paths, config, generated runtime folders, or upgrade behavior: preserve user data, migrate or read-through legacy locations, update every reader/writer, and add regression coverage.',
    sourcePath: 'builtin://moss-upgrade-and-migration-contract/SKILL.md',
    version: '1.0.0',
    tags: ['migration', 'upgrade', 'compatibility', 'workspace-data'],
    trigger: [
      'migration',
      'path migration',
      'workspace storage',
      'config path',
      'upgrade',
      'backward compatibility',
      'user data',
    ],
    risk: 'medium',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'confirm' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
  {
    name: 'codegraph-structural-navigation',
    description:
      'Use CodeGraph for structural code navigation when codegraph_* tools are available: definitions, callers, callees, traces, impact, and focused context.',
    sourcePath: 'builtin://codegraph-structural-navigation/SKILL.md',
    version: '1.0.0',
    tags: ['codegraph', 'structural-search', 'callgraph', 'impact'],
    trigger: ['codegraph', 'callers', 'callees', 'trace', 'impact radius', 'where is defined'],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
  {
    name: 'code-review',
    description:
      'Use for structured code review: read the diff, check for bugs, security issues, naming, simplicity, test coverage, and return findings with severity. Use verify_fix after applying any review-driven changes.',
    sourcePath: 'builtin://code-review/SKILL.md',
    version: '1.0.0',
    tags: ['review', 'quality', 'security', 'bugs', 'best-practices'],
    trigger: ['code review', 'review this', 'review the code', 'audit', 'check for bugs'],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
  {
    name: 'git-workflow',
    description:
      'Use for Git operations: branch, commit (conventional commits), diff, log, merge, rebase, stash. Provides structured commit messages and branch naming conventions.',
    sourcePath: 'builtin://git-workflow/SKILL.md',
    version: '1.0.0',
    tags: ['git', 'vcs', 'commit', 'branch', 'merge', 'rebase'],
    trigger: ['git', 'commit', 'branch', 'merge', 'rebase', 'stash', 'diff', 'pull request'],
    risk: 'medium',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'confirm' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
  {
    name: 'refactoring',
    description:
      'Use for code refactoring: identify code smells, write/verify tests, make small incremental changes, and verify after each step.',
    sourcePath: 'builtin://refactoring/SKILL.md',
    version: '1.0.0',
    tags: ['refactoring', 'clean-code', 'maintainability'],
    trigger: ['refactor', 'clean up', 'simplify', 'extract method', 'rename', 'code smell'],
    risk: 'low',
    permissions: { workspaceRead: true, workspaceWrite: true },
    runtimePolicy: { delegatePreference: 'local', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
  {
    name: 'documentation',
    description:
      'Use for generating or updating documentation: API docs, README, CHANGELOG, inline comments, and architecture docs.',
    sourcePath: 'builtin://documentation/SKILL.md',
    version: '1.0.0',
    tags: ['documentation', 'docs', 'readme', 'changelog', 'api'],
    trigger: ['document', 'docs', 'readme', 'api doc', 'changelog', 'comment'],
    risk: 'low',
    permissions: { workspaceRead: true },
    runtimePolicy: { delegatePreference: 'hybrid', approvalLevel: 'none' },
    enabled: true,
    updatedAt: BUILTIN_UPDATED_AT,
  },
];

export function listBuiltinSkills(): SkillMeta[] {
  return BUILTIN_SKILLS.map((skill) => ({
    ...skill,
    tags: [...skill.tags],
    trigger: [...skill.trigger],
    permissions: { ...skill.permissions },
    runtimePolicy: skill.runtimePolicy ? { ...skill.runtimePolicy } : undefined,
  }));
}
