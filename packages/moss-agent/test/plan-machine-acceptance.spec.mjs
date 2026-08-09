#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTool, resetPlanControllerForTests } from '../dist/plan-execute/plan-tools.js';
import {
  getActivePlanForSession,
  getPlanController,
} from '../dist/plan-execute/plan-controller-store.js';

const workspaceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ctx = (sessionKey) => ({ workspaceDir, sessionKey, runId: `run-${sessionKey}` });
const planId = (output) => /Plan created: (\S+)/.exec(output)?.[1];

resetPlanControllerForTests();

// Ordinary software plans remain compatible, but are explicitly not proof eligible.
{
  const out = await planTool.execute(
    {
      action: 'create',
      goal: 'software task',
      steps: [{ description: 'edit code', expectedTools: ['edit_file'] }],
    },
    ctx('ordinary')
  );
  const id = planId(out);
  assert.ok(id);
  assert.match(out, /not eligible for Promotion evidence/);
  assert.doesNotMatch(
    await planTool.execute({ action: 'review', planId: id }, ctx('ordinary')),
    /machine acceptance is incomplete/
  );
}

// Device execution creates a draft, but review/approve/start all reject missing evidence fields.
{
  const out = await planTool.execute(
    {
      action: 'create',
      goal: 'run on board',
      steps: [{ description: 'run', expectedTools: ['device_exec'] }],
    },
    ctx('incomplete')
  );
  const id = planId(out);
  assert.ok(id);
  assert.match(out, /incomplete machine-acceptance draft/);
  for (const action of ['review', 'approve', 'start']) {
    const rejected = await planTool.execute({ action, planId: id }, ctx('incomplete'));
    assert.match(rejected, /Step 1 requires a non-empty expectedAccept/);
    assert.match(rejected, /non-empty terminalAccept/);
  }
}

// Invalid contract references and terminal predicate payloads are rejected at create.
{
  const unknownSkill = await planTool.execute(
    {
      action: 'create',
      goal: 'bad skill',
      steps: [{ description: 'run', expectedAccept: ['does-not-exist'] }],
      terminalAccept: [{ name: 'exit_code_zero', params: {} }],
    },
    ctx('bad-skill')
  );
  assert.match(unknownSkill, /unknown or contract-less Skill/);

  const badName = await planTool.execute(
    {
      action: 'create',
      goal: 'bad predicate',
      steps: [{ description: 'x' }],
      terminalAccept: [{ name: 'invented', params: {} }],
    },
    ctx('bad-name')
  );
  assert.match(badName, /not a supported acceptance predicate/);
  const missing = await planTool.execute(
    {
      action: 'create',
      goal: 'missing parameter',
      steps: [{ description: 'x' }],
      terminalAccept: [{ name: 'file_exist', params: {} }],
    },
    ctx('missing')
  );
  assert.match(missing, /params.path/);
  const numeric = await planTool.execute(
    {
      action: 'create',
      goal: 'bad number',
      steps: [{ description: 'x' }],
      terminalAccept: [
        {
          name: 'video_fps_above',
          params: { threshold_fps: Number.NaN, readCommand: 'x', valueRegex: 'x' },
        },
      ],
    },
    ctx('numeric')
  );
  assert.match(numeric, /finite number/);
  const regex = await planTool.execute(
    {
      action: 'create',
      goal: 'bad regex',
      steps: [{ description: 'x' }],
      terminalAccept: [{ name: 'stdout_matches', params: { pattern: '[' } }],
    },
    ctx('regex')
  );
  assert.match(regex, /valid regular expression/);
}

// Real plan tool input persists and exposes step contracts and terminal predicates.
{
  const sessionKey = 'trusted';
  const out = await planTool.execute(
    {
      action: 'create',
      goal: 'trusted board run',
      steps: [
        { description: 'infer', expectedTools: ['device_exec'], expectedAccept: ['rdk-model-zoo'] },
      ],
      terminalAccept: [
        { name: 'exit_code_zero', params: {} },
        { name: 'stdout_matches', params: { pattern: 'bbox:' } },
      ],
    },
    ctx(sessionKey)
  );
  const id = planId(out);
  assert.ok(id);
  const persisted = getPlanController(sessionKey).getPlan(id);
  assert.deepEqual(persisted.steps[0].expectedAccept, ['rdk-model-zoo']);
  assert.equal(persisted.terminalAccept.length, 2);
  const formatted = await planTool.execute({ action: 'format', planId: id }, ctx(sessionKey));
  assert.match(formatted, /Acceptance contracts: rdk-model-zoo/);
  assert.match(formatted, /stdout_matches/);
  await planTool.execute({ action: 'review', planId: id }, ctx(sessionKey));
  await planTool.execute({ action: 'approve', planId: id }, ctx(sessionKey));
  const started = await planTool.execute({ action: 'start', planId: id }, ctx(sessionKey));
  assert.match(started, /Plan execution started/);
  assert.equal(getActivePlanForSession(sessionKey)?.id, id);
  const status = await planTool.execute({ action: 'status', planId: id }, ctx(sessionKey));
  assert.match(status, /Step 1 contracts: rdk-model-zoo/);
  assert.match(status, /Terminal predicates: exit_code_zero, stdout_matches/);
}

console.log(
  'plan-machine-acceptance: real tool input, validation, enforcement, persistence, format/status ok'
);
