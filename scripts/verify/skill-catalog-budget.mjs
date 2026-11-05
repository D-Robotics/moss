#!/usr/bin/env node
/**
 * L1 skill-catalog budget scales with the model window (Claude parity).
 *
 * Claude Code budgets its skill listing at ~1% of the model's context window
 * (8,000-char fallback). Moss used a fixed 8,000 chars, which on a 32k window
 * would spend ~25% of the prompt on skill names. This probe pins the formula,
 * the degradation ladder under each budget, the SDK fallback and `/skills`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const catalogModule = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-catalog.js')).href
);
const agentModule = await import(
  pathToFileURL(path.join(root, 'dist/core/agent/moss-agent.js')).href
);
const sessionModule = await import(
  pathToFileURL(path.join(root, 'dist/core/session/session.js')).href
);
const commands = await import(pathToFileURL(path.join(root, 'dist/cli/skill-commands.js')).href);

const {
  skillCatalogBudgetForWindow,
  renderSkillCatalog,
  SKILL_CATALOG_BUDGET_FLOOR_CHARS,
  SKILL_CATALOG_DEFAULT_BUDGET_CHARS,
} = catalogModule;

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[skill-catalog-budget] ok ${name}`);
};

function skill(name, description) {
  return {
    name,
    description,
    allowedTools: [],
    disallowedTools: [],
    modelInvocable: true,
    metadata: {},
    globs: [],
    scope: 'workspace',
    dir: `/virtual/skills/${name}`,
    file: `/virtual/skills/${name}/SKILL.md`,
    body: `# ${name}\n`,
    resources: { scripts: [], references: [], assets: [], evals: false },
    issues: [],
    legacy: false,
  };
}

// 1. Formula: 1% of the window in chars, 8k ceiling, readable floor.
assert.equal(skillCatalogBudgetForWindow(200_000), 8_000, '200k window → 1% is the 8k ceiling');
assert.equal(skillCatalogBudgetForWindow(128_000), 5_120);
assert.equal(skillCatalogBudgetForWindow(32_000), 1_280);
assert.equal(
  skillCatalogBudgetForWindow(16_000),
  SKILL_CATALOG_BUDGET_FLOOR_CHARS,
  'tiny windows get the readable floor, not 640 chars'
);
assert.equal(skillCatalogBudgetForWindow(undefined), SKILL_CATALOG_DEFAULT_BUDGET_CHARS);
assert.equal(skillCatalogBudgetForWindow(0), SKILL_CATALOG_DEFAULT_BUDGET_CHARS);
ok('budget = 1% of the window in chars (8k ceiling, 800-char floor, 8k fallback)');

// 2. The renderer respects each budget and degrades detail, never exceeding it.
const library = Array.from({ length: 40 }, (_, index) =>
  skill(
    `skill-${String(index).padStart(2, '0')}`,
    `Probe skill number ${String(index)}: a deliberately long description that would overflow any small catalog budget if every entry kept its full keywords and phrasing, which is exactly the pressure the 1% rule exists to bound.`
  )
);
const defaultRender = renderSkillCatalog(library, { budgetChars: 8_000 });
assert.ok(defaultRender.text);
assert.ok(defaultRender.text.length <= 8_000);
for (const tokens of [128_000, 32_000, 16_000]) {
  const budgetChars = skillCatalogBudgetForWindow(tokens);
  const rendered = renderSkillCatalog(library, { budgetChars });
  assert.ok(rendered.text, `${String(tokens)} must still render a catalog`);
  assert.ok(
    rendered.text.length <= budgetChars,
    `${String(tokens)}: ${String(rendered.text.length)} chars over budget ${String(budgetChars)}`
  );
  assert.ok(
    rendered.stats.renderedChars <= rendered.stats.uncappedChars,
    'a budget never inflates the catalog'
  );
  if (tokens < 200_000) {
    assert.notEqual(rendered.stats.strategy, 'full', `${String(tokens)} must compress entries`);
  }
}
const tiny = renderSkillCatalog(library, { budgetChars: skillCatalogBudgetForWindow(16_000) });
assert.ok(tiny.text.length <= SKILL_CATALOG_BUDGET_FLOOR_CHARS);
ok('40 skills stay under every window budget and compress instead of overflowing');

// 3. The SDK fallback catalog uses the same window-derived budget.
function makeAgent(contextTokens) {
  return new agentModule.MossAgent({
    llmProvider: {
      id: 'scripted',
      displayName: 'scripted',
      capabilities: { streaming: false },
      async complete() {
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
      },
    },
    sessionStore: new sessionModule.InMemorySessionStore(),
    baseSystemPrompt: 'probe',
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    skills: { manifests: () => library },
  });
}
const smallAgent = makeAgent(32_000);
smallAgent.composeSystemPrompt();
const smallStats = smallAgent.skillCatalogStats();
assert.ok(smallStats);
assert.equal(
  smallStats.renderedChars <= 1_280,
  true,
  `SDK fallback: ${String(smallStats.renderedChars)} > 1280`
);
const largeAgent = makeAgent(200_000);
largeAgent.composeSystemPrompt();
const largeStats = largeAgent.skillCatalogStats();
assert.ok(largeStats);
assert.ok(
  largeStats.renderedChars > smallStats.renderedChars,
  'a bigger window buys more catalog detail'
);
const unknownAgent = makeAgent(undefined);
unknownAgent.composeSystemPrompt();
assert.equal(unknownAgent.skillCatalogStats().renderedChars <= 8_000, true);
ok('SDK fallback catalog scales with contextTokens (and keeps the 8k fallback when unknown)');

// 4. `/skills` reports the real in-session budget and stays inside it.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-catalog-budget-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-catalog-budget-cfg-'));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-catalog-budget-home-'));
process.env.HOME = fakeHome;
for (const entry of library.slice(0, 12)) {
  const dir = path.join(workspace, '.moss', 'skills', entry.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n\n# ${entry.name}\n`
  );
}
const smallList = await commands.renderSkillsList(workspace, configDir, false, 32_000);
const smallSummary = smallList.split('\n').find((line) => line.includes('skill(s); catalog')) ?? '';
assert.ok(
  smallSummary.includes(`/1_280`.replace('_', '')),
  `32k summary must say 1280: ${smallSummary}`
);
const smallRendered = Number(
  /catalog ([\d,]+)\//.exec(smallSummary)?.[1]?.replaceAll(',', '') ?? '-1'
);
assert.ok(smallRendered > 0 && smallRendered <= 1_280, `rendered ${String(smallRendered)}`);
const defaultList = await commands.renderSkillsList(workspace, configDir, false);
const defaultSummary =
  defaultList.split('\n').find((line) => line.includes('skill(s); catalog')) ?? '';
assert.ok(defaultSummary.includes('/8000'), `no window → 8k fallback: ${defaultSummary}`);
ok('/skills uses the window budget in-session and the 8k fallback without a window');

console.log(`[skill-catalog-budget] ${checks}/4 checks passed`);
