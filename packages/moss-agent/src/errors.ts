



















export enum ErrorCode {
  
  USER_INPUT_INVALID = 'USER_INPUT_INVALID',
  
  PROVIDER_CONFIG_MISSING = 'PROVIDER_CONFIG_MISSING',
  
  PROVIDER_UPSTREAM_ERROR = 'PROVIDER_UPSTREAM_ERROR',
  
  PROVIDER_CONTEXT_OVERFLOW = 'PROVIDER_CONTEXT_OVERFLOW',
  
  PROVIDER_AUTH_FAILED = 'PROVIDER_AUTH_FAILED',
  
  PROVIDER_RATE_LIMITED = 'PROVIDER_RATE_LIMITED',
  
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  
  TOOL_EXECUTION_TIMEOUT = 'TOOL_EXECUTION_TIMEOUT',
  
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  
  TOOL_NOT_ALLOWED = 'TOOL_NOT_ALLOWED',
  
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  
  SESSION_PERSIST_FAILED = 'SESSION_PERSIST_FAILED',
  
  SKILL_LOAD_FAILED = 'SKILL_LOAD_FAILED',
  
  MESH_PEER_UNREACHABLE = 'MESH_PEER_UNREACHABLE',
  
  MESH_QUERY_REJECTED = 'MESH_QUERY_REJECTED',
  
  MCP_CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',
  
  DEVICE_SSH_FAILED = 'DEVICE_SSH_FAILED',
  
  USER_ABORTED = 'USER_ABORTED',
  
  CONFIG_IO_FAILED = 'CONFIG_IO_FAILED',
  
  INTERNAL_INVARIANT_VIOLATED = 'INTERNAL_INVARIANT_VIOLATED',
  
  UNKNOWN = 'UNKNOWN',
}

export interface MossErrorDetails {
  code: ErrorCode;
  
  message: string;
  
  hint?: string;
  
  recoverable?: boolean;
  
  cause?: unknown;
  
  context?: Record<string, unknown>;
}





export class MossError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly recoverable: boolean;
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(details: MossErrorDetails) {
    super(details.message);
    this.name = 'MossError';
    this.code = details.code;
    this.hint = details.hint;
    this.recoverable = details.recoverable ?? false;
    this.context = details.context;
    this.cause = details.cause;
  }

  
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      hint: this.hint,
      recoverable: this.recoverable,
      context: this.context,
      stack: this.stack,
    };
  }
}

export function isMossError(err: unknown): err is MossError {
  return (
    err instanceof MossError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { name?: string }).name === 'MossError' &&
      typeof (err as { code?: unknown }).code === 'string')
  );
}

export function throwMoss(details: MossErrorDetails): never {
  throw new MossError(details);
}






export function wrapAsMoss(
  err: unknown,
  code: ErrorCode,
  opts: Partial<Omit<MossErrorDetails, 'code' | 'message'>> & { message?: string } = {}
): MossError {
  if (isMossError(err)) return err;
  const origMessage = err instanceof Error ? err.message : String(err);
  return new MossError({
    code,
    message: opts.message ?? origMessage ?? 'unknown error',
    hint: opts.hint,
    recoverable: opts.recoverable,
    context: opts.context,
    cause: err,
  });
}







export function formatMossError(err: unknown): string {
  if (isMossError(err)) {
    const base = `[${err.code}] ${err.message}`;
    return err.hint ? `${base}\n→ ${err.hint}` : base;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}






export function isMossErrorRecoverable(err: unknown): boolean {
  if (!isMossError(err)) return false;
  if (err.recoverable === true) return true;
  return (
    err.code === ErrorCode.PROVIDER_RATE_LIMITED ||
    err.code === ErrorCode.PROVIDER_UPSTREAM_ERROR ||
    err.code === ErrorCode.TOOL_EXECUTION_TIMEOUT
  );
}










export function errorMessage(err: unknown): string {
  // For a MossError that carries an actionable `.hint` (e.g. the connection
  // hints from connection-error.ts: DNS / refused / timeout / TLS / proxy),
  // append the hint so every display path that uses errorMessage — the TUI run
  // error, slash-command failures, headless print, tool results — surfaces the
  // hint to the user. Previously the hint was attached to the MossError but
  // dropped here (only .message was returned), so the carefully-classified
  // connection hints never reached users.
  if (err instanceof Error) {
    if (isMossError(err) && err.hint) return `${err.message}\n→ ${err.hint}`;
    return err.message;
  }
  return String(err);
}
