export {
  MemoryManager,
  MEMORY_INDEX_CHAR_SOFT_LIMIT,
  LEARNING_TOPIC_SLUGS,
  buildMemorySearchQueryVariants,
  validateMemoryWriteContent,
  type LearningTopicSlug,
  type MemoryEntry,
  type MemoryScope,
  type MemorySearchResult,
  type MemorySource,
  type MemoryWriteValidation,
} from './memory-manager.js';

// redactSecretsInText + MEMORY_SECRET_PATTERNS live in the safety base layer
// (see ./memory-manager.ts). Re-exported here for API continuity — memory
// consumers that imported redactSecretsInText from @rdk-moss/agent/memory still work.
export { redactSecretsInText, MEMORY_SECRET_PATTERNS } from '../safety/index.js';

export {
  WorkspaceMemory,
  type WorkspaceMemoryConfig,
  type WorkspaceMemoryContext,
} from './workspace-memory.js';

export {
  selectMemoriesForContext,
  renderMemoryPicksForSystemPrompt,
  type SelectMemoryForContextParams,
  type MemoryContextPick,
} from './memory-context-selector.js';

export {
  buildSelfLearningMemoryDraft,
  buildImplicitLearningDraft,
  type SelfLearningMemoryDraft,
  type ImplicitSignalContext,
} from './self-learning-memory.js';

export {
  assessKnowledgeTurn,
  buildKnowledgeCardDraft,
  classifyLearningTopic,
  coerceLearningTopic,
  type KnowledgeCardDraft,
  type KnowledgeTurnAssessment,
  type KnowledgeTurnInput,
} from './knowledge-card.js';

export { cosineSimilarity, hybridScore } from './memory-embedding.js';
export type { MemoryEmbeddingProvider, EmbeddedMemoryEntry } from './memory-embedding.js';

export {
  LearningEventLog,
  type LearningEvent,
  type LearningOutcome,
  type LearningFailureClass,
} from './learning-event-log.js';
export {
  TrustedLearningCoordinator,
  recallTrustedLearningObservations,
  type TrustedLearningInput,
} from './trusted-learning-coordinator.js';
export {
  isRealEvidenceEligible,
  requiresRealDeviceEvidence,
} from './evidence-trust.js';
export type { ExecutionDomain, EvidenceTrustBoundary } from './evidence-trust.js';
export {
  environmentFingerprint,
  trustedEnvironmentIdentity,
  probeDeviceEnvironmentFacts,
  parseDeviceEnvironmentFacts,
  DEVICE_ENVIRONMENT_IDENTITY_PROBE,
  type DeviceEnvironmentFacts,
  type TrustedEnvironmentIdentity,
} from './environment-fingerprint.js';
export { loadEvolutionConfig, formatEvolutionConfig, type EvolutionConfigResult } from './evolution-config.js';
export {
  readSelfEvolutionSnapshot,
  formatSelfEvolutionStatus,
  formatSelfEvolutionExperiments,
  formatSelfEvolutionPatch,
  type SelfEvolutionSnapshot,
} from './self-evolution-report.js';
export {
  CandidatePatchLog,
  type CandidatePatchRecord,
  type CandidatePatchKind,
  type CandidatePatchState,
} from './candidate-patch-log.js';
export { TrustedPatchCoordinator } from './trusted-patch-coordinator.js';
export {
  RecoveryRecipeLog,
  compileRecoveryRecipe,
  validateRecoveryRecipe,
  validateShadowReplay,
  recoveryRecipeId,
  type RecoveryRecipe,
  type RecoveryRecipeOperation,
  type RecoveryRecipeState,
  type RecoveryRecipeQualityReason,
} from './recovery-recipe-log.js';
export {
  PatchExperimentLog,
  type PatchExperimentRecord,
  type PatchExperimentExposure,
  type PatchExperimentAssignment,
  type PatchExperimentOutcome,
  type PatchExperimentDecision,
  type PatchExperimentArmSummary,
  type PatchExperimentVariant,
  type PatchExperimentLifecycle,
  type PatchExperimentHypothesis,
  type PatchExperimentCostMetric,
} from './patch-experiment-log.js';
export {
  TrustedSkillExperimentCoordinator,
  createPatchExperimentTaskSignature,
  assignPatchExperimentVariant,
  buildTrustedPatchExperimentContext,
  DEFAULT_PATCH_EXPERIMENT_THRESHOLDS,
  type PatchExperimentThresholds,
  type PreparedPatchExperiment,
} from './trusted-skill-experiment-coordinator.js';
export {
  TrustedAgentAbRunner,
  type TrustedAgentAbTask,
  type TrustedAgentAbExecutionInput,
  type TrustedAgentAbExecutionResult,
  type TrustedAgentAbRunSummary,
} from './trusted-agent-ab-runner.js';
