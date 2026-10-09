#!/usr/bin/env node
/**
 * P0-1: /init is a real command. On main the catalog told the REPL the name
 * existed and the REPL answered "not available".
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findRegistryCommand } from '../dist/cli/commands/registry.js';

const match = findRegistryCommand('/init');
assert.ok(match, '/init is a registry command');
assert.equal(match.spec.name, '/init');

async function runInit(workspace) {
  const said = [];
  let submitted = null;
  await match.spec.run(
    {
      agent: {},
      runtime: undefined,
      sessionKey: 'init-spec',
      workspace,
      surface: 'repl',
      say(_kind, text) {
        said.push(text);
      },
      prefillInput() {},
      submitPrompt(text) {
        submitted = text;
      },
    },
    ''
  );
  return { said, submitted };
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-init-new-'));
  const { said, submitted } = await runInit(workspace);
  assert.ok(submitted, '/init calls submitPrompt when AGENTS.md is missing');
  assert.match(submitted, /AGENTS\.md/, 'the prompt names AGENTS.md');
  assert.match(submitted, /create an AGENTS\.md/i, 'a missing file is created, not reviewed');
  assert.ok(
    said.some((line) => /Drafting AGENTS\.md/.test(line)),
    'the user sees that a draft started'
  );
  assert.ok(
    !said.some((line) => /not available/i.test(line)),
    '/init must not answer "not available"'
  );
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-init-old-'));
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Existing\n\nKeep this.\n');
  const { submitted } = await runInit(workspace);
  assert.match(submitted, /already exists/i, 'an existing AGENTS.md is reviewed in place');
  assert.match(submitted, /AGENTS\.md/);
}

console.log('[PASS] cli init command');
