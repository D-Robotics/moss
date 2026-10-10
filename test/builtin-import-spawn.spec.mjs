#!/usr/bin/env node
/**
 * cli-main imports builtin for every subcommand. That import must not resolve
 * the host shell: on Windows the default probe spawns where.exe and pwsh.
 */
import assert from 'node:assert/strict';

import { execTool } from '../dist/tools/builtin.js';
import { hostShellDefaultProbeCount } from '../dist/utils/host-shell.js';

const descriptor = Object.getOwnPropertyDescriptor(execTool, 'description');
assert.equal(typeof descriptor?.get, 'function', 'exec description is resolved on read');
assert.equal(
  hostShellDefaultProbeCount(),
  0,
  'importing builtin must not probe (or spawn) the host shell'
);

assert.match(execTool.description, /Run a shell command/);
assert.equal(hostShellDefaultProbeCount(), 1, 'the first description read probes once');

console.log('[PASS] builtin import does not probe the host shell');
