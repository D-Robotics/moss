#!/usr/bin/env node
/**
 * Error display helpers — tested from the user's perspective: when a provider
 * connection fails, does the actionable `.hint` (DNS / refused / timeout / TLS
 * / proxy) actually reach the user, or is it dropped on the floor?
 *
 * The hint is attached to MossError.hint by connection-error.ts. Two helpers
 * are the chokepoints every display path goes through:
 *   - errorMessage()  — used by the TUI run-error path, slash-command catches,
 *                       headless print, tool results (123 call sites).
 *   - describeError() — used by the agent loop to build agent_error / turn-error
 *                       event payloads that the TUI / headless printer render.
 *
 * Both previously returned only `err.message`, dropping `.hint`. formatMossError
 * included the hint but was never called anywhere. These tests lock in that the
 * hint now surfaces through both chokepoints.
 */
import assert from 'node:assert/strict';

import { MossError, errorMessage, formatMossError, isMossError, ErrorCode } from '../dist/errors.js';
import { describeError } from '../dist/provider/errors.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

const plainError = new Error('fetch failed: ENOTFOUND');
const mossNoHint = new MossError({
  code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
  message: 'fetch failed: ENOTFOUND',
});
const mossWithHint = new MossError({
  code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
  message: 'fetch failed for api.deepseek.com (ENOTFOUND: getaddrinfo ...)',
  hint: 'DNS lookup failed for api.deepseek.com — check your network connection and DNS settings. If using a VPN/proxy, ensure DNS is routed correctly.',
  recoverable: true,
});

// ─── errorMessage ──────────────────────────────────────────────────────────

{
  const out = errorMessage(plainError);
  assert.equal(out, 'fetch failed: ENOTFOUND', 'plain Error: message only, no hint marker');
  assert.ok(!out.includes('→'), 'plain Error has no hint marker');
}

{
  const out = errorMessage(mossNoHint);
  assert.equal(out, 'fetch failed: ENOTFOUND', 'MossError without hint: message only');
  assert.ok(!out.includes('→'), 'no hint → no arrow marker');
}

{
  // The fix: a MossError carrying a hint must surface it through errorMessage,
  // so the TUI run-error path (and 122 other call sites) show the actionable hint.
  const out = errorMessage(mossWithHint);
  assert.ok(out.includes('fetch failed for api.deepseek.com'), 'hint-bearing MossError: base message present');
  assert.ok(out.includes('→'), 'hint is appended with the → marker');
  assert.ok(
    out.includes('DNS lookup failed for api.deepseek.com'),
    'the actionable DNS hint text reaches the user',
  );
  assert.ok(out.includes('check your network connection'), 'full hint text preserved');
}

{
  // Non-Error value falls back to String(value).
  assert.equal(errorMessage('boom'), 'boom', 'string passthrough');
  assert.equal(errorMessage(undefined), 'undefined', 'undefined -> "undefined"');
  assert.equal(errorMessage({ x: 1 }), '[object Object]', 'object -> String()');
}

// ─── describeError (agent-loop chokepoint) ─────────────────────────────────

{
  const out = describeError(plainError);
  assert.equal(out, 'fetch failed: ENOTFOUND', 'plain Error: message only');
  assert.ok(!out.includes('→'), 'plain Error: no hint marker');
}

{
  // The fix: the agent loop builds agent_error event payloads with describeError;
  // the TUI renders those verbatim, so the hint must survive here too.
  const out = describeError(mossWithHint);
  assert.ok(out.includes('fetch failed for api.deepseek.com'), 'describeError: base message present');
  assert.ok(out.includes('→'), 'describeError: hint appended with → marker');
  assert.ok(
    out.includes('DNS lookup failed for api.deepseek.com'),
    'describeError: the actionable hint reaches the agent_error payload',
  );
}

{
  const out = describeError('a string error');
  assert.equal(out, 'a string error', 'describeError: non-Error -> String()');
}

// ─── formatMossError (already correct — lock it in) ───────────────────────

{
  const out = formatMossError(mossWithHint);
  assert.ok(out.includes('[PROVIDER_UPSTREAM_ERROR]'), 'formatMossError: code prefix');
  assert.ok(out.includes('→'), 'formatMossError: hint marker');
  assert.ok(out.includes('DNS lookup failed'), 'formatMossError: hint text');
}

{
  const out = formatMossError(plainError);
  assert.equal(out, 'fetch failed: ENOTFOUND', 'formatMossError: plain Error -> message only');
}

// ─── isMossError + round-trip ──────────────────────────────────────────────

{
  assert.equal(isMossError(mossWithHint), true, 'isMossError recognizes a MossError');
  assert.equal(isMossError(plainError), false, 'isMossError rejects a plain Error');
  // errorMessage and describeError agree on MossError output (both surface the hint).
  assert.equal(errorMessage(mossWithHint), describeError(mossWithHint), 'errorMessage and describeError agree on MossError');
}

console.error('errors: hint propagation through errorMessage / describeError / formatMossError ✓');
