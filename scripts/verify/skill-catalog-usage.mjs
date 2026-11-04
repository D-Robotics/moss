#!/usr/bin/env node
/**
 * Deterministic probe for the usage-aware skill catalog (backlog B10).
 *
 * The catalog is re-sent every turn under a character budget, so the order in
 * which entries degrade decides what a session can still discover. Ranks used to
 * be scope-then-name: the skill that got cut was whichever sorted first, even if
 * the session loads it every day. Now recorded use (`.moss/skills-usage.json`)
 * ranks first inside a scope, so the least-recently-used entry loses its
 * description or disappears first.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const catalog = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-catalog.js')).href
);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[skill-catalog-usage] ok ${name}`);
}

function skill(name, scope = 'workspace', description = `${name} skill description`) {
  return {
    name,
    description,
    when: `use ${name}`,
    allowedTools: [],
    disallowedTools: [],
    metadata: {},
    globs: [],
    scope,
    dir: `/tmp/${name}`,
  };
}

function order(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split(':')[0].split(' ')[0]);
}

const usage = (names) =>
  Object.fromEntries(
    names.map((name, index) => [
      name,
      { count: index + 1, lastUsedAt: `2026-11-0${index + 1}T00:00:00.000Z` },
    ])
  );

// ── 1. No usage → the historical scope-then-name order ─────────────────────

const plain = catalog.renderSkillCatalog([skill('bravo'), skill('alpha'), skill('charlie')]);
assert.deepEqual(order(plain.text), ['alpha', 'bravo', 'charlie']);
assert.equal(plain.stats.usageAware, false);
ok('without usage the catalog keeps the deterministic alphabetical order');

// ── 2. Used entries rank first, most recent first ─────────────────────────

const used = catalog.renderSkillCatalog([skill('bravo'), skill('alpha'), skill('charlie')], {
  usage: usage(['bravo', 'charlie']),
});
assert.deepEqual(order(used.text), ['charlie', 'bravo', 'alpha']);
assert.equal(used.stats.usageAware, true);
ok('recently used skills lead their scope and unused ones sink');

// ── 2b. The exported rank order is what the CLI table now follows ─────────

assert.deepEqual(
  catalog
    .rankSkillsForCatalog([skill('bravo'), skill('alpha'), skill('charlie')], usage(['bravo']))
    .map((entry) => entry.name),
  ['bravo', 'alpha', 'charlie']
);
assert.deepEqual(
  catalog
    .rankSkillsForCatalog([skill('bravo'), skill('alpha'), skill('charlie')])
    .map((entry) => entry.name),
  ['alpha', 'bravo', 'charlie']
);
ok('rankSkillsForCatalog drives both the prompt catalog and `moss skill list`');

// ── 3. Scope precedence is still the primary key ──────────────────────────

const scoped = catalog.renderSkillCatalog(
  [skill('user-hot', 'user'), skill('workspace-cold', 'workspace')],
  { usage: usage(['user-hot']) }
);
assert.deepEqual(order(scoped.text), ['workspace-cold', 'user-hot']);
ok('a used user skill does not jump ahead of the workspace scope');

// ── 4. Under a one-upgrade budget, the used skill gets the rich line ──────

// Header cost = text length of a catalog that can only render its header.
const bare = { ...skill('aa-skill'), description: '', when: undefined };
const headerCost = catalog.renderSkillCatalog([bare], { budgetChars: 40 }).text.length;
const three = [skill('aa-skill'), skill('bb-skill'), skill('cc-skill')];
const fullLine = (name) =>
  catalog
    .renderSkillCatalog([skill(name)], { budgetChars: 100_000 })
    .text.split('\n')
    .at(-1);
const nameLine = (name) => `- ${name}`;
const baseline3 =
  headerCost +
  1 +
  nameLine('aa-skill').length +
  1 +
  nameLine('bb-skill').length +
  1 +
  nameLine('cc-skill').length;
const delta = fullLine('cc-skill').length - nameLine('cc-skill').length;
// Room for exactly one description upgrade, everything else stays name-only.
const oneUpgrade = baseline3 + delta + 1;
const picked = catalog.renderSkillCatalog(three, {
  budgetChars: oneUpgrade,
  usage: usage(['cc-skill']),
});
const usedLines = picked.text.split('\n').filter((line) => line.startsWith('- '));
assert.equal(picked.stats.strategy, 'mixed');
assert.deepEqual(usedLines, [
  '- cc-skill: cc-skill skill description (when: use cc-skill)',
  '- aa-skill',
  '- bb-skill',
]);
ok('the single affordable upgrade goes to the most recently used skill');

const plainUpgrade = catalog.renderSkillCatalog(three, { budgetChars: oneUpgrade });
const plainLines = plainUpgrade.text.split('\n').filter((line) => line.startsWith('- '));
assert.equal(
  plainLines[0],
  '- aa-skill: aa-skill skill description (when: use aa-skill)',
  'without usage the alphabetically first entry wins the budget'
);
ok('without usage the same budget upgrades the alphabetically first entry');

console.log(`[skill-catalog-usage] PASS (${checks} checks)`);
