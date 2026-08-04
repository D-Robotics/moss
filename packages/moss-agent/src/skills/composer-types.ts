import type { SkillMeta } from './types.js';

export type SkillComposerProviderMode =
  | 'legacy'
  | 'rules'
  | 'local-model'
  | 'remote-model'
  | 'auto';

export type SkillComposerPlanProvider =
  | 'legacy'
  | 'rules'
  | 'local-model'
  | 'remote-model'
  | 'fallback';

export interface SkillEnvironmentContext {
  deployment?: 'host' | 'board' | 'host-controls-board';
  hasBoard?: boolean;
  networkAllowed?: boolean;
  availablePermissions?: Array<'workspace_read' | 'workspace_write' | 'device_exec' | 'network'>;
  platform?: string;
  modelArtifactsAvailable?: boolean;
  localModelRuntimeAvailable?: boolean;
  localModelEstimatedMemoryMb?: number;
  availableMemoryMb?: number;
}

export interface SkillComposeInput {
  task: string;
  environment: SkillEnvironmentContext;
  skills: SkillMeta[];
  maxSkills: number;
  registryDigest?: string;
}

export interface SkillCandidateScore {
  stableId: string;
  name: string;
  score: number;
  reasonCodes: string[];
}

export interface PlannedSkill {
  stableId: string;
  name: string;
  score: number;
  reasonCode: string;
}

export interface SkillPlanDiagnostics {
  candidateScores?: SkillCandidateScore[];
  excluded?: Array<{ name: string; reason: string }>;
  warnings?: string[];
  fallbackReason?: string;
  rejectionReason?: string;
  registryDigest?: string;
  latencyMs?: number;
  injectedChars?: number;
}

export interface SkillPlan {
  skills: PlannedSkill[];
  confidence: number;
  rejected: boolean;
  provider: SkillComposerPlanProvider;
  diagnostics?: SkillPlanDiagnostics;
}

export interface SkillComposer {
  readonly provider: Exclude<SkillComposerPlanProvider, 'fallback'>;
  compose(input: SkillComposeInput, signal?: AbortSignal): Promise<SkillPlan>;
}

export interface SkillComposerConfig {
  enabled: boolean;
  mode: SkillComposerProviderMode;
  shadowMode: boolean;
  shadowProvider?: Exclude<SkillComposerProviderMode, 'legacy' | 'auto'>;
  maxSkills: number;
  candidateLimit: number;
  deadlineMs: number;
  minScore: number;
  minConfidence: number;
  maxMemoryMb?: number;
  localModelEnabled: boolean;
  remoteModelEnabled: boolean;
}

export interface SkillComposerProviderCapabilities {
  localModelRuntimeAvailable?: boolean;
  modelArtifactsAvailable?: boolean;
  networkAllowed?: boolean;
  availableMemoryMb?: number;
  /** Estimated resident memory required by the configured local provider. */
  localModelEstimatedMemoryMb?: number;
}

export type SkillComposerProviderFactory = () => SkillComposer | Promise<SkillComposer>;
