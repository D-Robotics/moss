



export interface SkillPermission {
  workspaceRead?: boolean;
  workspaceWrite?: boolean;
  deviceExec?: boolean;
  network?: boolean;
}

export interface SkillRuntimePolicy {
  delegatePreference?: 'local' | 'board' | 'hybrid' | 'collaborative';
  requiresBoard?: boolean;
  approvalLevel?: 'none' | 'confirm' | 'strict';
  cooldownSeconds?: number;
  schedulerTemplate?: string;
}

export type SkillDependencyKind = 'requires' | 'before' | 'after' | 'conflicts';

export interface SkillRegistryDiagnostic {
  code:
    | 'duplicate-stable-id'
    | 'unknown-reference'
    | 'self-reference'
    | 'dependency-cycle'
    | 'invalid-metadata';
  skill: string;
  message: string;
  reference?: string;
  kind?: SkillDependencyKind;
}

export interface SkillMeta {
  name: string;
  description: string;
  sourcePath: string;
  version: string;
  tags: string[];
  trigger: string[];
  risk: 'low' | 'medium' | 'high';
  permissions: SkillPermission;
  runtimePolicy?: SkillRuntimePolicy;
  /** Stable plan/cache identity. Derived from source scope + name when omitted. */
  stableId?: string;
  /** Hash of the current instructions/metadata; changes do not change stableId. */
  contentHash?: string;
  /** Compact retrieval text that does not require loading the full body. */
  summary?: string;
  inputs?: string[];
  outputs?: string[];
  requires?: string[];
  before?: string[];
  after?: string[];
  conflicts?: string[];
  enabled: boolean;
  updatedAt: number;
  /** Optional inlined SKILL.md body (frontmatter-stripped instruction text).
   *  Used by builtin skills that have no readable file (builtin:// sourcePath)
   *  so matched-skill context injection has real instructions, not just a
   *  description. File-backed skills leave this unset and read from disk. */
  body?: string;
}

export interface SkillRegistrySnapshot {
  digest: string;
  skills: SkillMeta[];
  diagnostics: SkillRegistryDiagnostic[];
}
