import { ErrorCode, MossError } from '../../errors.js';

/** Stable domain identity plus the ordinary Moss error boundary. */
export class RsiError extends MossError {
  constructor(
    readonly rsiCode: string,
    readonly status = 400,
    cause?: unknown
  ) {
    super({
      code: ['rsi_model_call_failed', 'rsi_task_evaluation_failed'].includes(rsiCode)
        ? ErrorCode.PROVIDER_UPSTREAM_ERROR
        : status >= 500
          ? ErrorCode.EXECUTION_STORE_FAILED
          : ErrorCode.USER_INPUT_INVALID,
      message: rsiCode,
      cause,
    });
    this.name = 'RsiError';
  }
  override toJSON(): Record<string, unknown> {
    return { ...super.toJSON(), rsiCode: this.rsiCode, status: this.status };
  }
}
