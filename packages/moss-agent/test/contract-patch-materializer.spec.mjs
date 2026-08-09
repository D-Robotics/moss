#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CandidatePatchLog } from '../dist/memory/candidate-patch-log.js';
import { ContractPatchMaterializer } from '../dist/acceptance/contract-patch-materializer.js';
import { SkillRegistry } from '../dist/skills/registry.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-contract-patch-'));
const skillDir = path.join(workspace, '.moss', 'skills', 'test-skill');
await fs.mkdir(skillDir, { recursive: true });
await fs.writeFile(
  path.join(skillDir, 'SKILL.md'),
  ['---', 'name: test-skill', 'description: test', 'version: 1.0.0', '---', '', '# Test'].join('\n')
);
const acceptancePath = path.join(skillDir, 'ACCEPTANCE.json');
await fs.writeFile(
  acceptancePath,
  `${JSON.stringify(
    {
      skillName: 'test-skill',
      version: '1',
      expectedTools: ['exec'],
      postconditions: [{ name: 'exit_code_zero', params: {} }],
    },
    null,
    2
  )}\n`
);
const patchLog = new CandidatePatchLog({ baseDir: path.join(workspace, '.moss', 'memory') });
const materializer = new ContractPatchMaterializer({
  workspaceDir: workspace,
  patchLog,
  skillRegistry: new SkillRegistry({
    workspaceDir: workspace,
    includeBuiltin: false,
    includeBundledRdkSkills: false,
  }),
});
const proposal = {
  skill: 'test-skill',
  section: 'postconditions',
  spec: { name: 'stdout_matches', params: { pattern: 'READY' } },
  expectedVersion: '1',
  sourceEventIds: ['learning-1'],
  environmentFingerprint: 'sha256:test',
};
const candidate = {
  id: 'term_test-skill',
  targetSkill: 'test-skill',
  provenance: {
    layer: 'L2',
    kind: 'explicit-proposal',
    source: 'test',
    proposalRef: 'test://proposal',
  },
};
const rejected = await materializer.publish(proposal, {
  candidate,
  decision: {
    promotable: false,
    statisticalPassed: true,
    crossSignalPassed: false,
    reason: 'no cross signal',
  },
});
assert.equal(rejected.state, 'rejected');
assert.equal(JSON.parse(await fs.readFile(acceptancePath, 'utf8')).postconditions.length, 1);

const published = await materializer.publish(proposal, {
  candidate,
  decision: {
    promotable: true,
    statisticalPassed: true,
    crossSignalPassed: true,
    reason: 'both gates passed',
  },
});
assert.equal(published.state, 'published');
assert.ok(published.backupPath);
const contract = JSON.parse(await fs.readFile(acceptancePath, 'utf8'));
assert.equal(contract.version, '2');
assert.equal(contract.postconditions.length, 2);
assert.equal(contract.postconditions[1].name, 'stdout_matches');

const stale = await materializer.publish(proposal, {
  candidate,
  decision: {
    promotable: true,
    statisticalPassed: true,
    crossSignalPassed: true,
    reason: 'both gates passed',
  },
});
assert.equal(stale.state, 'rejected');
assert.ok(stale.validationErrors.includes('stale_contract_version'));
assert.equal(
  await materializer.rollback(published.id),
  true,
  'a later rejected attempt does not hide the last published revision'
);
assert.equal(JSON.parse(await fs.readFile(acceptancePath, 'utf8')).version, '1');

const rollbackProposal = {
  ...proposal,
  spec: { name: 'stdout_matches', params: { pattern: 'HEALTHY' } },
};
const rollbackPublished = await materializer.publish(rollbackProposal, {
  candidate,
  decision: {
    promotable: true,
    statisticalPassed: true,
    crossSignalPassed: true,
    reason: 'both gates passed',
  },
});
assert.equal(rollbackPublished.state, 'published');
assert.equal(await materializer.rollback(rollbackPublished.id), true);
assert.equal(
  JSON.parse(await fs.readFile(acceptancePath, 'utf8')).version,
  '1',
  'rollback restores the previous contract'
);

await fs.rm(workspace, { recursive: true, force: true });
console.log(
  'contract-patch-materializer: whitelist, ownership, promotion gates, version check and backup ok'
);
