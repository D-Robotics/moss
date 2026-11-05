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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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

// ── 5. In-session `/skills` reports the same table as `moss skill list` ────
//
// D10: the REPL and TUI used to print their own narrow row (name + first
// description line). The shared renderer existed but only `moss skill list`
// used it, so scope / real usage / catalog cost were invisible in-session.

const listProbe = await import(pathToFileURL(path.join(root, 'dist/cli/skill-commands.js')).href);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-parity-'));
const tmpWs = path.join(tmpRoot, 'ws');
const tmpCfg = path.join(tmpRoot, 'config');
fs.mkdirSync(path.join(tmpWs, '.moss', 'skills', 'parity-skill'), { recursive: true });
fs.mkdirSync(tmpCfg, { recursive: true });
fs.writeFileSync(
  path.join(tmpWs, '.moss', 'skills', 'parity-skill', 'SKILL.md'),
  '---\nname: parity-skill\ndescription: Parity probe skill\n---\n# Parity\nprobe body\n'
);
// Real usage: the session-row columns must come from the same file `skill list` reads.
fs.writeFileSync(
  path.join(tmpWs, '.moss', 'skills-usage.json'),
  JSON.stringify({ 'parity-skill': { count: 3, lastUsedAt: '2026-11-05T00:00:00.000Z' } })
);
fs.writeFileSync(
  path.join(tmpCfg, 'config.json'),
  JSON.stringify({
    provider: 'openai-compatible',
    model: 'm',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-test',
    permissions: { defaultMode: 'full' },
    agent: { contextTokens: 200_000 },
  })
);
const expected = (await listProbe.renderSkillsList(tmpWs, tmpCfg, false)).split('\n');
const replOut = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, 'dist/cli.js')], {
    cwd: path.join(fs.realpathSync(tmpWs)),
    env: {
      PATH: process.env.PATH,
      HOME: tmpRoot,
      MOSS_CONFIG_DIR: tmpCfg,
      MOSS_NO_TUI: '1',
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_COLOR: '1',
      MOSS_LANG: 'en',
      MOSS_TRUST_WORKSPACE: '1',
      TERM: 'dumb',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    out += String(chunk);
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.on('close', () => {
    clearTimeout(timer);
    resolve(out);
  });
  child.stdin.end('/skills\n/exit\n');
});
const printed = replOut
  .split('\n')
  .map((line) => line.replace(/\s+$/, ''))
  .filter(
    (line) => line.includes('parity-skill') || line.includes('name ') || line.includes('catalog')
  )
  .join('\n');
// Compare only what both sides can see: the probe's HOME differs from this
// process's, so user-scope skills from the real home must not enter the check.
for (const line of expected.filter((row) => row.includes('parity-skill'))) {
  assert.ok(
    replOut.includes(line.trimEnd()),
    `REPL /skills must print the shared row verbatim: missing ${JSON.stringify(line)} in ${JSON.stringify(printed)}`
  );
}
const header = expected.find((row) => row.includes('catalog') && row.includes('scope'));
assert.ok(header, 'the shared renderer must start with its column header');
assert.ok(
  replOut.includes(header.trimEnd()),
  `REPL /skills must print the shared header: missing ${JSON.stringify(header)}`
);
assert.match(replOut, /workspace\s+3\s+\d+\s+-\s+Parity probe skill/u);
ok('in-session /skills prints the `moss skill list` table (scope + usage + catalog cost)');
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`[skill-catalog-usage] PASS (${checks} checks)`);
