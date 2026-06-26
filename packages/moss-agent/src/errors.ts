/**
 * Unified error classification system (actionable error design).
 *
 * Problems with bare `new Error('string')`:
 *   - Callers cannot branch on error type
 *   - Users see messages like "Request failed" with no guidance on what to do
 *   - Log aggregation cannot group "same kind of errors"
 *
 * This module defines:
 *   1. `ErrorCode` enum: globally stable error codes
 *   2. `MossError`: carries code + hint (actionable advice) + recoverable + cause
 *   3. Lightweight helpers: `throwMoss()`, `wrapAsMoss()`, `isMossError()`
 *
 * Design constraints:
 *   - Zero runtime dependencies (no zod / third-party)
 *   - `message` stays human-readable; `hint` is actionable advice for developers/users
 *   - `code` uses `DOMAIN_REASON` style, stable and never renamed (new codes don't break old codes)
 *   - `recoverable` indicates whether the business layer can retry/degrade on its own, used by agent-loop decisions
 */

export enum ErrorCode {
  /** Invalid user input (JSON Schema validation failure, missing params, bad format, etc.) */
  USER_INPUT_INVALID = 'USER_INPUT_INVALID',
  /** LLM Provider configuration missing (empty API key, invalid baseUrl) */
  PROVIDER_CONFIG_MISSING = 'PROVIDER_CONFIG_MISSING',
  /** LLM Provider network/timeout/upstream error */
  PROVIDER_UPSTREAM_ERROR = 'PROVIDER_UPSTREAM_ERROR',
  /** LLM context overflow (context window exceeded) */
  PROVIDER_CONTEXT_OVERFLOW = 'PROVIDER_CONTEXT_OVERFLOW',
  /** LLM authentication failed (401/403) */
  PROVIDER_AUTH_FAILED = 'PROVIDER_AUTH_FAILED',
  /** LLM rate limited (429) */
  PROVIDER_RATE_LIMITED = 'PROVIDER_RATE_LIMITED',
  /** Tool execution failed (tool.execute threw) */
  TOOL_EXECUTION_FAILED = 'TOOL_EXECUTION_FAILED',
  /** Tool execution timed out */
  TOOL_EXECUTION_TIMEOUT = 'TOOL_EXECUTION_TIMEOUT',
  /** Tool not found (LLM hallucinated a non-existent tool name) */
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',
  /** Tool not allowed (authorization denied) */
  TOOL_NOT_ALLOWED = 'TOOL_NOT_ALLOWED',
  /** Session not found or cannot be restored */
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  /** Session persistence to disk failed */
  SESSION_PERSIST_FAILED = 'SESSION_PERSIST_FAILED',
  /** Skill matching or loading failed */
  SKILL_LOAD_FAILED = 'SKILL_LOAD_FAILED',
  /** Mesh peer connection failed */
  MESH_PEER_UNREACHABLE = 'MESH_PEER_UNREACHABLE',
  /** Mesh peer rejected the query */
  MESH_QUERY_REJECTED = 'MESH_QUERY_REJECTED',
  /** MCP server connection or protocol error */
  MCP_CONNECTION_FAILED = 'MCP_CONNECTION_FAILED',
  /** Device SSH connection/authentication failed */
  DEVICE_SSH_FAILED = 'DEVICE_SSH_FAILED',
  /** User cancelled (AbortSignal triggered) */
  USER_ABORTED = 'USER_ABORTED',
  /** Config file read/write failed */
  CONFIG_IO_FAILED = 'CONFIG_IO_FAILED',
  /** Internal invariant violated (bug, should be fixed) */
  INTERNAL_INVARIANT_VIOLATED = 'INTERNAL_INVARIANT_VIOLATED',
  /** Uncategorized (migration use only, new code should avoid) */
  UNKNOWN = 'UNKNOWN',
}

export interface MossErrorDetails {
  code: ErrorCode;
  /** Short human-readable description */
  message: string;
  /** Actionable advice for developers or end users (what to do next) */
  hint?: string;
  /** Whether the business layer can retry/degrade on its own */
  recoverable?: boolean;
  /** Root cause (underlying Error or arbitrary metadata) */
  cause?: unknown;
  /** Associated context (runId / sessionId / toolName etc., for log aggregation) */
  context?: Record<string, unknown>;
}

/**
 * Unified error class. Prefer creating via `throwMoss()` / `wrapAsMoss()`,
 * or by subclassing. Direct `throw new MossError(...)` is also allowed.
 */
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

  /** Log-safe: structured JSON (logger already redacts sensitive fields) */
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
  return err instanceof MossError || (
    typeof err === 'object'
    && err !== null
    && (err as { name?: string }).name === 'MossError'
    && typeof (err as { code?: unknown }).code === 'string'
  );
}

export function throwMoss(details: MossErrorDetails): never {
  throw new MossError(details);
}

/**
 * Wrap any unclassified error into a MossError for consistent upward propagation.
 * - If the original error is already a MossError, return it as-is (no double-wrapping)
 * - The original error message goes into `cause` for logger output
 */
export function wrapAsMoss(
  err: unknown,
  code: ErrorCode,
  opts: Partial<Omit<MossErrorDetails, 'code' | 'message'>> & { message?: string } = {},
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

/**
 * Convert an error to a human-readable string (friendly for UI / CLI output).
 * - MossError: `[CODE] message — hint`
 * - Native Error: returns message directly
 * - Other: String(err)
 */
export function formatMossError(err: unknown): string {
  if (isMossError(err)) {
    const base = `[${err.code}] ${err.message}`;
    return err.hint ? `${base}\n→ ${err.hint}` : base;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Determine whether an error should trigger automatic retry in the agent-loop
 * (vs failing immediately and returning to the user).
 * Combines `MossError.recoverable` with a set of default recoverable codes.
 */
export function isMossErrorRecoverable(err: unknown): boolean {
  if (!isMossError(err)) return false;
  if (err.recoverable === true) return true;
  return (
    err.code === ErrorCode.PROVIDER_RATE_LIMITED
    || err.code === ErrorCode.PROVIDER_UPSTREAM_ERROR
    || err.code === ErrorCode.TOOL_EXECUTION_TIMEOUT
  );
}

/**
 * Convert any error value into a string message.
 *
 * This is the canonical one-liner used across 42+ call sites in the codebase:
 *   `err instanceof Error ? err.message : String(err)`
 *
 * Usage: `errorMessage(err)` instead of the ternary pattern.
 * Use `formatMossError()` when you also need MossError code/hint formatting.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
