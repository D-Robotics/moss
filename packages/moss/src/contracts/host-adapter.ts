/** Current Host Adapter contract version. Bumping this requires a minor+ version bump of @rdk-moss/core. @public */
export const MOSS_HOST_ADAPTER_CONTRACT_VERSION = 1;

/** Numeric type for the Host Adapter contract version. @public */
export type MossHostAdapterContractVersion = number;

/** Stability level of a host capability. @public */
export type MossHostCapabilityStability = 'stable' | 'evolving' | 'experimental';

/** Kinds of capabilities a host can declare. See docs/host-adapter-contract.md. @public */
export type MossHostCapabilityKind =
  | 'llm_provider'
  | 'tool_registry'
  | 'approval_gate'
  | 'event_sink'
  | 'workspace'
  | 'memory'
  | 'knowledge'
  | 'prompt_context'
  | 'skill_runtime'
  | 'artifact_runtime'
  | 'device_runtime'
  | 'channel_runtime'
  | 'telemetry';

/** Reference to a Moss package (name + version + stability). @public */
export interface MossHostPackageRef {
  name: string;
  version: string;
  stability: MossHostCapabilityStability;
}

/** Reference to an LLM provider declared by the host. @public */
export interface MossHostProviderRef {
  id: string;
  displayName?: string;
  families: readonly string[];
  configuredByHost: boolean;
  streaming: boolean;
  toolCalling: boolean;
}

/** Tool surface kinds declared by a host. Each surface groups tools that share a user-facing interaction modality. @public */
export const MOSS_HOST_TOOL_SURFACE_KINDS = [
  'computer_workspace',
  'computer_shell',
  'browser_web',
  'attachment_media',
  'board_device',
  'robotics_runtime',
  'channel_messaging',
  'task_subagent',
  'memory_skill',
  'openclaw_channel',
] as const;

/** Union type derived from {@link MOSS_HOST_TOOL_SURFACE_KINDS}. @public */
export type MossHostToolSurfaceKind = (typeof MOSS_HOST_TOOL_SURFACE_KINDS)[number];

/** Result surfaces where tool output can be delivered. @public */
export const MOSS_HOST_TOOL_RESULT_SURFACES = [
  'assistant_text',
  'timeline_summary',
  'terminal_output',
  'artifact',
  'media_or_file',
  'channel_delivery',
  'background_task',
] as const;

/** Union type derived from {@link MOSS_HOST_TOOL_RESULT_SURFACES}. @public */
export type MossHostToolResultSurface = (typeof MOSS_HOST_TOOL_RESULT_SURFACES)[number];

/** Progress reporting modes a tool surface can support. @public */
export const MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES = [
  'none',
  'event_sink',
  'streaming',
  'background_task',
] as const;

/** Union type derived from {@link MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES}. @public */
export type MossHostToolSurfaceProgressMode =
  (typeof MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES)[number];

/** Capabilities a task surface (subagent) tool can declare. @public */
export const MOSS_HOST_TASK_SURFACE_CAPABILITIES = [
  'start',
  'status',
  'wait',
  'control',
  'completion',
] as const;

/** Union type derived from {@link MOSS_HOST_TASK_SURFACE_CAPABILITIES}. @public */
export type MossHostTaskSurfaceCapability = (typeof MOSS_HOST_TASK_SURFACE_CAPABILITIES)[number];

/** Capabilities a channel backplane tool can declare. @public */
export const MOSS_HOST_CHANNEL_BACKPLANE_CAPABILITIES = [
  'status',
  'health',
  'chat',
  'delegate',
  'configure',
  'pairing',
  'skills',
  'logs',
  'fleet',
] as const;

/** Union type derived from {@link MOSS_HOST_CHANNEL_BACKPLANE_CAPABILITIES}. @public */
export type MossHostChannelBackplaneCapability =
  (typeof MOSS_HOST_CHANNEL_BACKPLANE_CAPABILITIES)[number];

/** Readiness signals a tool surface can require before its tools become effective. @public */
export const MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS = [
  'always_available',
  'workspace_selected',
  'network_enabled',
  'attachment_context',
  'channel_configured',
  'device_selected',
  'device_reachable',
  'robotics_runtime_detected',
  'openclaw_gateway_ready',
  'approval_required',
] as const;

/** Union type derived from {@link MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS}. @public */
export type MossHostToolSurfaceReadinessSignal =
  (typeof MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS)[number];

/** Priority levels for capability coverage entries. @public */
export const MOSS_HOST_CAPABILITY_COVERAGE_PRIORITIES = ['P0', 'P1', 'P2'] as const;

/** Union type derived from {@link MOSS_HOST_CAPABILITY_COVERAGE_PRIORITIES}. @public */
export type MossHostCapabilityCoveragePriority =
  (typeof MOSS_HOST_CAPABILITY_COVERAGE_PRIORITIES)[number];

/** Statuses a capability coverage entry can have. @public */
export const MOSS_HOST_CAPABILITY_COVERAGE_STATUSES = [
  'covered',
  'partial',
  'deferred',
  'not_exposed',
] as const;

/** Union type derived from {@link MOSS_HOST_CAPABILITY_COVERAGE_STATUSES}. @public */
export type MossHostCapabilityCoverageStatus =
  (typeof MOSS_HOST_CAPABILITY_COVERAGE_STATUSES)[number];

/** Notice codes explaining why a declared tool is not effective. @public */
export const MOSS_HOST_EFFECTIVE_TOOL_NOTICE_CODES = [
  'manifest_invalid',
  'runtime_unknown_tool',
  'surface_readiness_missing',
  'surface_without_effective_tools',
  'tool_disabled_by_runtime',
  'tool_denied_by_policy',
  'tool_hidden_by_profile',
] as const;

