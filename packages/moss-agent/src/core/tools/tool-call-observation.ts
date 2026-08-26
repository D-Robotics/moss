import { mossMetrics } from '../../observability/metrics.js';
import {
  MOSS_OBSERVABILITY_ATTRIBUTES,
  MOSS_SPAN_NAMES,
  type MossOutcome,
  type MossToolOutcomeKind,
} from '../../observability/contract.js';
import {
  classifyMossErrorCategory,
  startSpan,
  toolAttributes,
} from '../../observability/tracing.js';
import type { ExecuteToolCallDeps, ExecuteToolCallOutcome } from './execute-tool-call.js';

function classifyToolOutcome(outcome: ExecuteToolCallOutcome): {
  outcome: MossOutcome;
  outcomeKind: MossToolOutcomeKind;
  isError: boolean;
  durationMs: number | undefined;
} {
  if (outcome.kind === 'denied') {
    return { outcome: 'denied', outcomeKind: 'denied', isError: false, durationMs: undefined };
  }
  if (outcome.kind !== 'completed') {
    return { outcome: 'blocked', outcomeKind: 'blocked', isError: false, durationMs: undefined };
  }
  const terminal = outcome.outcome ?? (outcome.isError ? 'error' : 'ok');
  if (terminal === 'replayed' || terminal === 'suppressed') {
    return {
      outcome: terminal,
      outcomeKind: terminal,
      isError: false,
      durationMs: outcome.durationMs,
    };
  }
  if (terminal === 'denied' || terminal === 'blocked') {
    return {
      outcome: terminal,
      outcomeKind: terminal,
      isError: false,
      durationMs: outcome.durationMs,
    };
  }
  if (outcome.aborted?.by === 'user') {
    return {
      outcome: 'cancelled',
      outcomeKind: 'failed',
      isError: true,
      durationMs: outcome.durationMs,
    };
  }
  if (terminal === 'error' || outcome.isError) {
    return {
      outcome: 'error',
      outcomeKind: 'failed',
      isError: true,
      durationMs: outcome.durationMs,
    };
  }
  return {
    outcome: 'ok',
    outcomeKind: 'executed',
    isError: false,
    durationMs: outcome.durationMs,
  };
}

export async function observeToolCall(
  call: { id: string; name: string; input: Record<string, unknown> },
  deps: ExecuteToolCallDeps,
  operation: () => Promise<ExecuteToolCallOutcome>
): Promise<ExecuteToolCallOutcome> {
  const startMs = Date.now();
  const runId = deps.runId ?? deps.toolCtx.runId ?? deps.sessionKey;
  const turnIndex = Math.max(0, Math.trunc(deps.turnIndex ?? 0));
  const toolSpan = startSpan(
    MOSS_SPAN_NAMES.toolInvoke,
    toolAttributes(runId, call.name, call.id, deps.sessionKey, turnIndex)
  );
  let terminalOutcome: MossOutcome = 'incomplete';
  let errorCategory: ReturnType<typeof classifyMossErrorCategory> | undefined;
  try {
    const outcome = await toolSpan.runInSpanContext(operation);
    const classified = classifyToolOutcome(outcome);
    terminalOutcome = classified.outcome;
    if (
      (terminalOutcome === 'error' || terminalOutcome === 'cancelled') &&
      outcome.kind === 'completed'
    ) {
      const classifiedError = classifyMossErrorCategory(outcome.error);
      errorCategory =
        terminalOutcome === 'cancelled'
          ? 'aborted'
          : classifiedError === 'unknown'
            ? 'tool'
            : classifiedError;
    }
    toolSpan.span.setAttribute(
      MOSS_OBSERVABILITY_ATTRIBUTES.toolOutcomeKind,
      classified.outcomeKind
    );
    toolSpan.span.setAttribute('is_error', classified.isError);
    toolSpan.span.setAttribute('outcome_kind', outcome.kind);
    if (outcome.kind === 'completed' && outcome.outcome) {
      toolSpan.span.setAttribute('outcome', outcome.outcome);
    }
    const durationMs = classified.durationMs ?? Date.now() - startMs;
    mossMetrics.toolInvocations.add(1, { tool: call.name, outcome: terminalOutcome });
    mossMetrics.toolDuration.record(durationMs, { tool: call.name, outcome: terminalOutcome });
    return outcome;
  } catch (error) {
    const classifiedError = classifyMossErrorCategory(error);
    errorCategory = classifiedError === 'unknown' ? 'tool' : classifiedError;
    terminalOutcome =
      deps.abortSignal.aborted || errorCategory === 'aborted' ? 'cancelled' : 'error';
    if (terminalOutcome === 'cancelled') errorCategory = 'aborted';
    toolSpan.span.setAttribute(MOSS_OBSERVABILITY_ATTRIBUTES.toolOutcomeKind, 'failed');
    mossMetrics.toolInvocations.add(1, { tool: call.name, outcome: terminalOutcome });
    mossMetrics.toolDuration.record(Date.now() - startMs, {
      tool: call.name,
      outcome: terminalOutcome,
    });
    throw error;
  } finally {
    toolSpan.endOutcome(
      terminalOutcome,
      errorCategory,
      terminalOutcome === 'error' ? 'tool_invoke_failed' : undefined
    );
  }
}

export function observeToolCallOutcome(
  call: { id: string; name: string; input: Record<string, unknown> },
  deps: ExecuteToolCallDeps,
  outcome: ExecuteToolCallOutcome
): Promise<ExecuteToolCallOutcome> {
  return observeToolCall(call, deps, async () => outcome);
}
