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
import { captureProcess } from './lib/proc.mjs';

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
await write(
  'triggered.md',
  '---\nactivation: description\ndescription: device bring up checklist\n---\nTRIGGERED-BODY: check /boot free space first.\n'
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
  assert.equal(rulesMod.ruleActivation(byName.get('triggered')), 'description');
  ok('always / globs / description / manual classified from the frontmatter');

  // ── 2. Automatic selection ─────────────────────────────────────────────

  const activeNone = rulesMod.selectActiveRules(rules, []).map(rulesMod.ruleName).sort();
  assert.deepEqual(activeNone, ['always']);
  ok('a description-only rule is no longer injected automatically');

  // ── 2b. Description activation (D9) ────────────────────────────────────

  const matched = rulesMod.matchDescriptionRules(rules, 'the device will not bring up');
  assert.deepEqual(
    matched.map((match) => rulesMod.ruleName(match.rule)),
    ['triggered']
  );
  assert.deepEqual(matched[0].matched.sort(), ['bring', 'device']);
  assert.ok(matched[0].score > 0.5);
  const unmatched = rulesMod.matchDescriptionRules(rules, 'hello, write a doc');
  assert.deepEqual(unmatched, []);
  const activeText = rulesMod
    .selectActiveRules(rules, [], 'the device will not bring up')
    .map(rulesMod.ruleName)
    .sort();
  assert.deepEqual(activeText, ['always', 'triggered']);
  ok('a description rule activates only on a matching message');

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
  assert.ok(availableText.includes('@rule:triggered'));
  assert.ok(!availableText.includes('GLOB-BODY'));
  ok('requestable rules are named with their description, without bodies');

  const describedLayer = plainLayers.get('project:rules:described') ?? '';
  assert.ok(!describedLayer.includes('TRIGGERED-BODY'));
  const describedSetup = await setupMod.createCliPromptSetup({
    workspace: dir,
    initialText: 'the device will not bring up',
  });
  const describedText = new Map(
    describedSetup.promptLayers.specs().map((spec) => [spec.id, spec.text])
  ).get('project:rules:described');
  assert.ok(describedText?.includes('TRIGGERED-BODY'));
  const allText = (layers) =>
    layers
      .specs()
      .map((spec) => spec.text)
      .join('\n');
  assert.ok(
    allText(describedSetup.promptLayers).length > allText(plain.promptLayers).length,
    'the matched rule must add bytes to the prompt'
  );
  ok('a matching message attaches the description rule body');

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

  // ── 4. `moss rules list` shows the same classes ────────────────────────
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-rules-home-'));
  try {
    const cli = path.join(root, 'dist/cli.js');
    const env = {
      ...process.env,
      HOME: home,
      MOSS_NO_RDK_DOCS: '1',
      MOSS_LANG: 'en',
      MOSS_NO_TUI: '1',
    };
    const listed = await captureProcess(process.execPath, [cli, 'rules', 'list', '--json'], {
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    assert.equal(listed.status, 0, listed.stderr);
    const payload = JSON.parse(listed.stdout);
    const classes = Object.fromEntries(payload.rules.map((rule) => [rule.name, rule.activation]));
    assert.deepEqual(classes, {
      always: 'always',
      both: 'globs',
      described: 'manual',
      globbed: 'globs',
      triggered: 'description',
    });
    ok('moss rules list --json reports the same activation classes');

    const human = await captureProcess(process.execPath, [cli, 'rules', 'list'], {
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    const text = `${human.stdout}${human.stderr}`;
    assert.equal(human.status, 0, text);
    assert.match(text, /always/);
    assert.match(text, /manual/);
    assert.match(text, /@rule:<name>/);
    ok('moss rules list prints classes and how manual rules load');

    const unknown = await captureProcess(process.execPath, [cli, 'rules', 'nope'], {
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    assert.equal(unknown.status, 2);
    ok('an unknown rules subcommand is a usage error');
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
  // ── 5. Managed rules: read-only, highest precedence (D9) ──────────────

  const managedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-managed-rules-'));
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-rules-managed-'));
  try {
    await fs.mkdir(path.join(dir2, '.moss', 'rules'), { recursive: true });
    await fs.writeFile(
      path.join(dir2, '.moss', 'rules', 'always.md'),
      'SHADOWED-BODY: workspace wins nothing.\n'
    );
    await fs.writeFile(
      path.join(managedDir, 'always.md'),
      '---\nname: always\n---\nMANAGED-BODY: organization policy.\n'
    );
    const notices = [];
    const managedRules = rulesMod.loadInstructionRules({
      workspace: dir2,
      managedPath: managedDir,
      notices,
    });
    assert.deepEqual(
      managedRules.map((rule) => [rulesMod.ruleName(rule), rule.scope]),
      [['always', 'managed']]
    );
    assert.ok(managedRules[0].text.includes('MANAGED-BODY'));
    assert.equal(
      notices.some((note) => note.includes('shadowed') && note.includes('always')),
      true
    );
    ok('managed rules win a name clash and the shadowed file is reported');

    process.env.MOSS_MANAGED_RULES = managedDir;
    const managedSetup = await setupMod.createCliPromptSetup({
      workspace: dir2,
      initialText: 'hi',
    });
    delete process.env.MOSS_MANAGED_RULES;
    const managedLayer = new Map(
      managedSetup.promptLayers.specs().map((spec) => [spec.id, spec.text])
    ).get('project:rules:always');
    assert.ok(managedLayer?.includes('MANAGED-BODY'));
    assert.ok(!managedLayer.includes('SHADOWED-BODY'));
    ok('the managed rule body joins the stable prompt without the project copy');

    const cli = path.join(root, 'dist/cli.js');
    const listedManaged = await captureProcess(process.execPath, [cli, 'rules', 'list', '--json'], {
      cwd: dir2,
      env: {
        ...process.env,
        HOME: await fs.mkdtemp(path.join(os.tmpdir(), 'moss-rules-home2-')),
        MOSS_NO_RDK_DOCS: '1',
        MOSS_MANAGED_RULES: managedDir,
        MOSS_LANG: 'en',
      },
      timeoutMs: 60_000,
    });
    assert.equal(listedManaged.status, 0, listedManaged.stderr);
    const managedPayload = JSON.parse(listedManaged.stdout);
    assert.deepEqual(
      managedPayload.rules.map((rule) => [rule.name, rule.scope]),
      [['always', 'managed']]
    );
    ok('moss rules list marks managed scope');
  } finally {
    delete process.env.MOSS_MANAGED_RULES;
    await fs.rm(managedDir, { recursive: true, force: true });
    await fs.rm(dir2, { recursive: true, force: true });
  }
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`[rules-activation] PASS (${checks} checks)`);