/** Union type derived from {@link MOSS_HOST_EFFECTIVE_TOOL_NOTICE_CODES}. @public */
export type MossHostEffectiveToolNoticeCode =
  (typeof MOSS_HOST_EFFECTIVE_TOOL_NOTICE_CODES)[number];

/** Severity of an effective-tool notice. @public */
export type MossHostEffectiveToolNoticeSeverity = 'info' | 'warning' | 'error';

/** A notice explaining why a declared tool is not effective in the current session. @public */
export interface MossHostEffectiveToolNotice {
  code: MossHostEffectiveToolNoticeCode;
  severity: MossHostEffectiveToolNoticeSeverity;
  message: string;
  tool?: string;
  surface?: MossHostToolSurfaceKind;
  readinessSignal?: MossHostToolSurfaceReadinessSignal;
}

/** Human-readable definitions for each capability coverage status. @public */
export const MOSS_HOST_CAPABILITY_COVERAGE_STATUS_DEFINITIONS = {
  covered: 'The host registers the named tools and may advertise the user outcome without caveats.',
  partial: 'The host registers some supporting tools, but gaps name behavior Moss must not assume.',
  deferred:
    'The capability is a deliberate roadmap item and must not be advertised through tool surfaces yet.',
  not_exposed:
    'The capability exists elsewhere but is intentionally absent from this host runtime.',
} as const satisfies Record<MossHostCapabilityCoverageStatus, string>;

/** Declares a tool surface with its readiness signals, progress mode, and primary tools. @public */
export interface MossHostToolSurfaceRef {
  kind: MossHostToolSurfaceKind;
  summary: string;
  readiness: readonly MossHostToolSurfaceReadinessSignal[];
  progressMode: MossHostToolSurfaceProgressMode;
  primaryTools: readonly string[];
  healthTools?: readonly string[];
  fallbackSurfaces?: readonly MossHostToolSurfaceKind[];
  resultSurfaces?: readonly MossHostToolResultSurface[];
}

const MOSS_HOST_TOOL_SIDE_EFFECT_CLASSES = [
  'readonly',
  'local_write',
  'device_mutation',
  'credential',
  'external_message',
  'memory_write',
  'runtime_state',
  'subagent',
] as const;

const MOSS_HOST_TOOL_APPROVAL_POLICIES = ['not_required', 'plan_audit', 'execute_audit'] as const;

const MOSS_HOST_TOOL_SOURCES = ['moss', 'host', 'extension'] as const;

/** Declares a tool: name, boundary, side-effect class, approval policy, source, and optional surface/result metadata. @public */
export interface MossHostToolRef {
  name: string;
  boundaryId: string;
  sideEffectClass:
    | 'readonly'
    | 'local_write'
    | 'device_mutation'
    | 'credential'
    | 'external_message'
    | 'memory_write'
    | 'runtime_state'
    | 'subagent';
  approval: 'not_required' | 'plan_audit' | 'execute_audit';
  source: 'moss' | 'host' | 'extension';

  surface?: MossHostToolSurfaceKind;

  resultSurface?: MossHostToolResultSurface;

  taskSurfaceCapability?: MossHostTaskSurfaceCapability;
  taskSurfaceCapabilities?: readonly MossHostTaskSurfaceCapability[];

  channelBackplaneCapability?: MossHostChannelBackplaneCapability;
  channelBackplaneCapabilities?: readonly MossHostChannelBackplaneCapability[];
}

/** Reference to an event sink declared by the host. @public */
export interface MossHostEventSinkRef {
  id: string;
  schemas: readonly string[];
  supportsStreaming: boolean;
}

/** Reference to a knowledge module declared by the host. @public */
export interface MossHostKnowledgeRef {
  id: string;
  version: string;
  stability: MossHostCapabilityStability;
}

/** Reference to a memory provider declared by the host. @public */
export interface MossHostMemoryProviderRef {
  id: string;
  version: string;
  stability: MossHostCapabilityStability;
}

/** Reference to a skill store declared by the host. @public */
export interface MossHostSkillStoreRef {
  id: string;
  version: string;
  stability: MossHostCapabilityStability;
}

/** Declares a host capability with version, stability, and summary. @public */
export interface MossHostCapabilityRef {
  kind: MossHostCapabilityKind;
  version: string;
  stability: MossHostCapabilityStability;
  summary: string;
  optional?: boolean;
}

/** Documents how a capability is covered by declared tools, including evidence and gaps. @public */
export interface MossHostCapabilityCoverageRef {
  id: string;
  priority: MossHostCapabilityCoveragePriority;
  status: MossHostCapabilityCoverageStatus;
  userOutcome: string;
  surface?: MossHostToolSurfaceKind;
  surfaces?: readonly MossHostToolSurfaceKind[];
  tools: readonly string[];
  evidence: readonly string[];
  gaps: readonly string[];
  rationale: string;
}

/** The complete host-adapter manifest: schema version, host info, moss packages, capabilities, providers, tools, surfaces, event sinks, knowledge modules, and skill store. See docs/host-adapter-contract.md. @public */
export interface MossHostRuntimeManifest {
  schema: 'moss_host_adapter.v1';
  contractVersion: MossHostAdapterContractVersion;
  host: {
    id: string;
    name: string;
    version: string;
  };
  moss: {
    version: string;
    packages: readonly MossHostPackageRef[];
  };
  capabilities: readonly MossHostCapabilityRef[];
  providers: readonly MossHostProviderRef[];

  toolSurfaces?: readonly MossHostToolSurfaceRef[];
  tools: readonly MossHostToolRef[];

  capabilityCoverage?: readonly MossHostCapabilityCoverageRef[];
  eventSinks: readonly MossHostEventSinkRef[];

  memoryProvider?: MossHostMemoryProviderRef;

  knowledgeModules: readonly MossHostKnowledgeRef[];

  skillStore?: MossHostSkillStoreRef;
}

