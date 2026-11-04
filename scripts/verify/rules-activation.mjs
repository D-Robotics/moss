#!/usr/bin/env node
/**
 * Deterministic probe for rule activation semantics (backlog B06).
 *
 * Before this change every rule without globs was treated as always-on, so a
 * `description:` — Cursor's "agent requested" marker — silently inverted the
 * author's intent and injected the body into every prompt. Now: no globs + no
 * description stays always-on (compat), a description makes the rule
 * requestable via `@rule:<name>`, and globs still decide by touched path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const rulesMod = await import(
  pathToFileURL(path.join(root, 'dist/cli/project-instructions.js')).href
);
const setupMod = await import(pathToFileURL(path.join(root, 'dist/cli/prompt-setup.js')).href);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[rules-activation] ok ${name}`);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-rules-'));
const rulesDir = path.join(dir, '.moss', 'rules');
await fs.mkdir(rulesDir, { recursive: true });
const write = (name, content) => fs.writeFile(path.join(rulesDir, name), content);

await write('always.md', 'ALWAYS-BODY: keep changes small and verified.\n');
await write('globbed.md', '---\nglobs: src/**/*.ts\n---\nGLOB-BODY: use tabs in TypeScript.\n');
await write(
  'described.md',
  '---\ndescription: device bring-up checklist\n---\nDESCRIBED-BODY: check /boot free space first.\n'
);
await write(
  'both.md',
  '---\nglobs: docs/**/*.md\ndescription: docs style\n---\nBOTH-BODY: one sentence per line.\n'
);

try {
  const rules = rulesMod.loadInstructionRules({ workspace: dir });
  const byName = new Map(rules.map((rule) => [rulesMod.ruleName(rule), rule]));

  // ── 1. Classification ──────────────────────────────────────────────────

  assert.equal(rulesMod.ruleActivation(byName.get('always')).toString(), 'always');
  assert.equal(byName.get('always').description, undefined);
  assert.deepEqual(rulesMod.ruleActivation(byName.get('globbed')), 'globs');
  assert.equal(rulesMod.ruleActivation(byName.get('described')), 'manual');
  assert.deepEqual(rulesMod.ruleActivation(byName.get('both')), 'globs');
  ok('always / globs / manual classified from the frontmatter');

  // ── 2. Automatic selection ─────────────────────────────────────────────

  const activeNone = rulesMod.selectActiveRules(rules, []).map(rulesMod.ruleName).sort();
  assert.deepEqual(activeNone, ['always']);
  ok('a description-only rule is no longer injected automatically');

  const activeSrc = rulesMod
    .selectActiveRules(rules, ['src/main.ts'])
    .map(rulesMod.ruleName)
    .sort();
  assert.deepEqual(activeSrc, ['always', 'globbed']);
  ok('glob rules still activate by touched path');

  // ── 3. Explicit request ────────────────────────────────────────────────

  assert.deepEqual(rulesMod.requestedRuleNames('please apply @rule:described and @rule/both'), [
    'described',
    'both',
  ]);
  const requested = rulesMod
    .selectRequestedRules(rules, 'apply @rule:described')
    .map(rulesMod.ruleName);
  assert.deepEqual(requested, ['described']);
  assert.equal(
    rulesMod.selectRequestedRules(rules, 'apply @rule:globbed').length,
    0,
    'globs rules are not loadable this way'
  );
  ok('@rule:<name> loads a manual rule by name');

  // ── 4. The assembled prompt ────────────────────────────────────────────

  const plain = await setupMod.createCliPromptSetup({ workspace: dir, initialText: 'hello' });
  const plainLayers = new Map(plain.promptLayers.specs().map((spec) => [spec.id, spec.text]));
  const alwaysText = plainLayers.get('project:rules:always') ?? '';
  assert.ok(alwaysText.includes('ALWAYS-BODY'));
  assert.ok(!alwaysText.includes('DESCRIBED-BODY'));
  ok('always rule is in the stable prefix; the described body is not');

  const availableText = plainLayers.get('project:rules:available') ?? '';
  assert.ok(availableText.includes('@rule:described'));
  assert.ok(availableText.includes('device bring-up checklist'));
  assert.ok(!availableText.includes('GLOB-BODY'));
  ok('requestable rules are named with their description, without bodies');

  const requestedSetup = await setupMod.createCliPromptSetup({
    workspace: dir,
    initialText: '@rule:described the board will not boot',
  });
  const requestedLayers = new Map(
    requestedSetup.promptLayers.specs().map((spec) => [spec.id, spec.text])
  );
  const requestedText = requestedLayers.get('project:rules:requested') ?? '';
  assert.ok(requestedText.includes('DESCRIBED-BODY'));
  assert.equal(requestedLayers.get('project:rules:requested').includes('BOTH-BODY'), false);
  ok('a rule requested in the message joins the prompt');

  const untouched = await setupMod.createCliPromptSetup({ workspace: dir, initialText: 'hello' });
  assert.equal(
    untouched.promptLayers.specs().some((spec) => spec.id === 'project:rules:requested'),
    false
  );
  ok('no requested layer is created when nothing was asked for');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`[rules-activation] PASS (${checks} checks)`);
