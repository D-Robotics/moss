#!/usr/bin/env node
/**
 * D11 parity probe: `once: true` on a skill-declared hook (Claude Code removes
 * a skill hook after its first successful run; honoured only in skill
 * frontmatter, so a project `.moss/config.json` hook keeps running).
 *
 * The claim API is what makes PostToolUse safe: those hooks fire without
 * awaiting, so two calls in flight must not both run the same once hook.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const hooks = await import(pathToFileURL(path.join(root, 'dist/core/skills/skill-hooks.js')).href);
const {
  parseSkillHooks,
  activateSkillHooks,
  activeSkillHookEntries,
  activeSkillHookSkills,
  claimSkillHookEntry,
  noteSkillHookEntryResult,
  describeActivatedSkillHooks,
  clearSkillHookState,
} = hooks;

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[skill-hook-once] ok ${name}`);
};

clearSkillHookState();

// 1. Parse keeps `once`, drops a non-boolean once value with a warning.
{
  const parsed = parseSkillHooks('hooked', {
    PostToolUse: [
      { matcher: 'exec', command: 'echo once >> marker', once: true },
      { matcher: 'exec', command: 'echo every >> marker' },
      { matcher: 'exec', command: 'echo typo >> marker', once: 'yes' },
    ],
  });
  assert.equal(parsed.ok, true);
  const activated = parsed.ok ? parsed.hooks : undefined;
  assert.ok(activated);
  assert.equal(activated.events.PostToolUse?.length, 2, 'the typed `once` is dropped');
  assert.ok(activated.warnings.some((line) => line.includes('ignored')));
  assert.ok(describeActivatedSkillHooks(activated).includes('PostToolUse 2 (1 once)'));
  ok('hooks.json keeps boolean `once`, and a string once value is a rejected entry');
}

// 2. Claim once, run again: the second call is refused until a result arrives.
{
  clearSkillHookState();
  const parsed = parseSkillHooks('hooked', {
    PostToolUse: [{ command: 'echo once >> marker', once: true }],
  });
  assert.ok(parsed.ok);
  activateSkillHooks(parsed.hooks);
  assert.equal(activeSkillHookSkills().length, 1);
  const [entry] = activeSkillHookEntries('PostToolUse');
  assert.ok(entry);
  assert.equal(claimSkillHookEntry(entry), true, 'first call claims');
  assert.equal(claimSkillHookEntry(entry), false, 'a second in-flight call is refused');
  noteSkillHookEntryResult(entry, true);
  assert.equal(activeSkillHookEntries('PostToolUse').length, 0, 'a successful run retires it');
  assert.equal(claimSkillHookEntry(entry), false, 'a retired entry never runs again');
  ok('one claim per run, and success retires the hook');
}

// 3. A failed run re-arms it; non-once entries are never affected.
{
  clearSkillHookState();
  const parsed = parseSkillHooks('hooked', {
    PreToolUse: [{ command: 'exit 1', once: true }, { command: 'echo every' }],
  });
  assert.ok(parsed.ok);
  activateSkillHooks(parsed.hooks);
  const entries = activeSkillHookEntries('PreToolUse');
  assert.equal(entries.length, 2);
  const [onceEntry] = entries;
  assert.ok(onceEntry);
  assert.equal(claimSkillHookEntry(onceEntry), true);
  noteSkillHookEntryResult(onceEntry, false);
  assert.equal(activeSkillHookEntries('PreToolUse').length, 2, 'failure keeps the hook armed');
  assert.equal(claimSkillHookEntry(onceEntry), true, 'a failed run can retry');
  noteSkillHookEntryResult(onceEntry, true);
  assert.equal(activeSkillHookEntries('PreToolUse').length, 1, 'only the once entry was retired');
  ok('failure re-arms the hook; non-once entries survive retirement');
}

// 4. Re-invoking the skill re-arms once hooks (new entries, fresh state).
{
  clearSkillHookState();
  const raw = { PostToolUse: [{ command: 'echo once >> marker', once: true }] };
  const first = parseSkillHooks('hooked', raw);
  assert.ok(first.ok);
  activateSkillHooks(first.hooks);
  const [firstEntry] = activeSkillHookEntries('PostToolUse');
  assert.ok(firstEntry);
  assert.equal(claimSkillHookEntry(firstEntry), true);
  noteSkillHookEntryResult(firstEntry, true);
  assert.equal(activeSkillHookEntries('PostToolUse').length, 0);

  const second = parseSkillHooks('hooked', raw);
  assert.ok(second.ok);
  activateSkillHooks(second.hooks);
  assert.equal(activeSkillHookEntries('PostToolUse').length, 1, 're-invocation re-arms it');
  ok('re-invoking the skill re-arms its once hooks');
}

console.log(`[skill-hook-once] ${checks}/4 checks passed`);