/** Requirements that moss checks against a host manifest. All fields are optional; unspecified fields are not checked. @public */
export interface MossHostCompatibilityRequirement {
  minHostVersion?: string;
  contractVersion?: MossHostAdapterContractVersion;
  minContractVersion?: MossHostAdapterContractVersion;
  maxContractVersion?: MossHostAdapterContractVersion;
  requiredCapabilities?: readonly MossHostCapabilityKind[];
  requiredToolSurfaces?: readonly MossHostToolSurfaceKind[];
  requiredToolSurfaceDetails?: readonly MossHostToolSurfaceKind[];
  requiredTaskSurfaceCapabilities?: readonly MossHostTaskSurfaceCapability[];
  requiredChannelBackplaneCapabilities?: readonly MossHostChannelBackplaneCapability[];
  requiredEventSchemas?: readonly string[];
  requiredProviderFamilies?: readonly string[];
}

/** Result status of a compatibility check. @public */
export type MossHostCompatibilityStatus =
  | 'ok'
  | 'invalid_manifest'
  | 'host_version_incompatible'
  | 'contract_mismatch'
  | 'missing_capability'
  | 'missing_event_schema'
  | 'missing_provider_family';

/** Result of evaluating a host manifest against compatibility requirements. @public */
export interface MossHostCompatibilityReport {
  compatible: boolean;
  status: MossHostCompatibilityStatus;
  reasons: readonly string[];
  missingCapabilities: readonly MossHostCapabilityKind[];
  missingToolSurfaces: readonly MossHostToolSurfaceKind[];
  missingToolSurfaceDetails: readonly MossHostToolSurfaceKind[];
  missingTaskSurfaceCapabilities: readonly MossHostTaskSurfaceCapability[];
  missingChannelBackplaneCapabilities: readonly MossHostChannelBackplaneCapability[];
  missingEventSchemas: readonly string[];
  missingProviderFamilies: readonly string[];
}

/** Runtime context for building the effective tool inventory: readiness signals and disabled/denied/hidden tool sets. @public */
export interface MossHostEffectiveToolInventoryContext {
  readySignals?: readonly MossHostToolSurfaceReadinessSignal[];

  disabledTools?: readonly string[];

  policyDeniedTools?: readonly string[];

  profileHiddenTools?: readonly string[];
}

/** A tool reference annotated with whether it is effective and any unavailability notices. @public */
export interface MossHostEffectiveToolRef extends MossHostToolRef {
  effective: boolean;
  unavailableReasons: readonly MossHostEffectiveToolNotice[];
}

/** A tool surface reference annotated with effective/unavailable tools and notices. @public */
export interface MossHostEffectiveToolSurfaceRef extends MossHostToolSurfaceRef {
  effective: boolean;
  effectiveTools: readonly string[];
  unavailableTools: readonly string[];
  notices: readonly MossHostEffectiveToolNotice[];
}

/** The effective tool inventory: which declared tools and surfaces are actually available given runtime context. @public */
export interface MossHostEffectiveToolInventory {
  valid: boolean;
  notices: readonly MossHostEffectiveToolNotice[];
  tools: readonly MossHostEffectiveToolRef[];
  toolSurfaces: readonly MossHostEffectiveToolSurfaceRef[];
}

/** Projected capability summary extracted from a manifest for compatibility checking. @public */
export interface MossHostRuntimeCapabilityProjection {
  capabilityKinds: readonly MossHostCapabilityKind[];
  toolSurfaces: readonly MossHostToolSurfaceKind[];
  toolSurfaceDetails: readonly MossHostToolSurfaceKind[];
  taskSurfaceCapabilities: readonly MossHostTaskSurfaceCapability[];
  channelBackplaneCapabilities: readonly MossHostChannelBackplaneCapability[];
  eventSchemas: readonly string[];
  providerFamilies: readonly string[];
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T
): value is T[number] {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}

