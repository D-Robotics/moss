import { ErrorCode, isMossError, MossError } from '../errors.js';
import { mossMetrics } from './metrics.js';
import {
  classifyMossErrorCategory,
  sessionAttributes,
  startSpan,
  turnAttributes,
  type ActiveSpan,
} from './tracing.js';
import { MOSS_SPAN_NAMES, type MossErrorCategory, type MossOutcome } from './contract.js';

const STREAM_SETTLE_TIMEOUT_MS = 2_000;

export class AgentSessionObservation {
  readonly runId: string;
  readonly abortSignal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly span: ActiveSpan;
  private readonly startedAt = Date.now();
  private outcome: MossOutcome = 'incomplete';
  private errorCategory: MossErrorCategory | undefined;
  private finalized = false;

  constructor(
    sessionId: string,
    model: string,
    requestedRunId: string | undefined,
    externalAbortSignal: AbortSignal | undefined
  ) {
    this.runId = requestedRunId?.trim() ? requestedRunId : crypto.randomUUID();
    this.abortSignal = externalAbortSignal
      ? AbortSignal.any([externalAbortSignal, this.controller.signal])
      : this.controller.signal;
    this.span = startSpan(MOSS_SPAN_NAMES.session, sessionAttributes(this.runId, model, sessionId));
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.span.runInSpanContext(operation);
  }

  drive<T>(generator: AsyncGenerator<T>): AsyncGenerator<T> {
    return this.span.runInSpanContextGen(generator);
  }

  complete(stopReason: string | undefined): void {
    this.outcome =
      stopReason === 'end_turn'
        ? 'ok'
        : stopReason === 'aborted_by_user'
          ? 'cancelled'
          : stopReason === 'error'
            ? 'error'
            : 'incomplete';
  }

  fail(error: unknown, runAborted: boolean): void {
    this.errorCategory = classifyMossErrorCategory(error);
    this.outcome =
      this.errorCategory === 'aborted' || runAborted
        ? 'cancelled'
        : isMossError(error) && error.code === ErrorCode.TOOL_NOT_ALLOWED
          ? 'denied'
          : 'error';
  }

  async finalize(params: {
    completed: boolean;
    toolCount: number;
    settle?: Promise<{ totalToolCalls: number }>;
  }): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    if (!params.completed && !this.abortSignal.aborted) {
      this.controller.abort(
        new MossError({
          code: ErrorCode.USER_ABORTED,
          message: 'Observed stream was closed before normal completion.',
        })
      );
    }
    let toolCount = params.toolCount;
    if (!params.completed && params.settle) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          params.settle.then((result) => {
            toolCount = Math.max(0, Math.trunc(result.totalToolCalls));
          }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, STREAM_SETTLE_TIMEOUT_MS);
          }),
        ]);
      } catch {
        // The business outcome wins over lifecycle cleanup.
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    if (this.outcome === 'incomplete' && this.abortSignal.aborted) {
      this.outcome = 'cancelled';
      this.errorCategory = 'aborted';
    } else if (this.outcome === 'error' && !this.errorCategory) {
      this.errorCategory = 'unknown';
    }
    mossMetrics.sessionCount.add(1, { outcome: this.outcome });
    mossMetrics.sessionDuration.record(Date.now() - this.startedAt, { outcome: this.outcome });
    mossMetrics.sessionToolCount.record(toolCount, { outcome: this.outcome });
    this.span.endOutcome(
      this.outcome,
      this.errorCategory,
      this.outcome === 'error' ? 'moss_session_failed' : undefined
    );
  }
}

export class AgentTurnObservation {
  private readonly span: ActiveSpan;
  private outcome: MossOutcome = 'incomplete';
  private errorCategory: MossErrorCategory | undefined;

  constructor(runId: string, sessionId: string, turn: number, model: string) {
    this.span = startSpan(MOSS_SPAN_NAMES.agentTurn, turnAttributes(runId, turn, model, sessionId));
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.span.runInSpanContext(operation);
  }

  complete(aborted: boolean): void {
    this.outcome = aborted ? 'cancelled' : 'ok';
    if (aborted) this.errorCategory = 'aborted';
  }

  fail(error: unknown, aborted: boolean): void {
    this.errorCategory = classifyMossErrorCategory(error);
    this.outcome = aborted || this.errorCategory === 'aborted' ? 'cancelled' : 'error';
  }

  end(): void {
    this.span.endOutcome(
      this.outcome,
      this.errorCategory,
      this.outcome === 'error' ? 'agent_turn_failed' : undefined
    );
  }
}
