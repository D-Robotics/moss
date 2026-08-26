import {
  MOSS_LEGACY_ATTRIBUTE_ALIASES,
  MOSS_METRIC_CATALOG,
  MOSS_OBSERVABILITY_ATTRIBUTES,
  MOSS_OBSERVABILITY_CONTRACT_VERSION,
  MOSS_SPAN_NAMES,
} from './contract.js';

/**
 * Machine-readable MOC 1.0 fixtures. Downstream hosts use these expectations
 * to validate projection and serialization without redefining Moss semantics.
 * @public
 */
export const MOSS_OBSERVABILITY_CONFORMANCE_FIXTURES = {
  schema: 'moss.observability.conformance.v1',
  contractVersion: MOSS_OBSERVABILITY_CONTRACT_VERSION,
  canonicalFields: {
    common: [
      {
        name: MOSS_OBSERVABILITY_ATTRIBUTES.contractVersion,
        type: 'non-empty-string',
        required: true,
      },
      { name: MOSS_OBSERVABILITY_ATTRIBUTES.runId, type: 'non-empty-string', required: true },
      {
        name: MOSS_OBSERVABILITY_ATTRIBUTES.sessionId,
        type: 'non-empty-string',
        required: true,
      },
      { name: MOSS_OBSERVABILITY_ATTRIBUTES.outcome, type: 'MossOutcome', required: true },
    ],
    turn: {
      name: MOSS_OBSERVABILITY_ATTRIBUTES.turnIndex,
      type: 'non-negative-integer',
      required: true,
    },
    llm: [
      MOSS_OBSERVABILITY_ATTRIBUTES.genAiOperationName,
      MOSS_OBSERVABILITY_ATTRIBUTES.genAiProviderName,
      MOSS_OBSERVABILITY_ATTRIBUTES.genAiRequestModel,
      MOSS_OBSERVABILITY_ATTRIBUTES.genAiResponseModel,
      MOSS_OBSERVABILITY_ATTRIBUTES.genAiUsageInputTokens,
      MOSS_OBSERVABILITY_ATTRIBUTES.genAiUsageOutputTokens,
    ],
    tool: [
      { name: MOSS_OBSERVABILITY_ATTRIBUTES.toolName, type: 'non-empty-string' },
      { name: MOSS_OBSERVABILITY_ATTRIBUTES.toolCallId, type: 'non-empty-string' },
      { name: MOSS_OBSERVABILITY_ATTRIBUTES.toolOutcomeKind, type: 'MossToolOutcomeKind' },
    ],
  },
  lifecycle: [
    { id: 'success', outcome: 'ok', status: 'OK' },
    { id: 'returned-error', outcome: 'error', status: 'ERROR' },
    { id: 'thrown-error', outcome: 'error', status: 'ERROR' },
    { id: 'timeout', outcome: 'error', status: 'ERROR', errorCategory: 'timeout' },
    { id: 'cancellation', outcome: 'cancelled', status: 'UNSET' },
    { id: 'incomplete-stream', outcome: 'incomplete', status: 'UNSET' },
    { id: 'approval-denied', outcome: 'denied', status: 'UNSET' },
    { id: 'policy-blocked', outcome: 'blocked', status: 'UNSET' },
    { id: 'result-replayed', outcome: 'replayed', status: 'OK' },
    { id: 'invocation-suppressed', outcome: 'suppressed', status: 'OK' },
  ],
  topology: {
    standalone: [
      MOSS_SPAN_NAMES.session,
      MOSS_SPAN_NAMES.agentTurn,
      MOSS_SPAN_NAMES.llmRequest,
      MOSS_SPAN_NAMES.toolInvoke,
    ],
    hosted: [
      'host.parent',
      MOSS_SPAN_NAMES.session,
      MOSS_SPAN_NAMES.agentTurn,
      MOSS_SPAN_NAMES.llmRequest,
      MOSS_SPAN_NAMES.toolInvoke,
    ],
    canonicalEdges: [
      [MOSS_SPAN_NAMES.session, MOSS_SPAN_NAMES.agentTurn],
      [MOSS_SPAN_NAMES.agentTurn, MOSS_SPAN_NAMES.llmRequest],
      [MOSS_SPAN_NAMES.agentTurn, MOSS_SPAN_NAMES.toolInvoke],
    ],
  },
  identifiers: {
    structural: ['trace_id', 'span_id', 'parent_span_id'],
    business: [MOSS_OBSERVABILITY_ATTRIBUTES.runId, MOSS_OBSERVABILITY_ATTRIBUTES.sessionId],
    structuralFormat: {
      trace_id: '32-lower-hex-nonzero',
      span_id: '16-lower-hex-nonzero',
      parent_span_id: '16-lower-hex-nonzero-when-present',
    },
    businessIdsNeverSubstituteStructuralIds: true,
    sameRunUsesOneRunAndSessionId: true,
    sameConversationRetainsSessionAndChangesRunId: true,
  },
  normalizedSpan: {
    immutable: true,
    equivalentCopyPerConsumer: true,
    finalStateOnly: true,
    requiredFields: [
      'name',
      'trace_id',
      'span_id',
      'start_time_unix_ms',
      'end_time_unix_ms',
      'duration_ms',
      'attributes',
      'events',
      'outcome',
      'status',
    ],
    optionalFields: ['parent_span_id', 'status_message'],
  },
  hostConsumption: {
    startsWithoutDirectExporter: true,
    beforeHostTailSampling: true,
    duplicateInitializationIsIdempotent: true,
    consumerFailureIsFailOpen: true,
    shutdownIsBounded: true,
  },
  compatibility: {
    aliases: MOSS_LEGACY_ATTRIBUTE_ALIASES,
    canonicalWinsOnConflict: true,
    conflictIsDrift: true,
    dualWriteWindow: 'moc-1.x',
  },
  metricCatalog: MOSS_METRIC_CATALOG,
  metricDimensions: {
    allowed: ['moss.outcome', 'direction', 'model.family', 'tool.category'],
    forbidden: [
      'moss.run.id',
      'moss.session.id',
      'trace_id',
      'span_id',
      'parent_span_id',
      'moss.tool.call.id',
      'account.id',
      'device.id',
      'prompt',
      'response',
      'error.message',
    ],
  },
} as const;