function validateMossCapabilityCoverageShape(
  coverage: unknown,
  tools: readonly unknown[]
): string | null {
  if (coverage === undefined) return null;
  if (!Array.isArray(coverage)) {
    return 'manifest.capabilityCoverage must be an array when present';
  }

  const toolsByName = new Map<string, Record<string, unknown>>();
  for (const tool of tools) {
    if (isRecord(tool) && typeof tool.name === 'string') {
      toolsByName.set(tool.name, tool);
    }
  }

  const ids = new Set<string>();
  for (const entry of coverage) {
    if (!isRecord(entry)) {
      return 'manifest.capabilityCoverage must be an array of coverage records';
    }
    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      return 'manifest.capabilityCoverage[].id must be a non-empty string';
    }
    if (ids.has(entry.id)) {
      return `manifest.capabilityCoverage[].id must be unique: ${entry.id}`;
    }
    ids.add(entry.id);
    if (!isOneOf(entry.priority, MOSS_HOST_CAPABILITY_COVERAGE_PRIORITIES)) {
      return 'manifest.capabilityCoverage[].priority must be P0, P1, or P2';
    }
    if (!isOneOf(entry.status, MOSS_HOST_CAPABILITY_COVERAGE_STATUSES)) {
      return 'manifest.capabilityCoverage[].status must be a known coverage status';
    }
    if (typeof entry.userOutcome !== 'string' || !entry.userOutcome.trim()) {
      return 'manifest.capabilityCoverage[].userOutcome must be a non-empty string';
    }
    if (typeof entry.rationale !== 'string' || !entry.rationale.trim()) {
      return 'manifest.capabilityCoverage[].rationale must be a non-empty string';
    }
    if (entry.surface !== undefined && !isOneOf(entry.surface, MOSS_HOST_TOOL_SURFACE_KINDS)) {
      return 'manifest.capabilityCoverage[].surface must be a known tool surface';
    }
    if (
      entry.surfaces !== undefined &&
      (!Array.isArray(entry.surfaces) ||
        !entry.surfaces.every((item) => isOneOf(item, MOSS_HOST_TOOL_SURFACE_KINDS)))
    ) {
      return 'manifest.capabilityCoverage[].surfaces must contain known tool surfaces';
    }
    if (!isStringArray(entry.tools)) {
      return 'manifest.capabilityCoverage[].tools must be a string array';
    }
    if (!isStringArray(entry.evidence) || entry.evidence.length === 0) {
      return 'manifest.capabilityCoverage[].evidence must be a non-empty string array';
    }
    if (!entry.evidence.every((item) => item.trim())) {
      return 'manifest.capabilityCoverage[].evidence entries must be non-empty';
    }
    if (!isStringArray(entry.gaps)) {
      return 'manifest.capabilityCoverage[].gaps must be a string array';
    }

    const status = entry.status as MossHostCapabilityCoverageStatus;
    if (status === 'covered') {
      if (entry.tools.length === 0) {
        return `covered capability must cite backing tools: ${entry.id}`;
      }
      if (entry.gaps.length > 0) {
        return `covered capability must not carry unresolved gaps: ${entry.id}`;
      }
    } else if (status === 'partial') {
      if (entry.tools.length === 0) {
        return `partial capability must cite existing backing tools: ${entry.id}`;
      }
      if (entry.gaps.length === 0) {
        return `partial capability must name remaining gaps: ${entry.id}`;
      }
    } else {
      if (entry.tools.length > 0) {
        return `deferred/not_exposed capability must not advertise tools: ${entry.id}`;
      }
      if (entry.gaps.length === 0) {
        return `deferred/not_exposed capability must name why it is unavailable: ${entry.id}`;
      }
    }

    const entrySurfaces = new Set<MossHostToolSurfaceKind>([
      ...(typeof entry.surface === 'string' ? [entry.surface] : []),
      ...(Array.isArray(entry.surfaces)
        ? entry.surfaces.filter((item): item is MossHostToolSurfaceKind => typeof item === 'string')
        : []),
    ]);
    for (const toolName of entry.tools) {
      const tool = toolsByName.get(toolName);
      if (!tool) {
        return `manifest.capabilityCoverage[].tools references unknown tool: ${entry.id} -> ${toolName}`;
      }
      const toolSurface = tool.surface;
      if (entrySurfaces.size > 0) {
        if (!isOneOf(toolSurface, MOSS_HOST_TOOL_SURFACE_KINDS)) {
          return `manifest.capabilityCoverage[].tools references tool without declared surface: ${entry.id} -> ${toolName}`;
        }
        if (!entrySurfaces.has(toolSurface)) {
          return `manifest.capabilityCoverage[].tools references tool from different surface: ${entry.id} -> ${toolName} (${tool.surface})`;
        }
      }
    }
  }

  return null;
}

