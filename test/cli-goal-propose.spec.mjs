#!/usr/bin/env node
/**
 * P0-5 /goal clear and P2-1 acceptance proposals.
 * Candidates come only from files that exist. An empty workspace says so.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  abandonLiveGoal,
  acceptanceProposalLines,
  emptyAcceptanceNotice,
  GOAL_USAGE,
  planGoalInvocation,
  proposeAcceptanceCommands,
  resolveLoopMaxIterations,
  skippedAcceptanceNotice,
} from '../dist/cli/commands/goal-propose.js';
import { createDraftTask, listTaskEvents } from '../dist/core/task/task-store.js';
import { SLASH_MENU_ROWS } from '../dist/cli/interactive-commands.js';
import {
  buildAgentBehaviorPrompt,
  buildAgentBehaviorPromptQuick,
} from '../dist/contracts/prompts/agent-behavior-prompt.js';

const menu = SLASH_MENU_ROWS.map((row) => row.command);
assert.ok(menu.includes('/goal'), 'the everyday menu offers /goal');
assert.ok(!menu.includes('/task'), 'the everyday menu does not offer /task');
assert.match(GOAL_USAGE, /\/goal clear/);
{
  const zh = acceptanceProposalLines('ship', ['npm test'], 'zh_CN').join('\n');
  assert.match(zh, /验收命令/);
  assert.match(zh, /npm test/);
  assert.match(zh, /契约裁决/);
  const en = acceptanceProposalLines('ship', ['npm test'], 'C').join('\n');
  assert.match(en, /Acceptance command for: ship/);
  assert.match(skippedAcceptanceNotice('zh_CN'), /已跳过验收命令/);
  assert.match(skippedAcceptanceNotice('C'), /Skipped the acceptance command/);
  assert.match(emptyAcceptanceNotice('zh_CN'), /不会编造命令/);
  assert.match(emptyAcceptanceNotice('C'), /will not invent a command/);
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-goal-pkg-'));
  fs.writeFileSync(
    path.join(workspace, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test' } })
  );
  fs.writeFileSync(path.join(workspace, 'Makefile'), 'test:\n\t@true\n');
  const proposal = proposeAcceptanceCommands(workspace);
  assert.ok(
    proposal.candidates.includes('npm test'),
    'a package.json test script proposes npm test'
  );
  assert.ok(proposal.candidates.includes('make test'), 'a Makefile test target proposes make test');
  assert.ok(proposal.candidates.length <= 3, 'at most three candidates');
  const planned = planGoalInvocation('the suite is green', workspace);
  assert.equal(planned.kind, 'propose');
  assert.ok(planned.candidates.includes('npm test'));
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-goal-empty-'));
  const proposal = proposeAcceptanceCommands(workspace);
  assert.deepEqual(proposal.candidates, [], 'an empty workspace invents no command');
  const planned = planGoalInvocation('do the thing', workspace);
  assert.equal(planned.kind, 'run');
  assert.match(planned.notice, /will not invent a command/);
  assert.equal(planned.acceptance, undefined);
}

{
  const explicit = planGoalInvocation('ship it --accept "npm test"', process.cwd());
  assert.equal(explicit.kind, 'run');
  assert.equal(explicit.acceptance, 'npm test');
  assert.equal(planGoalInvocation('', process.cwd()).kind, 'usage');
  assert.equal(planGoalInvocation('clear', process.cwd()).kind, 'clear');
}

{
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-goal-clear-'));
  const contract = await createDraftTask(workspace, 'keep going');
  const message = await abandonLiveGoal(workspace);
  assert.match(message, new RegExp(contract.taskId));
  const events = await listTaskEvents(workspace, contract.taskId);
  assert.ok(
    events.some((event) => event.type === 'task_abandoned'),
    '/goal clear writes task_abandoned'
  );
  const again = await abandonLiveGoal(workspace);
  assert.match(again, /No live goal/);
}

{
  const full = buildAgentBehaviorPrompt();
  const quick = buildAgentBehaviorPromptQuick();
  for (const prompt of [full, quick]) {
    assert.match(prompt, /\.moss\//);
    assert.match(prompt, /evidence\.jsonl/);
    assert.match(prompt, /task-failures\.jsonl/);
    assert.match(prompt, /deployments\.jsonl/);
  }
}

assert.equal(resolveLoopMaxIterations({}), 0, 'loop is unlimited by default');
assert.equal(resolveLoopMaxIterations({ MOSS_LOOP_MAX: '12' }), 12, 'explicit loop limit wins');
assert.equal(
  resolveLoopMaxIterations({ MOSS_LOOP_MAX: '12', MOSS_GOAL_AUTO_MAX_RUNS: '7' }, true),
  7,
  'goal-specific limit wins'
);

console.log('[PASS] cli goal propose');
