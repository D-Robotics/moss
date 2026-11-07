#!/usr/bin/env node
/**
 * Spec `disable-model-invocation` probe (Claude Code / Cursor parity).
 *
 * A skill marked `disable-model-invocation: true` must:
 * (1) keep loading as a skill (its slash command stays user-invocable),
 * (2) leave the model's L1 catalog entirely (zero catalog characters),
 * (3) be refused by the `skill` tool with actionable guidance, never its body,
 * (4) still appear in `/skills` as `manual`, while the budget summary ignores it,
 * (5) leave every ordinary skill fully model-invocable.
 * An unparseable value must warn and stay invocable (fail-open on authoring
 * errors, like the spec's other booleans).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const registry = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-registry.js')).href
);
const catalogModule = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-catalog.js')).href
);
const toolModule = await import(
  pathToFileURL(path.join(root, 'dist/core/skills/skill-tool.js')).href
);
const commands = await import(pathToFileURL(path.join(root, 'dist/cli/skill-commands.js')).href);
const custom = await import(
  pathToFileURL(path.join(root, 'dist/cli/commands/custom-commands.js')).href
);

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-invocation-'));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-invocation-cfg-'));
// Keep the listing deterministic: `/skills` also scans ~/.claude/skills, so point
// HOME at an empty temp dir instead of the developer's real home.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-skill-invocation-home-'));
process.env.HOME = fakeHome;
const skillsDir = path.join(workspace, '.moss', 'skills');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[skill-model-invocation] ok ${name}`);
};

function writeSkill(name, frontmatter = '') {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: probe skill ${name}\n${frontmatter}---\n\n# ${name}\n\nBody for ${name}.\n`
  );
}

writeSkill('release-deploy', 'disable-model-invocation: true\n');
writeSkill('hotfix-yes', 'disable-model-invocation: YES\n');
writeSkill('broken-flag', 'disable-model-invocation: maybe\n');
writeSkill('ordinary', '');

const issues = [];
const skills = registry.loadSkills([skillsDir], { onIssue: (issue) => issues.push(issue) });
const byName = new Map(skills.map((skill) => [skill.name, skill]));

// 1. Parsing: boolean spellings, default, and fail-open on garbage.
assert.equal(byName.get('release-deploy').modelInvocable, false);
assert.equal(byName.get('hotfix-yes').modelInvocable, false, 'YAML 1.1 yes is a true value');
assert.equal(byName.get('ordinary').modelInvocable, true);
assert.equal(byName.get('broken-flag').modelInvocable, true, 'garbage must not hide a skill');
assert.ok(
  byName
    .get('broken-flag')
    .issues.some((issue) => issue.code === 'unknown-disable-model-invocation'),
  'garbage value is reported, not silently ignored'
);
ok('disable-model-invocation parses booleans, defaults to invocable, fails open with an issue');

// 2. The model catalog excludes manual skills entirely.
const filtered = skills.filter((skill) => skill.modelInvocable);
const filteredText = catalogModule.renderSkillCatalog(filtered).text ?? '';
assert.ok(filteredText.includes('ordinary'));
assert.ok(!filteredText.includes('release-deploy'), 'user-only skill must not cost catalog chars');
assert.ok(!filteredText.includes('hotfix-yes'));
const unfilteredText = catalogModule.renderSkillCatalog(skills).text ?? '';
assert.ok(unfilteredText.includes('release-deploy'), 'renderer itself stays host-agnostic');
ok('model catalog drops user-only skills; the renderer stays a pure filter boundary');

// 3. The skill tool refuses a manual skill and never returns its body.
const tool = toolModule.createSkillTool(skills);
const ctx = { workspaceDir: workspace, sessionKey: 'probe-session', runId: 'probe-run' };
const refused = await tool.execute({ name: 'release-deploy' }, ctx);
assert.match(refused, /user-invocable only/);
assert.match(refused, /disable-model-invocation: true/);
assert.match(refused, /Ask the user to run it/);
assert.ok(!refused.includes('Body for release-deploy'), 'refusal must not leak the body');
ok('skill tool refuses a user-only skill with guidance and no body');

// 4. Ordinary skills still load normally.
const loaded = await tool.execute({ name: 'ordinary' }, ctx);
assert.match(loaded, /# Skill: ordinary/);
assert.match(loaded, /Body for ordinary/);
ok('ordinary skills still load through the same tool');

// 5. User-invocation surface: the slash token survives for manual skills.
assert.equal(custom.skillSlashToken(byName.get('release-deploy')), '/release-deploy');
assert.equal(custom.skillSlashToken(byName.get('ordinary')), '/ordinary');
ok('user-only skills keep their slash command (user-invocable)');

// 6. `/skills` marks manual entries and excludes them from the catalog budget.
const list = await commands.renderSkillsList(workspace, configDir);
const releaseRow = list.split('\n').find((line) => line.includes('release-deploy')) ?? '';
assert.match(releaseRow, /user-only/, '/skills must mark a user-only skill');
assert.ok(list.includes('ordinary'));
// B243: the in-session panel keeps one readable description line.
const compact = await commands.renderSkillsList(workspace, configDir, false, undefined, {
  compact: true,
});
for (const row of compact.split('\n')) {
  assert.ok(row.length < 260, `compact /skills row is bounded: ${row.slice(0, 120)}…`);
}
// B276: `moss skill list --json` reads the same rows; user-only entries carry
// null catalogChars and the full description (not the compact 72-char form).
const listData = await commands.loadSkillListData(workspace, configDir);
assert.ok(listData, 'skill list data exists for the fixture workspace');
const userOnly = listData.rows.find((row) => row.modelInvocable === false);
assert.ok(userOnly, 'the user-only fixture is listed');
assert.equal(userOnly.catalogChars, null);
assert.match(userOnly.description, /^probe skill /);
assert.ok(listData.rows.every((row) => row.name && row.scope));
assert.equal(listData.summary.count, listData.rows.length);
assert.equal(
  commands.compactSkillDescription('x'.repeat(200)).length,
  72,
  'a long description is truncated with an ellipsis'
);
assert.equal(commands.compactSkillDescription('short'), 'short');
const summary =
  list.split('\n').find((line) => line.includes('; catalog') && /skill(s)?; catalog/.test(line)) ??
  '';
assert.ok(summary.length > 0, 'catalog budget summary must be printed');
// The budget number must equal the model-visible catalog, not all four skills.
const expected = catalogModule.renderSkillCatalog(filtered).stats.renderedChars;
assert.ok(
  summary.includes(`catalog ${expected}/`),
  `summary must use model-visible chars ${expected}: ${summary}`
);
ok('/skills marks user-only entries and reports the model-visible catalog budget');

// 7. The user's slash command inlines the body it cannot get via the tool.
const builtinNames = custom.reservedBuiltinNames();
const manualRef = {
  name: 'release-deploy',
  description: 'Publish a release',
  file: byName.get('release-deploy').file,
  manual: true,
};
const resolved = custom.resolveUserCommand('/release-deploy v1.2.3', {
  builtinNames,
  customCommands: [],
  skills: [manualRef],
});
assert.equal(resolved.kind, 'skill');
assert.match(resolved.prompt, /# release-deploy/);
assert.match(resolved.prompt, /Body for release-deploy/, 'the manual body must be inlined');
assert.match(resolved.prompt, /v1\.2\.3/, 'arguments still expand');
assert.ok(
  !resolved.prompt.includes('Read the skill body with the skill tool'),
  'a manual skill must not ask for the refused tool'
);
const ordinaryResolved = custom.resolveUserCommand('/ordinary', {
  builtinNames,
  customCommands: [],
  skills: [
    { name: 'ordinary', description: 'probe skill ordinary', file: byName.get('ordinary').file },
  ],
});
assert.equal(ordinaryResolved.kind, 'skill');
assert.match(
  ordinaryResolved.prompt,
  /Read the skill body with the skill tool first/,
  'ordinary skills keep the progressive-disclosure path'
);
const missingFile = custom.resolveUserCommand('/release-deploy', {
  builtinNames,
  customCommands: [],
  skills: [{ ...manualRef, file: path.join(workspace, 'nope', 'SKILL.md') }],
});
assert.equal(missingFile.kind, 'skill', 'an unreadable body must still dispatch');
assert.match(missingFile.prompt, /Read the skill body with the skill tool first/);
ok('the user-only skill slash command inlines the body; ordinary skills keep the tool path');

console.log(`[skill-model-invocation] ${checks}/7 checks passed`);
