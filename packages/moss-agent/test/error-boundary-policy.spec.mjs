import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ExitCode, exitCodeForError } from '../dist/cli/exit-codes.js';
import { createGoalState } from '../dist/core/goal/goal-state.js';
import { ErrorCode, MossError, isMossError, wrapAsMoss } from '../dist/errors.js';

test('public runtime input failures cross the boundary as a MossError', () => {
  assert.throws(
    () => createGoalState({ sessionKey: 'boundary-test', objective: '' }),
    (error) => {
      assert.ok(error instanceof MossError);
      assert.equal(error.code, ErrorCode.USER_INPUT_INVALID);
      return true;
    }
  );
});

test('CLI exit behavior is driven by a structured Moss error code', () => {
  const error = new MossError({
    code: ErrorCode.USER_INPUT_INVALID,
    message: 'The requested CLI value is invalid.',
  });

  assert.equal(exitCodeForError(error), ExitCode.USAGE);
});

test('contained native errors are allowed and retain their cause when wrapped at a boundary', () => {
  const internalError = new Error('low-level adapter failed');
  assert.equal(isMossError(internalError), false);

  const boundaryError = wrapAsMoss(internalError, ErrorCode.PROVIDER_UPSTREAM_ERROR, {
    message: 'Provider request failed.',
    recoverable: true,
  });

  assert.ok(boundaryError instanceof MossError);
  assert.equal(boundaryError.code, ErrorCode.PROVIDER_UPSTREAM_ERROR);
  assert.equal(boundaryError.cause, internalError);
  assert.equal(boundaryError.recoverable, true);
});

test('an existing structured error keeps its classification at the next boundary', () => {
  const original = new MossError({
    code: ErrorCode.TOOL_NOT_ALLOWED,
    message: 'Policy rejected the tool call.',
  });

  assert.equal(wrapAsMoss(original, ErrorCode.UNKNOWN), original);
});
