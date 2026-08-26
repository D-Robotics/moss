import { SpanStatusCode } from '@opentelemetry/api';

/** Moss Observability Contract version emitted by this package. @public */
export const MOSS_OBSERVABILITY_CONTRACT_VERSION = '1.0.0' as const;

/** Canonical lifecycle span names defined by MOC 1.0. @public */
export const MOSS_SPAN_NAMES = {
  session: 'moss.session',
  agentTurn: 'moss.agent.turn',
  llmRequest: 'moss.llm.request',
  toolInvoke: 'moss.tool.invoke',
} as const;

/** Canonical attribute names defined by MOC 1.0. @public */
export const MOSS_OBSERVABILITY_ATTRIBUTES = {
  contractVersion: 'moss.observability.contract.version',
  runId: 'moss.run.id',
  sessionId: 'moss.session.id',
  turnIndex: 'moss.turn.index',
  outcome: 'moss.outcome',
  errorCategory: 'moss.error.category',
  toolName: 'moss.tool.name',
  toolCallId: 'moss.tool.call.id',
  toolOutcomeKind: 'moss.tool.outcome_kind',
  genAiOperationName: 'gen_ai.operation.name',
  genAiProviderName: 'gen_ai.provider.name',
  genAiRequestModel: 'gen_ai.request.model',
  genAiResponseModel: 'gen_ai.response.model',
  genAiUsageInputTokens: 'gen_ai.usage.input_tokens',
  genAiUsageOutputTokens: 'gen_ai.usage.output_tokens',
} as const;

/** One-release compatibility aliases dual-written with canonical fields. @public */
export const MOSS_LEGACY_ATTRIBUTE_ALIASES = {
  runId: 'runId',
  sessionId: 'sessionKey',
  turnIndex: 'turn',
  requestModel: 'model',
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  toolName: 'toolName',
  toolCallId: 'toolCallId',
} as const;

/** Canonical metric instruments and units defined by MOC 1.0. @public */
export const MOSS_METRIC_CATALOG = {
  llmTokens: { name: 'moss.llm.tokens', unit: '{token}', kind: 'counter' },
  llmRequestDuration: { name: 'moss.llm.request.duration', unit: 'ms', kind: 'histogram' },
  toolInvocations: {
    name: 'moss.tool.invocations',
    unit: '{invocation}',
    kind: 'counter',
  },
  toolInvokeDuration: { name: 'moss.tool.invoke.duration', unit: 'ms', kind: 'histogram' },
  sessionCount: { name: 'moss.session.count', unit: '{session}', kind: 'counter' },
  sessionDuration: { name: 'moss.session.duration', unit: 'ms', kind: 'histogram' },
  sessionToolCount: {
    name: 'moss.session.tool_count',
    unit: '{invocation}',
    kind: 'histogram',
  },
} as const;

/** Terminal outcomes allowed by MOC 1.0. @public */
export type MossOutcome =
  | 'ok'
  | 'error'
  | 'cancelled'
  | 'denied'
  | 'blocked'
  | 'incomplete'
  | 'replayed'
  | 'suppressed';

/** Bounded classifications for a requested tool invocation. @public */
export type MossToolOutcomeKind =
  | 'executed'
  | 'failed'
  | 'denied'
  | 'blocked'
  | 'replayed'
  | 'suppressed';

/** Privacy-safe error categories emitted instead of raw exception text. @public */
export type MossErrorCategory =
  | 'aborted'
  | 'timeout'
  | 'policy'
  | 'validation'
  | 'provider'
  | 'tool'
  | 'storage'
  | 'internal'
  | 'unknown';

/** Bounded model families accepted on metrics. @public */
export type MossMetricModelFamily =
  | 'claude'
  | 'deepseek'
  | 'gemini'
  | 'glm'
  | 'gpt'
  | 'llama'
  | 'mistral'
  | 'qwen'
  | 'other';

/** Bounded operational tool categories accepted on metrics. @public */
export type MossMetricToolCategory =
  | 'browser'
  | 'device'
  | 'filesystem'
  | 'memory'
  | 'network'
  | 'orchestration'
  | 'search'
  | 'shell'
  | 'other';

/** Branded canonical run identifier. @public */
export type MossRunId = string & { readonly __mossRunId: unique symbol };

/** Branded canonical conversation/session identifier. @public */
export type MossSessionId = string & { readonly __mossSessionId: unique symbol };

/** Branded native OpenTelemetry trace identifier. @public */
export type MossTraceId = string & { readonly __mossTraceId: unique symbol };

/** Branded native OpenTelemetry span identifier. @public */
export type MossSpanId = string & { readonly __mossSpanId: unique symbol };