function validateMossHostManifestShape(manifest: unknown): string | null {
  if (!isRecord(manifest)) return 'manifest must be an object';
  if (manifest.schema !== 'moss_host_adapter.v1') {
    return 'manifest.schema must be moss_host_adapter.v1';
  }
  if (typeof manifest.contractVersion !== 'number') {
    return 'manifest.contractVersion must be a number';
  }

  if (!isRecord(manifest.host)) return 'manifest.host must be an object';
  if (
    typeof manifest.host.id !== 'string' ||
    typeof manifest.host.name !== 'string' ||
    typeof manifest.host.version !== 'string'
  ) {
    return 'manifest.host must include string id, name, and version';
  }

  if (!isRecord(manifest.moss)) return 'manifest.moss must be an object';
  if (typeof manifest.moss.version !== 'string' || !Array.isArray(manifest.moss.packages)) {
    return 'manifest.moss must include string version and packages array';
  }

  if (!Array.isArray(manifest.capabilities)) return 'manifest.capabilities must be an array';
  if (
    manifest.capabilities.some(
      (capability) =>
        !isRecord(capability) ||
        typeof capability.kind !== 'string' ||
        typeof capability.version !== 'string' ||
        typeof capability.stability !== 'string' ||
        typeof capability.summary !== 'string'
    )
  ) {
    return 'manifest.capabilities must be an array of capability records';
  }

  if (!Array.isArray(manifest.providers)) return 'manifest.providers must be an array';
  if (
    manifest.providers.some(
      (provider) =>
        !isRecord(provider) ||
        typeof provider.id !== 'string' ||
        !isStringArray(provider.families) ||
        typeof provider.configuredByHost !== 'boolean' ||
        typeof provider.streaming !== 'boolean' ||
        typeof provider.toolCalling !== 'boolean'
    )
  ) {
    return 'manifest.providers must be an array of provider records';
  }

  if (!Array.isArray(manifest.tools)) return 'manifest.tools must be an array';
  if (
    manifest.tools.some(
      (tool) =>
        !isRecord(tool) ||
        typeof tool.name !== 'string' ||
        typeof tool.boundaryId !== 'string' ||
        typeof tool.sideEffectClass !== 'string' ||
        typeof tool.approval !== 'string' ||
        typeof tool.source !== 'string'
    )
  ) {
    return 'manifest.tools must be an array of tool records';
  }
  for (const tool of manifest.tools) {
    if (!isRecord(tool)) continue;
    if (!isOneOf(tool.sideEffectClass, MOSS_HOST_TOOL_SIDE_EFFECT_CLASSES)) {
      return 'manifest.tools[].sideEffectClass must be a known side-effect class';
    }
    if (!isOneOf(tool.approval, MOSS_HOST_TOOL_APPROVAL_POLICIES)) {
      return 'manifest.tools[].approval must be a known approval policy';
    }
    if (!isOneOf(tool.source, MOSS_HOST_TOOL_SOURCES)) {
      return 'manifest.tools[].source must be a known tool source';
    }
    if (tool.surface !== undefined && !isOneOf(tool.surface, MOSS_HOST_TOOL_SURFACE_KINDS)) {
      return 'manifest.tools[].surface must be a known tool surface';
    }
    if (
      tool.resultSurface !== undefined &&
      !isOneOf(tool.resultSurface, MOSS_HOST_TOOL_RESULT_SURFACES)
    ) {
      return 'manifest.tools[].resultSurface must be a known result surface';
    }
    if (
      tool.taskSurfaceCapability !== undefined &&
      !isOneOf(tool.taskSurfaceCapability, MOSS_HOST_TASK_SURFACE_CAPABILITIES)
    ) {
      return 'manifest.tools[].taskSurfaceCapability must be a known task lifecycle capability';
    }
    if (
      tool.taskSurfaceCapabilities !== undefined &&
      (!Array.isArray(tool.taskSurfaceCapabilities) ||
        !tool.taskSurfaceCapabilities.every((item) =>
          isOneOf(item, MOSS_HOST_TASK_SURFACE_CAPABILITIES)
        ))
    ) {
      return 'manifest.tools[].taskSurfaceCapabilities must contain known task lifecycle capabilities';
    }
    if (
      (tool.taskSurfaceCapability !== undefined || tool.taskSurfaceCapabilities !== undefined) &&
      tool.surface !== 'task_subagent'
    ) {
      return 'manifest.tools[] task lifecycle capabilities may only be declared on task_subagent tools';
    }
    if (
      tool.channelBackplaneCapability !== undefined &&
      !isOneOf(tool.channelBackplaneCapability, MOSS_HOST_CHANNEL_BACKPLANE_CAPABILITIES)
    ) {
      return 'manifest.tools[].channelBackplaneCapability must be a known channel backplane capability';
    }
    if (
      tool.channelBackplaneCapabilities !== undefined &&
      (!Array.isArray(tool.channelBackplaneCapabilities) ||
        !tool.channelBackplaneCapabilities.every((item) =>
          isOneOf(item, MOSS_HOST_CHANNEL_BACKPLANE_CAPABILITIES)
        ))
    ) {
      return 'manifest.tools[].channelBackplaneCapabilities must contain known channel backplane capabilities';
    }
    if (
      (tool.channelBackplaneCapability !== undefined ||
        tool.channelBackplaneCapabilities !== undefined) &&
      tool.surface !== 'openclaw_channel'
    ) {
      return 'manifest.tools[] channel backplane capabilities may only be declared on openclaw_channel tools';
    }
  }

  const toolsByName = new Map<string, Record<string, unknown>>();
  for (const tool of manifest.tools) {
    if (isRecord(tool) && typeof tool.name === 'string') {
      toolsByName.set(tool.name, tool);
    }
  }

  if (manifest.toolSurfaces !== undefined) {
    if (!Array.isArray(manifest.toolSurfaces)) {
      return 'manifest.toolSurfaces must be an array when present';
    }
    for (const surface of manifest.toolSurfaces) {
      if (!isRecord(surface)) {
        return 'manifest.toolSurfaces must be an array of surface records';
      }
      if (!isOneOf(surface.kind, MOSS_HOST_TOOL_SURFACE_KINDS)) {
        return 'manifest.toolSurfaces[].kind must be a known tool surface';
      }
      if (typeof surface.summary !== 'string') {
        return 'manifest.toolSurfaces[].summary must be a string';
      }
      if (
        !Array.isArray(surface.readiness) ||
        !surface.readiness.every((item) => isOneOf(item, MOSS_HOST_TOOL_SURFACE_READINESS_SIGNALS))
      ) {
        return 'manifest.toolSurfaces[].readiness must contain known readiness signals';
      }
      if (!isOneOf(surface.progressMode, MOSS_HOST_TOOL_SURFACE_PROGRESS_MODES)) {
        return 'manifest.toolSurfaces[].progressMode must be a known progress mode';
      }
      if (!isStringArray(surface.primaryTools)) {
        return 'manifest.toolSurfaces[].primaryTools must be a string array';
      }
      if (surface.healthTools !== undefined && !isStringArray(surface.healthTools)) {
        return 'manifest.toolSurfaces[].healthTools must be a string array';
      }
      for (const toolName of surface.primaryTools) {
        const tool = toolsByName.get(toolName);
        if (!tool) {
          return `manifest.toolSurfaces[].primaryTools references unknown tool: ${surface.kind} -> ${toolName}`;
        }
        if (tool.surface !== surface.kind) {
          return `manifest.toolSurfaces[].primaryTools references tool from different surface: ${surface.kind} -> ${toolName} (${String(tool.surface)})`;
        }
      }
      for (const toolName of surface.healthTools ?? []) {
        const tool = toolsByName.get(toolName);
        if (!tool) {
          return `manifest.toolSurfaces[].healthTools references unknown tool: ${surface.kind} -> ${toolName}`;
        }
        if (tool.surface !== surface.kind) {
          return `manifest.toolSurfaces[].healthTools references tool from different surface: ${surface.kind} -> ${toolName} (${String(tool.surface)})`;
        }
        if (tool.sideEffectClass !== 'readonly') {
          return `manifest.toolSurfaces[].healthTools must reference read-only tools: ${surface.kind} -> ${toolName}`;
        }
      }
      if (
        surface.fallbackSurfaces !== undefined &&
        (!Array.isArray(surface.fallbackSurfaces) ||
          !surface.fallbackSurfaces.every((item) => isOneOf(item, MOSS_HOST_TOOL_SURFACE_KINDS)))
      ) {
        return 'manifest.toolSurfaces[].fallbackSurfaces must contain known tool surfaces';
      }
      if (
        surface.resultSurfaces !== undefined &&
        (!Array.isArray(surface.resultSurfaces) ||
          !surface.resultSurfaces.every((item) => isOneOf(item, MOSS_HOST_TOOL_RESULT_SURFACES)))
      ) {
        return 'manifest.toolSurfaces[].resultSurfaces must contain known result surfaces';
      }
    }
  }

  const invalidCapabilityCoverage = validateMossCapabilityCoverageShape(
    manifest.capabilityCoverage,
    manifest.tools
  );
  if (invalidCapabilityCoverage) return invalidCapabilityCoverage;

  if (!Array.isArray(manifest.eventSinks)) return 'manifest.eventSinks must be an array';
  if (
    manifest.eventSinks.some(
      (sink) =>
        !isRecord(sink) ||
        typeof sink.id !== 'string' ||
        !isStringArray(sink.schemas) ||
        typeof sink.supportsStreaming !== 'boolean'
    )
  ) {
    return 'manifest.eventSinks must be an array of event sink records';
  }

  if (!Array.isArray(manifest.knowledgeModules)) {
    return 'manifest.knowledgeModules must be an array';
  }
  if (
    manifest.knowledgeModules.some(
      (km) =>
        !isRecord(km) ||
        typeof km.id !== 'string' ||
        typeof km.version !== 'string' ||
        typeof km.stability !== 'string'
    )
  ) {
    return 'manifest.knowledgeModules must be an array of knowledge module records';
  }

  return null;
}

