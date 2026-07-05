#!/usr/bin/env node
/**
 * Builtin skills — tested from the user's perspective: when a builtin skill
 * matches the user's message, does the matched-skill context injection carry
 * REAL instructions, or just a description (which never changes model behavior)?
 *
 * Previously all 9 builtin skills had sourcePath `builtin://...` and
 * readSkillBody() returned undefined for them, so buildMatchedSkillContext
 * injected only `### <name>\n<description>` — no instructions. The fix gives
 * each builtin a `body` field and readSkillBody returns it.
 */
import assert from 'node:assert/strict';

import { listBuiltinSkills } from '../dist/skills/builtin.js';
import { readSkillBody } from '../dist/cli/tui-utils.js';

const all = listBuiltinSkills();

assert.ok(all.length >= 9, `expected at least 9 builtin skills, got ${all.length}`);

// Every builtin must carry a non-empty instruction body — the whole point of
// the fix. A description alone does not change model behavior when injected.
for (const skill of all) {
  assert.ok(
    typeof skill.body === 'string' && skill.body.trim().length > 50,
    `${skill.name} has a substantive body (>=50 chars), not just a description`,
  );
  assert.ok(
    skill.sourcePath.startsWith('builtin://'),
    `${skill.name} uses a builtin:// virtual path`,
  );
}

// readSkillBody returns the body for a builtin (previously returned undefined).
for (const skill of all) {
  const body = readSkillBody(skill);
  assert.ok(body && body.length > 50, `readSkillBody returns the body for ${skill.name}`);
  assert.ok(body === skill.body, `readSkillBody returns the exact body for ${skill.name}`);
}

// Spot-check that the highest-value builtins carry actionable steps, not
// generic filler — the code-review skill (P0 per research) must mention
// severity + diff + verify_fix.
{
  const review = all.find((s) => s.name === 'code-review');
  assert.ok(review, 'code-review builtin exists');
  const body = review.body;
  assert.ok(/severity/i.test(body), 'code-review body mentions severity');
  assert.ok(/git.*diff|diff against/i.test(body), 'code-review body tells you to read the diff');
  assert.ok(/verify_fix/i.test(body), 'code-review body references verify_fix after changes');
}

// refactoring must mention preserve-behavior + tests-first.
{
  const ref = all.find((s) => s.name === 'refactoring');
  assert.ok(ref, 'refactoring builtin exists');
  const body = ref.body;
  assert.ok(/preserve behavior/i.test(body), 'refactoring body: preserve behavior');
  assert.ok(/test/i.test(body), 'refactoring body: tests first');
}

// systematic-debugging must mention reproduce + root cause.
{
  const dbg = all.find((s) => s.name === 'superpower-systematic-debugging');
  assert.ok(dbg, 'systematic-debugging builtin exists');
  const body = dbg.body;
  assert.ok(/reproduce/i.test(body), 'debugging body: reproduce first');
  assert.ok(/root cause/i.test(body), 'debugging body: find root cause');
}

// create-presentation must mention reveal.js (HTML slides), mermaid, self-contained.
{
  const pres = all.find((s) => s.name === 'create-presentation');
  assert.ok(pres, 'create-presentation builtin exists');
  const body = pres.body;
  assert.ok(/reveal\.js/i.test(body), 'presentation body: reveal.js for HTML slides');
  assert.ok(/mermaid/i.test(body), 'presentation body: mermaid for diagrams');
  assert.ok(/self-contained/i.test(body), 'presentation body: self-contained one-file principle');
  assert.ok(/cdn/i.test(body), 'presentation body: CDN deps, no build step');
}

console.error('builtin-skills: all builtins carry real instruction bodies ✓');

// ─── skillSourceLabel — /skills shows where a skill comes from ─────────────
import { skillSourceLabel, formatSkillLine } from '../dist/cli/tui-utils.js';

{
  const builtin = all.find((s) => s.name === 'code-review');
  assert.equal(skillSourceLabel(builtin), 'builtin', 'builtin:// → builtin');

  // A file-backed skill in the workspace → workspace.
  const wsSkill = {
    ...builtin,
    name: 'my-ws-skill',
    sourcePath: '/tmp/ws/.moss/skills/my-ws-skill/SKILL.md',
  };
  assert.equal(skillSourceLabel(wsSkill, '/tmp/ws'), 'workspace', 'path under workspace → workspace');

  // A skill under ~/.claude/skills → global.
  const globalSkill = {
    ...builtin,
    name: 'my-global-skill',
    sourcePath: '/home/u/.claude/skills/my-global-skill/SKILL.md',
  };
  assert.equal(skillSourceLabel(globalSkill, '/tmp/ws'), 'global', 'path under ~/.claude → global');

  // formatSkillLine includes the source label.
  const line = formatSkillLine(builtin, '/tmp/ws');
  assert.ok(line.includes('· builtin'), 'formatSkillLine shows the source label');
}

// ─── builtin skills are now callable as /<skillname> (loadSkillCommands) ────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillRegistry } from '../dist/skills/index.js';
import { loadSkillCommands } from '../dist/cli/tui-utils.js';

{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-builtin-cmds-'));
  try {
    const registry = new SkillRegistry({ workspaceDir: ws });
    // reserved includes shipped commands like /review, /model — pass an empty
    // set here to assert builtins are surfaced when not shadowed.
    const cmds = loadSkillCommands(registry, new Set());
    const names = cmds.map((c) => c.name);
    // The highest-value builtins must be callable as /<name>.
    assert.ok(names.includes('/code-review'), 'loadSkillCommands surfaces /code-review');
    assert.ok(names.includes('/refactoring'), 'loadSkillCommands surfaces /refactoring');
    assert.ok(names.includes('/documentation'), 'loadSkillCommands surfaces /documentation');
    assert.ok(names.includes('/create-presentation'), 'loadSkillCommands surfaces /create-presentation');
    // A reserved name must NOT be shadowed by a builtin of the same name.
    // (None of the builtin names collide with shipped commands, so this is a
    // guard for the future.)
    const reserved = loadSkillCommands(registry, new Set(['/code-review']));
    assert.ok(!reserved.map((c) => c.name).includes('/code-review'),
      'a reserved name is not shadowed by a builtin skill');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}
