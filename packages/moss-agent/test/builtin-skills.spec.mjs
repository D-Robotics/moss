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

console.error('builtin-skills: all builtins carry real instruction bodies ✓');