/** Result of reading one canonical field with a legacy fallback. @public */
export interface MossCompatibilityRead {
  readonly value?: string | number | boolean;
  readonly source: 'canonical' | 'legacy' | 'absent';
  readonly drift: boolean;
}

/**
 * Read a canonical attribute first and surface conflicts with its legacy
 * alias. The canonical value always wins.
 * @public
 */
export function readMossCompatibilityAttribute(
  attributes: Readonly<Record<string, unknown>>,
  canonicalName: string,
  legacyName: string
): MossCompatibilityRead {
  const canonical = attributes[canonicalName];
  const legacy = attributes[legacyName];
  const canonicalScalar =
    typeof canonical === 'string' || typeof canonical === 'number' || typeof canonical === 'boolean'
      ? canonical
      : undefined;
  const legacyScalar =
    typeof legacy === 'string' || typeof legacy === 'number' || typeof legacy === 'boolean'
      ? legacy
      : undefined;
  if (canonicalScalar !== undefined) {
    return Object.freeze({
      value: canonicalScalar,
      source: 'canonical' as const,
      drift: legacyScalar !== undefined && legacyScalar !== canonicalScalar,
    });
  }
  if (legacyScalar !== undefined) {
    return Object.freeze({ value: legacyScalar, source: 'legacy' as const, drift: false });
  }
  return Object.freeze({ source: 'absent' as const, drift: false });
}

/** OpenTelemetry status code required for a terminal MOC outcome. @public */
export function mossOutcomeToSpanStatusCode(outcome: MossOutcome): SpanStatusCode {
  switch (outcome) {
    case 'ok':
    case 'replayed':
    case 'suppressed':
      return SpanStatusCode.OK;
    case 'error':
      return SpanStatusCode.ERROR;
    case 'cancelled':
    case 'denied':
    case 'blocked':
    case 'incomplete':
      return SpanStatusCode.UNSET;
  }
}

/** Convert a model identifier into the bounded metric family catalog. @public */
export function normalizeMetricModelFamily(model: string | undefined): MossMetricModelFamily {
  const value = model?.trim().toLowerCase() ?? '';
  if (/claude|anthropic/.test(value)) return 'claude';
  if (/deepseek/.test(value)) return 'deepseek';
  if (/gemini|google/.test(value)) return 'gemini';
  if (/(?:^|[-_/])glm|zhipu/.test(value)) return 'glm';
  if (/(?:^|[-_/])gpt|openai|o[134](?:$|[-_/])/.test(value)) return 'gpt';
  if (/llama|meta/.test(value)) return 'llama';
  if (/mistral|mixtral/.test(value)) return 'mistral';
  if (/qwen|dashscope|alibaba/.test(value)) return 'qwen';
  return 'other';
}

/** Convert a tool name into a bounded operational metric category. @public */
export function normalizeMetricToolCategory(toolName: string | undefined): MossMetricToolCategory {
  const value = toolName?.trim().toLowerCase() ?? '';
  if (/browser|screenshot|open_url|vision/.test(value)) return 'browser';
  if (/device|ros|camera|fleet|ssh/.test(value)) return 'device';
  if (/file|directory|patch|workspace|move|write|edit/.test(value)) return 'filesystem';
  if (/memory|skill|teaching/.test(value)) return 'memory';
  if (/web_fetch|http|rss/.test(value)) return 'network';
  if (/subagent|plan|todo|goal|mesh/.test(value)) return 'orchestration';
  if (/search|grep|codegraph/.test(value)) return 'search';
  if (/exec|shell|terminal|command|docker|test|build/.test(value)) return 'shell';
  return 'other';
}

/** Whether a string is a valid non-zero W3C trace identifier. @public */
export function isValidMossTraceId(value: string): value is MossTraceId {
  return /^[0-9a-f]{32}$/i.test(value) && !/^0{32}$/.test(value);
}

/** Whether a string is a valid non-zero W3C span identifier. @public */
export function isValidMossSpanId(value: string): value is MossSpanId {
  return /^[0-9a-f]{16}$/i.test(value) && !/^0{16}$/.test(value);
}

/** Build canonical common fields and their compatibility aliases. @public */
export function commonMossAttributes(
  runId: string,
  sessionId: string
): Record<string, string | number | boolean> {
  return {
    [MOSS_OBSERVABILITY_ATTRIBUTES.contractVersion]: MOSS_OBSERVABILITY_CONTRACT_VERSION,
    [MOSS_OBSERVABILITY_ATTRIBUTES.runId]: runId,
    [MOSS_OBSERVABILITY_ATTRIBUTES.sessionId]: sessionId,
    [MOSS_LEGACY_ATTRIBUTE_ALIASES.runId]: runId,
    [MOSS_LEGACY_ATTRIBUTE_ALIASES.sessionId]: sessionId,
  };
}