function emptyFailureReport(
  status: Exclude<MossHostCompatibilityStatus, 'ok'>,
  reasons: readonly string[]
): MossHostCompatibilityReport {
  return {
    compatible: false,
    status,
    reasons,
    missingCapabilities: [],
    missingToolSurfaces: [],
    missingToolSurfaceDetails: [],
    missingTaskSurfaceCapabilities: [],
    missingChannelBackplaneCapabilities: [],
    missingEventSchemas: [],
    missingProviderFamilies: [],
  };
}

/** Extract a capability projection (kinds, surfaces, event schemas, provider families) from a runtime manifest. @public */
export function projectMossHostRuntimeCapabilities(
  manifest: MossHostRuntimeManifest
): MossHostRuntimeCapabilityProjection {
  return {
    capabilityKinds: unique(manifest.capabilities.map((capability) => capability.kind)),
    toolSurfaces: unique(manifest.tools.flatMap((tool) => (tool.surface ? [tool.surface] : []))),
    toolSurfaceDetails: unique((manifest.toolSurfaces ?? []).map((surface) => surface.kind)),
    taskSurfaceCapabilities: unique(
      manifest.tools
        .filter((tool) => tool.surface === 'task_subagent')
        .flatMap((tool) => [
          ...(tool.taskSurfaceCapability ? [tool.taskSurfaceCapability] : []),
          ...(tool.taskSurfaceCapabilities ?? []),
        ])
    ),
    channelBackplaneCapabilities: unique(
      manifest.tools
        .filter((tool) => tool.surface === 'openclaw_channel')
        .flatMap((tool) => [
          ...(tool.channelBackplaneCapability ? [tool.channelBackplaneCapability] : []),
          ...(tool.channelBackplaneCapabilities ?? []),
        ])
    ),
    eventSchemas: unique(manifest.eventSinks.flatMap((sink) => [...sink.schemas])),
    providerFamilies: unique(manifest.providers.flatMap((provider) => [...provider.families])),
  };
}

function createEffectiveNotice(params: {
  code: MossHostEffectiveToolNoticeCode;
  severity: MossHostEffectiveToolNoticeSeverity;
  message: string;
  tool?: string;
  surface?: MossHostToolSurfaceKind;
  readinessSignal?: MossHostToolSurfaceReadinessSignal;
}): MossHostEffectiveToolNotice {
  return { ...params };
}

function collectToolRuntimeNotices(
  tool: MossHostToolRef,
  context: MossHostEffectiveToolInventoryContext
): MossHostEffectiveToolNotice[] {
  const notices: MossHostEffectiveToolNotice[] = [];
  const surface = tool.surface;

  if (new Set(context.disabledTools ?? []).has(tool.name)) {
    notices.push(
      createEffectiveNotice({
        code: 'tool_disabled_by_runtime',
        severity: 'warning',
        message: `tool is declared but disabled by the current host runtime: ${tool.name}`,
        tool: tool.name,
        surface,
      })
    );
  }
  if (new Set(context.policyDeniedTools ?? []).has(tool.name)) {
    notices.push(
      createEffectiveNotice({
        code: 'tool_denied_by_policy',
        severity: 'warning',
        message: `tool is declared but denied by policy for this session: ${tool.name}`,
        tool: tool.name,
        surface,
      })
    );
  }
  if (new Set(context.profileHiddenTools ?? []).has(tool.name)) {
    notices.push(
      createEffectiveNotice({
        code: 'tool_hidden_by_profile',
        severity: 'info',
        message: `tool is declared but hidden by the active tool profile: ${tool.name}`,
        tool: tool.name,
        surface,
      })
    );
  }

  return notices;
}

function missingReadinessSignals(
  surface: MossHostToolSurfaceRef,
  context: MossHostEffectiveToolInventoryContext
): MossHostToolSurfaceReadinessSignal[] {
  if (context.readySignals === undefined) return [];
  const readySignals = new Set(context.readySignals);
  return surface.readiness.filter(
    (signal) =>
      signal !== 'always_available' && signal !== 'approval_required' && !readySignals.has(signal)
  );
}

function synthesizeToolSurfaces(
  manifest: MossHostRuntimeManifest
): readonly MossHostToolSurfaceRef[] {
  const declaredSurfaces = new Set((manifest.toolSurfaces ?? []).map((surface) => surface.kind));
  const synthesized = MOSS_HOST_TOOL_SURFACE_KINDS.filter((kind) => !declaredSurfaces.has(kind))
    .map((kind): MossHostToolSurfaceRef | null => {
      const tools = manifest.tools.filter((tool) => tool.surface === kind).map((tool) => tool.name);
      if (tools.length === 0) return null;
      return {
        kind,
        summary: `Host-declared ${kind} tool surface.`,
        readiness: ['always_available'],
        progressMode: 'none',
        primaryTools: tools,
      };
    })
    .filter((surface): surface is MossHostToolSurfaceRef => surface !== null);

  return [...(manifest.toolSurfaces ?? []), ...synthesized];
}

