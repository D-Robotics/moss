



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
  enabled: boolean;
  updatedAt: number;
  /** Optional inlined SKILL.md body (frontmatter-stripped instruction text).
   *  Used by builtin skills that have no readable file (builtin:// sourcePath)
   *  so matched-skill context injection has real instructions, not just a
   *  description. File-backed skills leave this unset and read from disk. */
  body?: string;
}
