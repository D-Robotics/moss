#!/usr/bin/env node
/** A timed-out exec says it timed out. It does not report exit 1. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execTool } from '../dist/tools/builtin.js';
import { ProcessError, runProcess } from '../dist/utils/run-process.js';

{
  let caught;
  try {
    await runProcess('sleep', { args: ['2'], timeout: 200 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ProcessError);
  assert.equal(caught.timedOut, true);
  assert.match(caught.message, /^timed out after 200ms$/);
}

{
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-exec-timeout-'));
  const text = await execTool.execute(
    { command: 'sleep 2', timeout_ms: 200 },
    { workspaceDir, sessionKey: 'timeout', abortSignal: new AbortController().signal }
  );
  assert.match(text, /timed out after 200ms \(raise timeout_ms or use exec_background\)/);
  assert.doesNotMatch(text, /exit 1/);
  assert.doesNotMatch(text, /Command failed/);
}

console.log('[PASS] exec timeout');