function collectUnknownRuntimeToolNotices(
  manifest: MossHostRuntimeManifest,
  context: MossHostEffectiveToolInventoryContext
): MossHostEffectiveToolNotice[] {
  const knownTools = new Set(manifest.tools.map((tool) => tool.name));
  const runtimeToolNames = [
    ...(context.disabledTools ?? []),
    ...(context.policyDeniedTools ?? []),
    ...(context.profileHiddenTools ?? []),
  ];
  const unknownTools = [...new Set(runtimeToolNames)].filter((tool) => !knownTools.has(tool));
  return unknownTools.map((tool) =>
    createEffectiveNotice({
      code: 'runtime_unknown_tool',
      severity: 'warning',
      message: `runtime state references a tool that is not declared in the host manifest: ${tool}`,
      tool,
    })
  );
}

/** Build the effective tool inventory from a manifest and runtime context, marking tools/surfaces as effective or unavailable with notices. @public */
export function buildMossHostEffectiveToolInventory(
  manifest: unknown,
  context: MossHostEffectiveToolInventoryContext = {}
): MossHostEffectiveToolInventory {
  const compatibility = evaluateMossHostCompatibility(manifest);
  if (!compatibility.compatible) {
    const notices = compatibility.reasons.map((reason) =>
      createEffectiveNotice({
        code: 'manifest_invalid',
        severity: 'error',
        message: reason,
      })
    );
    return {
      valid: false,
      notices,
      tools: [],
      toolSurfaces: [],
    };
  }

  const runtimeManifest = manifest as MossHostRuntimeManifest;
  const notices: MossHostEffectiveToolNotice[] = [
    ...collectUnknownRuntimeToolNotices(runtimeManifest, context),
  ];
  const surfaceDetails = synthesizeToolSurfaces(runtimeManifest);
  const surfaceReadinessNotices = new Map<MossHostToolSurfaceKind, MossHostEffectiveToolNotice[]>();

  for (const surface of surfaceDetails) {
    const missingSignals = missingReadinessSignals(surface, context);
    surfaceReadinessNotices.set(
      surface.kind,
      missingSignals.map((signal) =>
        createEffectiveNotice({
          code: 'surface_readiness_missing',
          severity: 'warning',
          message: `tool surface is declared but not ready for this session: ${surface.kind} requires ${signal}`,
          surface: surface.kind,
          readinessSignal: signal,
        })
      )
    );
  }

  const effectiveTools = runtimeManifest.tools.map((tool): MossHostEffectiveToolRef => {
    const runtimeNotices = collectToolRuntimeNotices(tool, context);
    const readinessNotices = tool.surface ? (surfaceReadinessNotices.get(tool.surface) ?? []) : [];
    const unavailableReasons = [...runtimeNotices, ...readinessNotices];
    return {
      ...tool,
      effective: unavailableReasons.length === 0,
      unavailableReasons,
    };
  });

  const effectiveToolsByName = new Map(effectiveTools.map((tool) => [tool.name, tool]));
  const effectiveSurfaces = surfaceDetails.map((surface): MossHostEffectiveToolSurfaceRef => {
    const toolsForSurface = runtimeManifest.tools
      .filter((tool) => tool.surface === surface.kind)
      .map((tool) => tool.name);
    const primaryToolNames =
      surface.primaryTools.length > 0 ? surface.primaryTools : toolsForSurface;
    const effectiveToolNames = primaryToolNames.filter(
      (toolName) => effectiveToolsByName.get(toolName)?.effective
    );
    const unavailableToolNames = primaryToolNames.filter(
      (toolName) => !effectiveToolsByName.get(toolName)?.effective
    );
    const surfaceNotices = [...(surfaceReadinessNotices.get(surface.kind) ?? [])];
    if (primaryToolNames.length > 0 && effectiveToolNames.length === 0) {
      surfaceNotices.push(
        createEffectiveNotice({
          code: 'surface_without_effective_tools',
          severity: 'warning',
          message: `tool surface has no effective primary tools in this session: ${surface.kind}`,
          surface: surface.kind,
        })
      );
    }
    notices.push(...surfaceNotices);
    return {
      ...surface,
      effective: surfaceNotices.length === 0 && effectiveToolNames.length > 0,
      effectiveTools: effectiveToolNames,
      unavailableTools: unavailableToolNames,
      notices: surfaceNotices,
    };
  });

  for (const tool of effectiveTools) {
    notices.push(...tool.unavailableReasons);
  }

  return {
    valid: true,
    notices,
    tools: effectiveTools,
    toolSurfaces: effectiveSurfaces,
  };
}

