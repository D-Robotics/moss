#!/usr/bin/env node
/**
 * SkillRegistry.setEnabled — per-session enable/disable of a skill by name.
 * Disabling stops a skill from matching in matchByText (auto-injection) and
 * from being surfaced as a /<skillname> command (loadSkillCommands).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SkillRegistry } from '../dist/skills/index.js';
import { loadSkillCommands } from '../dist/cli/tui-utils.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-toggle-'));
try {
  const registry = new SkillRegistry({ workspaceDir: ws });

  // The code-review builtin matches a code-review prompt by default.
  const before = registry.matchByText('do a code review of my diff');
  assert.ok(before.some((s) => s.name === 'code-review'),
    'code-review matches by default');

  // Disable it.
  const hit = registry.setEnabled('code-review', false);
  assert.equal(hit, true, 'setEnabled returns true when a skill was found');

  // Now it must NOT match.
  const after = registry.matchByText('do a code review of my diff');
  assert.ok(!after.some((s) => s.name === 'code-review'),
    'disabled code-review no longer matches');

  // And it must NOT be surfaced as a /command.
  const cmds = loadSkillCommands(registry, new Set());
  assert.ok(!cmds.some((c) => c.name === '/code-review'),
    'disabled code-review is not a /command');

  // Re-enable restores matching + /command.
  registry.setEnabled('code-review', true);
  const re = registry.matchByText('do a code review of my diff');
  assert.ok(re.some((s) => s.name === 'code-review'),
    're-enabled code-review matches again');

  // Disabling an unknown name returns false (no-op).
  const miss = registry.setEnabled('no-such-skill', false);
  assert.equal(miss, false, 'setEnabled returns false for an unknown name');

  // Disabling one skill doesn't affect others.
  registry.setEnabled('code-review', false);
  const ref = registry.matchByText('refactor this function');
  assert.ok(ref.some((s) => s.name === 'refactoring'),
    'disabling code-review does not affect refactoring');
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

console.error('skill-toggle: setEnabled disables matching + /command, re-enable restores ✓');
