/**
 * CLI exit-code system — maps structured error codes to stable numeric exit codes.
 *
 * Design:
 *   - `1` is reserved for generic/unknown failures (matches UNIX convention).
 *   - Each domain gets a distinct code so scripts can branch on exit status.
 *   - Codes are stable: once assigned, they never change.
 *   - `MossError.code` is the source of truth; this module translates it.
 *
 * Convention (aligned with sysexits.h where practical):
 *   0  = success
 *   1  = generic error (uncategorized)
 *   2  = usage / argument error
 *   3  = config error (missing config, bad config file)
 *   4  = provider auth error (401/403, missing API key)
 *   5  = provider rate limit (429)
 *   6  = provider upstream error (network, timeout, context overflow)
 *   7  = session error (not found, persist failed)
 *   8  = tool execution error
 *   9  = MCP connection error
 *   10 = device SSH error
 *   11 = user aborted
 *   12 = internal bug
 */

import { ErrorCode, isMossError } from '../errors.js';

export enum ExitCode {
  SUCCESS = 0,
  GENERIC = 1,
  USAGE = 2,
  CONFIG = 3,
  PROVIDER_AUTH = 4,
  RATE_LIMIT = 5,
  PROVIDER_UPSTREAM = 6,
  SESSION = 7,
  TOOL_EXECUTION = 8,
  MCP_CONNECTION = 9,
  DEVICE_SSH = 10,
  USER_ABORTED = 11,
  INTERNAL = 12,
}

const ERROR_CODE_TO_EXIT: Record<ErrorCode, ExitCode> = {
  [ErrorCode.USER_INPUT_INVALID]: ExitCode.USAGE,
  [ErrorCode.PROVIDER_CONFIG_MISSING]: ExitCode.CONFIG,
  [ErrorCode.PROVIDER_UPSTREAM_ERROR]: ExitCode.PROVIDER_UPSTREAM,
  [ErrorCode.PROVIDER_CONTEXT_OVERFLOW]: ExitCode.PROVIDER_UPSTREAM,
  [ErrorCode.PROVIDER_AUTH_FAILED]: ExitCode.PROVIDER_AUTH,
  [ErrorCode.PROVIDER_RATE_LIMITED]: ExitCode.RATE_LIMIT,
  [ErrorCode.TOOL_EXECUTION_FAILED]: ExitCode.TOOL_EXECUTION,
  [ErrorCode.TOOL_EXECUTION_TIMEOUT]: ExitCode.TOOL_EXECUTION,
  [ErrorCode.TOOL_NOT_FOUND]: ExitCode.TOOL_EXECUTION,
  [ErrorCode.TOOL_NOT_ALLOWED]: ExitCode.TOOL_EXECUTION,
  [ErrorCode.SESSION_NOT_FOUND]: ExitCode.SESSION,
  [ErrorCode.SESSION_PERSIST_FAILED]: ExitCode.SESSION,
  [ErrorCode.SKILL_LOAD_FAILED]: ExitCode.GENERIC,
  [ErrorCode.MESH_PEER_UNREACHABLE]: ExitCode.GENERIC,
  [ErrorCode.MESH_QUERY_REJECTED]: ExitCode.GENERIC,
  [ErrorCode.MCP_CONNECTION_FAILED]: ExitCode.MCP_CONNECTION,
  [ErrorCode.DEVICE_SSH_FAILED]: ExitCode.DEVICE_SSH,
  [ErrorCode.USER_ABORTED]: ExitCode.USER_ABORTED,
  [ErrorCode.CONFIG_IO_FAILED]: ExitCode.CONFIG,
  [ErrorCode.INTERNAL_INVARIANT_VIOLATED]: ExitCode.INTERNAL,
  [ErrorCode.UNKNOWN]: ExitCode.GENERIC,
};

/** Map a thrown error to a stable numeric exit code. */
export function exitCodeForError(err: unknown): number {
  if (isMossError(err)) {
    return ERROR_CODE_TO_EXIT[err.code] ?? ExitCode.GENERIC;
  }
  // Config file errors are a common CLI failure category
  const name = (err as { name?: string })?.name;
  if (name === 'CliConfigFileError' || name === 'CliConfigWriteError') {
    return ExitCode.CONFIG;
  }
  return ExitCode.GENERIC;
}

/** Exit the process with the appropriate code for the given error. */
export function exitWithError(err: unknown): never {
  process.exit(exitCodeForError(err));
}
