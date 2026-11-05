#!/usr/bin/env node
/**
 * D11 inline skill policy probe — `model:` / `effort:` frontmatter is parsed,
 * recorded per run, and reported to the model. Deterministic: no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, 'dist', relative)).href);
const { createSkillTool } = await load('core/skills/skill-tool.js');
const { loadSkillCatalog } = await load('core/skills/skill-registry.js');
const policyMod = await load('core/skills/skill-run-policy.js');

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-policy-'));
const skillDir = path.join(workspace, '.moss/skills');
const writeSkill = (name, lines) => {
  fs.mkdirSync(path.join(skillDir, name), { recursive: true });
  fs.writeFileSync(path.join(skillDir, name, 'SKILL.md'), lines.join('\n'));
};
writeSkill('switched', [
  '---',
  'name: switched',
  'description: Switches model and effort',
  'model: cheap-model',
  'effort: low',
  '---',
  '',
  'SWITCHED-BODY',
  '',
]);
writeSkill('plain', ['---', 'name: plain', 'description: No policy', '---', '', 'PLAIN-BODY', '']);
writeSkill('badeffort', [
  '---',
  'name: badeffort',
  'description: Invalid effort',
  'effort: turbo',
  '---',
  '',
  'BAD-BODY',
  '',
]);

const skills = loadSkillCatalog([{ dir: skillDir, scope: 'workspace' }]);
const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));
const tool = createSkillTool(() => skills);
const ctx = { workspaceDir: workspace, sessionKey: 'policy-run', runId: 'policy-run' };

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

await check('model and effort frontmatter are parsed', () => {
  assert.equal(byName.switched.model, 'cheap-model');
  assert.equal(byName.switched.effort, 'low');
});

await check('an invalid effort warns and is ignored', () => {
  assert.equal(byName.badeffort.effort, undefined);
  assert.ok(byName.badeffort.issues.some((issue) => issue.code === 'unknown-effort'));
});

await check('loading the skill records a run policy and tells the model', async () => {
  policyMod.clearSkillRunPolicies();
  const output = await tool.execute({ name: 'switched' }, ctx);
  assert.match(output, /SWITCHED-BODY/);
  assert.match(
    output,
    /Skill policy active for the rest of this run: model cheap-model, effort low/
  );
  assert.deepEqual(policyMod.getSkillRunPolicy('policy-run'), {
    model: 'cheap-model',
    effort: 'low',
  });
});

await check('a skill without policy leaves the run policy untouched', async () => {
  policyMod.clearSkillRunPolicies();
  await tool.execute({ name: 'plain' }, ctx);
  assert.equal(policyMod.getSkillRunPolicy('policy-run'), undefined);
});

await check('the policy map is bounded', () => {
  policyMod.clearSkillRunPolicies();
  for (let index = 0; index < 300; index += 1) {
    policyMod.setSkillRunPolicy(`run-${index}`, { model: `m-${index}` });
  }
  assert.ok(policyMod.getSkillRunPolicy('run-299'));
  assert.equal(policyMod.getSkillRunPolicy('run-0'), undefined);
});

await check('an empty policy is never recorded', () => {
  policyMod.clearSkillRunPolicies();
  policyMod.setSkillRunPolicy('empty', {});
  assert.equal(policyMod.getSkillRunPolicy('empty'), undefined);
});

for (const line of checks) console.log(`[skill-policy] ${line}`);
fs.rmSync(workspace, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[skill-policy] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[skill-policy] ${checks.length} checks passed`);
