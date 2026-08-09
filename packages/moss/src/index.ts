export type {
  KnowledgeModule,
  DeviceProfileBase,
  CameraInterface,
  GpioSpec,
  DocIndexEntry,
  PromptFragment,
  CommandPattern,
  FailureHint,
  EndorsedSkillRef,
  KnowledgeSourceRef,
  KnowledgeCompatibilityScope,
  KnowledgeChunkPolicy,
  KnowledgeRecordMetadata,
} from './contracts/knowledge-module.js';

export type {
  MossPromptContributor,
  MossToolContributor,
  MossVendorPlugin,
} from './contracts/vendor-plugin.js';

export type {
  MossPlatformExtensionIdentities,
  MossPlatformExtension,
} from './contracts/platform-extension.js';

export type { DeviceFamily } from './contracts/device-family.js';

export {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  MOSS_HOST_CAPABILITY_COVERAGE_PRIORITIES,
  MOSS_HOST_CAPABILITY_COVERAGE_STATUSES,
  MOSS_HOST_CAPABILITY_COVERAGE_STATUS_DEFINITIONS,
  MOSS_HOST_CHANNEL_BACKPLANE_CAPABILITIES,
  MOSS_HOST_EFFECTIVE_TOOL_NOTICE_CODES,
  MOSS_HOST_TASK_SURFACE_CAPABILITIES,
  MOSS_HOST_TOOL_RESULT_SURFACES,
  MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES,
  MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS,
  MOSS_HOST_TOOL_SURFACE_KINDS,
  buildMossHostEffectiveToolInventory,
  evaluateMossHostCompatibility,
  projectMossHostRuntimeCapabilities,
} from './contracts/host-adapter.js';
export type { MossSoul } from './contracts/soul.js';
export type {
  MossHostAdapterContractVersion,
  MossHostCapabilityCoveragePriority,
  MossHostCapabilityCoverageRef,
  MossHostCapabilityCoverageStatus,
  MossHostCapabilityKind,
  MossHostCapabilityRef,
  MossHostCapabilityStability,
  MossHostCompatibilityReport,
  MossHostCompatibilityRequirement,
  MossHostCompatibilityStatus,
  MossHostEffectiveToolInventory,
  MossHostEffectiveToolInventoryContext,
  MossHostEffectiveToolNotice,
  MossHostEffectiveToolNoticeCode,
  MossHostEffectiveToolNoticeSeverity,
  MossHostEffectiveToolRef,
  MossHostEffectiveToolSurfaceRef,
  MossHostEventSinkRef,
  MossHostKnowledgeRef,
  MossHostMemoryProviderRef,
  MossHostSkillStoreRef,
  MossHostChannelBackplaneCapability,
  MossHostPackageRef,
  MossHostProviderRef,
  MossHostRuntimeManifest,
  MossHostRuntimeCapabilityProjection,
  MossHostTaskSurfaceCapability,
  MossHostToolResultSurface,
  MossHostToolRef,
  MossHostToolSurfaceProgressMode,
  MossHostToolSurfaceReadinessSignal,
  MossHostToolSurfaceRef,
  MossHostToolSurfaceKind,
} from './contracts/host-adapter.js';

export {
  InMemoryMossAsyncTaskRegistry,
  createInMemoryMossAsyncTaskRegistry,
} from './contracts/async-task.js';
export type {
  InMemoryMossAsyncTaskRegistryOptions,
  MossAsyncTaskCompletion,
  MossAsyncTaskHandle,
  MossAsyncTaskKind,
  MossAsyncTaskProgress,
  MossAsyncTaskRegistry,
  MossAsyncTaskResult,
  MossAsyncTaskRunner,
  MossAsyncTaskSnapshot,
  MossAsyncTaskStartRequest,
  MossAsyncTaskStatus,
  MossAsyncTaskStopReason,
  MossAsyncTaskUpdate,
} from './contracts/async-task.js';

export { DEFAULT_MODEL } from './constants.js';

export {
  buildRoboticsEngineeringPrompt,
  buildRoboticsEngineeringPromptQuick,
} from './prompts/robotics-engineering-prompt.js';

export {
  buildSoftwareEngineeringPrompt,
  buildSoftwareEngineeringPromptQuick,
} from './prompts/software-engineering-prompt.js';

export {
  buildAgentBehaviorPrompt,
  buildAgentBehaviorPromptQuick,
} from './prompts/agent-behavior-prompt.js';

export {
  buildLanguagePolicyPrompt,
  buildLanguagePolicyPromptQuick,
} from './prompts/language-policy-prompt.js';
