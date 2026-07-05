#!/usr/bin/env node
/**
 * oneshot skill injection — tested from the contract side: does a fresh
 * SkillRegistry (the kind oneshot builds from cwd) match a builtin skill for a
 * task-shaped prompt, so the matched-skill context is non-empty?
 *
 * Previously oneshot/REPL got ZERO skill matching (only the TUI path called
 * buildMatchedSkillContext). The fix builds a SkillRegistry in oneshot and
 * injects buildMatchedSkillContext(registry, message) into extraContext.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SkillRegistry } from '../dist/skills/index.js';
import { buildMatchedSkillContext } from '../dist/cli/tui-utils.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-oneshot-skills-'));
try {
  const registry = new SkillRegistry({ workspaceDir: ws });

  // A task-shaped prompt should match at least one builtin skill and produce a
  // non-empty context block that includes the matched skill's body.
  const cases = [
    { prompt: 'do a code review of my diff', expectSkill: 'code-review', expectBody: 'severity' },
    { prompt: 'refactor this function for readability', expectSkill: 'refactoring', expectBody: 'preserve behavior' },
    { prompt: 'write API documentation for this module', expectSkill: 'documentation', expectBody: 'why' },
  ];

  for (const { prompt, expectSkill, expectBody } of cases) {
    const ctx = buildMatchedSkillContext(registry, prompt);
    assert.ok(ctx && ctx.length > 0, `oneshot skill context is non-empty for "${prompt}"`);
    assert.ok(ctx.includes('## Matched Skills'), `context has the Matched Skills header for "${prompt}"`);
    assert.ok(ctx.toLowerCase().includes(expectSkill.toLowerCase()),
      `context includes the ${expectSkill} skill for "${prompt}"`);
    assert.ok(ctx.toLowerCase().includes(expectBody.toLowerCase()),
      `context includes the ${expectSkill} body keyword "${expectBody}" (real instructions, not just a description)`);
  }

  // A prompt that matches nothing yields empty (no injection).
  const noMatch = buildMatchedSkillContext(registry, 'asdf qwer zxcv unrelated prompt');
  assert.equal(noMatch, '', 'no spurious skill match for an unrelated prompt');
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}

console.error('oneshot-skill-injection: fresh SkillRegistry matches builtin skills for task prompts ✓');