/** Evaluate a host manifest against compatibility requirements (contract version, host version, capabilities, surfaces, event schemas, providers). @public */
export function evaluateMossHostCompatibility(
  manifest: unknown,
  requirement: MossHostCompatibilityRequirement = {}
): MossHostCompatibilityReport {
  const reasons: string[] = [];
  const invalidManifestReason = validateMossHostManifestShape(manifest);

  if (invalidManifestReason) {
    reasons.push(invalidManifestReason);
    return emptyFailureReport('invalid_manifest', reasons);
  }

  const runtimeManifest = manifest as MossHostRuntimeManifest;
  const projection = projectMossHostRuntimeCapabilities(runtimeManifest);

  if (requirement.contractVersion !== undefined) {
    if (runtimeManifest.contractVersion !== requirement.contractVersion) {
      reasons.push(
        `host adapter contract v${runtimeManifest.contractVersion} does not match Moss requirement v${requirement.contractVersion}`
      );
      return emptyFailureReport('contract_mismatch', reasons);
    }
  } else if (
    requirement.minContractVersion !== undefined ||
    requirement.maxContractVersion !== undefined
  ) {
    const minContractVersion = requirement.minContractVersion ?? Number.NEGATIVE_INFINITY;
    const maxContractVersion = requirement.maxContractVersion ?? Number.POSITIVE_INFINITY;
    if (
      runtimeManifest.contractVersion < minContractVersion ||
      runtimeManifest.contractVersion > maxContractVersion
    ) {
      reasons.push(
        `host adapter contract v${runtimeManifest.contractVersion} is outside Moss requirement range ${minContractVersion}..${maxContractVersion}`
      );
      return emptyFailureReport('contract_mismatch', reasons);
    }
  } else if (runtimeManifest.contractVersion !== MOSS_HOST_ADAPTER_CONTRACT_VERSION) {
    reasons.push(
      `host adapter contract v${runtimeManifest.contractVersion} does not match Moss requirement v${MOSS_HOST_ADAPTER_CONTRACT_VERSION}`
    );
    return emptyFailureReport('contract_mismatch', reasons);
  }

  if (
    requirement.minHostVersion &&
    compareSemver(runtimeManifest.host.version, requirement.minHostVersion) < 0
  ) {
    reasons.push(
      `host ${runtimeManifest.host.version} is older than required ${requirement.minHostVersion}`
    );
    return {
      compatible: false,
      status: 'host_version_incompatible',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingTaskSurfaceCapabilities: [],
      missingChannelBackplaneCapabilities: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const capabilityKinds = new Set(projection.capabilityKinds);
  const missingCapabilities = (requirement.requiredCapabilities ?? []).filter(
    (kind) => !capabilityKinds.has(kind)
  );
  if (missingCapabilities.length > 0) {
    reasons.push(`missing host capabilities: ${missingCapabilities.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_capability',
      reasons,
      missingCapabilities,
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingTaskSurfaceCapabilities: [],
      missingChannelBackplaneCapabilities: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const toolSurfaces = new Set(projection.toolSurfaces);
  const missingToolSurfaces = (requirement.requiredToolSurfaces ?? []).filter(
    (surface) => !toolSurfaces.has(surface)
  );
  if (missingToolSurfaces.length > 0) {
    reasons.push(`missing host tool surfaces: ${missingToolSurfaces.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_capability',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces,
      missingToolSurfaceDetails: [],
      missingTaskSurfaceCapabilities: [],
      missingChannelBackplaneCapabilities: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const toolSurfaceDetails = new Set(projection.toolSurfaceDetails);
  const missingToolSurfaceDetails = (requirement.requiredToolSurfaceDetails ?? []).filter(
    (surface) => !toolSurfaceDetails.has(surface)
  );
  if (missingToolSurfaceDetails.length > 0) {
    reasons.push(`missing host tool surface details: ${missingToolSurfaceDetails.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_capability',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails,
      missingTaskSurfaceCapabilities: [],
      missingChannelBackplaneCapabilities: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const taskSurfaceCapabilities = new Set(projection.taskSurfaceCapabilities);
  const missingTaskSurfaceCapabilities = (requirement.requiredTaskSurfaceCapabilities ?? []).filter(
    (capability) => !taskSurfaceCapabilities.has(capability)
  );
  if (missingTaskSurfaceCapabilities.length > 0) {
    reasons.push(
      `missing task/subagent lifecycle capabilities: ${missingTaskSurfaceCapabilities.join(', ')}`
    );
    return {
      compatible: false,
      status: 'missing_capability',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingTaskSurfaceCapabilities,
      missingChannelBackplaneCapabilities: [],
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const channelBackplaneCapabilities = new Set(projection.channelBackplaneCapabilities);
  const missingChannelBackplaneCapabilities = (
    requirement.requiredChannelBackplaneCapabilities ?? []
  ).filter((capability) => !channelBackplaneCapabilities.has(capability));
  if (missingChannelBackplaneCapabilities.length > 0) {
    reasons.push(
      `missing channel/backplane capabilities: ${missingChannelBackplaneCapabilities.join(', ')}`
    );
    return {
      compatible: false,
      status: 'missing_capability',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingTaskSurfaceCapabilities: [],
      missingChannelBackplaneCapabilities,
      missingEventSchemas: [],
      missingProviderFamilies: [],
    };
  }

  const eventSchemas = new Set(projection.eventSchemas);
  const missingEventSchemas = (requirement.requiredEventSchemas ?? []).filter(
    (schema) => !eventSchemas.has(schema)
  );
  if (missingEventSchemas.length > 0) {
    reasons.push(`missing host event schemas: ${missingEventSchemas.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_event_schema',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingTaskSurfaceCapabilities: [],
      missingChannelBackplaneCapabilities: [],
      missingEventSchemas,
      missingProviderFamilies: [],
    };
  }

  const providerFamilies = new Set(projection.providerFamilies);
  const missingProviderFamilies = (requirement.requiredProviderFamilies ?? []).filter(
    (family) => !providerFamilies.has(family)
  );
  if (missingProviderFamilies.length > 0) {
    reasons.push(`missing host provider families: ${missingProviderFamilies.join(', ')}`);
    return {
      compatible: false,
      status: 'missing_provider_family',
      reasons,
      missingCapabilities: [],
      missingToolSurfaces: [],
      missingToolSurfaceDetails: [],
      missingTaskSurfaceCapabilities: [],
      missingChannelBackplaneCapabilities: [],
      missingEventSchemas: [],
      missingProviderFamilies,
    };
  }

  return {
    compatible: true,
    status: 'ok',
    reasons,
    missingCapabilities: [],
    missingToolSurfaces: [],
    missingToolSurfaceDetails: [],
    missingTaskSurfaceCapabilities: [],
    missingChannelBackplaneCapabilities: [],
    missingEventSchemas: [],
    missingProviderFamilies: [],
  };
}
