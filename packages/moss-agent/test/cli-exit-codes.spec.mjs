#!/usr/bin/env node
/**
 * Verify exitCodeForError() maps every ErrorCode variant to the expected
 * numeric exit code, and that non-MossError types fall through correctly.
 *
 * Run:
 *   npm run build -w @rdk-moss/agent
 *   node packages/moss-agent/test/cli-exit-codes.spec.mjs
 */
import assert from 'node:assert/strict';
import { MossError, ErrorCode, isMossError } from '../dist/errors.js';
import { exitCodeForError, ExitCode } from '../dist/cli/exit-codes.js';

// ── MossError mappings ──────────────────────────────────────────

const MAPPINGS = [
  [ErrorCode.USER_INPUT_INVALID, ExitCode.USAGE],
  [ErrorCode.PROVIDER_CONFIG_MISSING, ExitCode.CONFIG],
  [ErrorCode.PROVIDER_UPSTREAM_ERROR, ExitCode.PROVIDER_UPSTREAM],
  [ErrorCode.PROVIDER_CONTEXT_OVERFLOW, ExitCode.PROVIDER_UPSTREAM],
  [ErrorCode.PROVIDER_AUTH_FAILED, ExitCode.PROVIDER_AUTH],
  [ErrorCode.PROVIDER_RATE_LIMITED, ExitCode.RATE_LIMIT],
  [ErrorCode.TOOL_EXECUTION_FAILED, ExitCode.TOOL_EXECUTION],
  [ErrorCode.TOOL_EXECUTION_TIMEOUT, ExitCode.TOOL_EXECUTION],
  [ErrorCode.TOOL_NOT_FOUND, ExitCode.TOOL_EXECUTION],
  [ErrorCode.TOOL_NOT_ALLOWED, ExitCode.TOOL_EXECUTION],
  [ErrorCode.SESSION_NOT_FOUND, ExitCode.SESSION],
  [ErrorCode.SESSION_PERSIST_FAILED, ExitCode.SESSION],
  [ErrorCode.SKILL_LOAD_FAILED, ExitCode.GENERIC],
  [ErrorCode.MESH_PEER_UNREACHABLE, ExitCode.GENERIC],
  [ErrorCode.MESH_QUERY_REJECTED, ExitCode.GENERIC],
  [ErrorCode.MCP_CONNECTION_FAILED, ExitCode.MCP_CONNECTION],
  [ErrorCode.DEVICE_SSH_FAILED, ExitCode.DEVICE_SSH],
  [ErrorCode.USER_ABORTED, ExitCode.USER_ABORTED],
  [ErrorCode.CONFIG_IO_FAILED, ExitCode.CONFIG],
  [ErrorCode.INTERNAL_INVARIANT_VIOLATED, ExitCode.INTERNAL],
  [ErrorCode.UNKNOWN, ExitCode.GENERIC],
];

let passed = 0;
for (const [code, expected] of MAPPINGS) {
  const err = new MossError({ code, message: `test: ${code}` });
  const actual = exitCodeForError(err);
  assert.equal(
    actual,
    expected,
    `exitCodeForError(${code}) → ${actual}, expected ${expected}`,
  );
  passed++;
}
console.log(`  [PASS] ${passed} ErrorCode → ExitCode mappings`);

// ── MossError with hint / recoverable doesn't affect mapping ────

{
  const err = new MossError({
    code: ErrorCode.PROVIDER_AUTH_FAILED,
    message: 'bad key',
    hint: 'Run `moss config` to set your API key.',
    recoverable: false,
  });
  assert.equal(exitCodeForError(err), ExitCode.PROVIDER_AUTH,
    'hint + recoverable must not change exit code');
  console.log('  [PASS] hint + recoverable do not affect exit code');
}

// ── Missing/unknown ErrorCode falls back to GENERIC ──────────────
// Although the current map is exhaustive, this guards against future
// ErrorCode additions that forget to update the mapping.

{
  const err = { name: 'MossError', code: 'FUTURE_CODE_NOT_YET_MAPPED', message: 'future' };
  assert.equal(exitCodeForError(err), ExitCode.GENERIC,
    'future ErrorCode must return GENERIC (1)');
  console.log('  [PASS] unmapped ErrorCode falls back to GENERIC');
}

// ── Non-MossError (plain Error) ─────────────────────────────────

{
  assert.equal(exitCodeForError(new Error('plain')), ExitCode.GENERIC);
  console.log('  [PASS] plain Error → GENERIC');
}

// ── Non-MossError (string) ──────────────────────────────────────

{
  assert.equal(exitCodeForError('something broke'), ExitCode.GENERIC);
  console.log('  [PASS] string → GENERIC');
}

// ── CliConfigFileError / CliConfigWriteError → CONFIG ────────────

{
  const err = new Error('cannot read config');
  (err).name = 'CliConfigFileError';
  assert.equal(exitCodeForError(err), ExitCode.CONFIG,
    'CliConfigFileError → CONFIG (3)');
  console.log('  [PASS] CliConfigFileError → CONFIG');
}

{
  const err = new Error('cannot write config');
  (err).name = 'CliConfigWriteError';
  assert.equal(exitCodeForError(err), ExitCode.CONFIG,
    'CliConfigWriteError → CONFIG (3)');
  console.log('  [PASS] CliConfigWriteError → CONFIG');
}

// ── Edge: null/undefined ─────────────────────────────────────────

{
  assert.equal(exitCodeForError(null), ExitCode.GENERIC);
  assert.equal(exitCodeForError(undefined), ExitCode.GENERIC);
  console.log('  [PASS] null / undefined → GENERIC');
}

// ── MossError subclass recognized via isMossError() name fallback ──

{
  // A subclass that extends plain Error (not MossError) but carries
  // name === 'MossError' and a string code — this is the cross-realm /
  // serialization-deserialization scenario where instanceof fails.
  class SubError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'MossError';
      this.code = code;
    }
  }
  const err = new SubError('cross-realm', ErrorCode.CONFIG_IO_FAILED);
  assert.equal(isMossError(err), true,
    'SubError with name=MossError + code → isMossError(...) returns true');
  const code = exitCodeForError(err);
  assert.equal(code, ExitCode.CONFIG,
    'exitCodeForError on cross-realm look-alike → CONFIG');
  console.log('  [PASS] MossError look-alike (name fallback) → isMossError + correct exit code');
}

// ── Cross-realm: plain object matching MossError shape ────────

{
  // Not an Error instance at all — just a plain object that
  // isMossError recognizes via duck typing.
  const crossRealm = { name: 'MossError', code: ErrorCode.PROVIDER_RATE_LIMITED, message: 'fake' };
  assert.equal(isMossError(crossRealm), true,
    'plain object with name=MossError + string code → isMossError returns true');
  assert.equal(exitCodeForError(crossRealm), ExitCode.RATE_LIMIT,
    'cross-realm MossError look-alike → RATE_LIMIT (5)');
  console.log('  [PASS] cross-realm MossError look-alike → correct exit code');
}

console.log('[PASS] cli-exit-codes');
