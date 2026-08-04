#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runOneShot } from '../dist/cli/oneshot.js';
import { buildComposedSkillContext } from '../dist/cli/tui-utils.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { createMossRuntime } from '../dist/runtime/index.js';
import { SkillRegistry, normalizeSkillComposerConfig } from '../dist/skills/index.js';
import { loadSkillTool } from '../dist/tools/skill-tools.js';

function writeSkill(root, name, description, trigger, body) {
  const dir = path.join(root, '.moss', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    `trigger: ${trigger}`,
    '---',
    '',
    body,
  ].join('\n'));
}

function createCapturingProvider(calls) {
  return {
    id: 'skill-composer-capture',
    displayName: 'Skill Composer Capture',
    async complete(options) {
      calls.push(options);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'done' }],
        usage: { inputTokens: 10, outputTokens: 1 },
      };
    },
    async stream(options, onEvent) {
      const result = await this.complete(options);
      onEvent({ type: 'message_start' });
      onEvent({ type: 'content_block_start' });
      onEvent({ type: 'content_block_delta', text: 'done' });
      onEvent({ type: 'content_block_stop' });
      onEvent({ type: 'message_delta', stopReason: 'end_turn' });
      onEvent({ type: 'message_stop' });
      return result;
    },
    async countTokens(text) {
      return Math.ceil(text.length / 4);
    },
  };
}

function createWriter() {
  let output = '';
  return {
    writer: { write(chunk) { output += chunk; } },
    events() {
      return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-composer-runtime-'));
const originalConfigFile = process.env.MOSS_CONFIG_FILE;
const originalExitCode = process.exitCode;
try {
  writeSkill(
    ws,
    'alpha-inspection',
    'Inspect alpha repositories and map their architecture.',
    'alpha inspection',
    'ALPHA_RUNTIME_BODY: map runtime flow before editing.',
  );
  const registry = new SkillRegistry({
    workspaceDir: ws,
    includeBuiltin: false,
    includeBundledRdkSkills: false,
  });

  // Legacy mode remains the rollback path and retains the previous matcher.
  const legacy = await buildComposedSkillContext(registry, 'alpha inspection', {
    config: normalizeSkillComposerConfig(undefined),
    environment: { deployment: 'host', hasBoard: false },
  });
  assert.match(legacy.context, /Matched Skills/);
  assert.equal(legacy.plan, undefined);

  // Low-confidence recovery injects no body and traces the effective empty plan.
  const lowConfidenceTraces = [];
  const lowConfidence = await buildComposedSkillContext(
    registry,
    'please inspect repositories',
    {
      config: normalizeSkillComposerConfig({
        enabled: true,
        mode: 'rules',
        minScore: 0.01,
        minConfidence: 0.99,
      }),
      environment: { deployment: 'host', hasBoard: false },
      onTrace: (trace, kind) => lowConfidenceTraces.push({ trace, kind }),
    },
  );
  assert.equal(lowConfidence.context, '');
  assert.equal(lowConfidence.plan?.rejected, true);
  assert.equal(lowConfidence.plan?.diagnostics?.rejectionReason, 'below-minimum-confidence');
  assert.equal(lowConfidence.plan?.diagnostics?.fallbackReason, undefined);
  assert.deepEqual(lowConfidenceTraces[0]?.trace.finalOrder, []);
  assert.equal(lowConfidenceTraces[0]?.trace.injectedChars, 0);

  // A SkillHub-style install becomes selectable after the live registry reloads.
  writeSkill(
    ws,
    'beta-deploy',
    'Deploy beta artifacts through a verified workflow.',
    'beta deployment',
    'BETA_RUNTIME_BODY: verify the artifact after deployment.',
  );
  registry.reload();
  const reloaded = await buildComposedSkillContext(registry, 'beta deployment', {
    config: normalizeSkillComposerConfig({
      enabled: true,
      mode: 'rules',
      minScore: 0.05,
      minConfidence: 0,
    }),
    environment: { deployment: 'host', hasBoard: false },
  });
  assert.match(reloaded.context, /BETA_RUNTIME_BODY/);

  // Rollback clears the active plan, so manual load remains a genuine recovery
  // mechanism instead of seeing stale state from the previous composer turn.
  await buildComposedSkillContext(registry, 'alpha inspection', {
    config: normalizeSkillComposerConfig({
      enabled: true,
      mode: 'rules',
      minScore: 0.05,
      minConfidence: 0,
    }),
    environment: { deployment: 'host', hasBoard: false },
    sessionKey: 'rollback-session',
  });
  const activeLoad = await loadSkillTool.execute(
    { name: 'alpha-inspection' },
    { workspaceDir: ws, sessionKey: 'rollback-session' },
  );
  assert.match(activeLoad, /already active/i);
  await buildComposedSkillContext(registry, 'alpha inspection', {
    config: normalizeSkillComposerConfig({ enabled: false }),
    environment: { deployment: 'host', hasBoard: false },
    sessionKey: 'rollback-session',
  });
  const recoveredLoad = await loadSkillTool.execute(
    { name: 'alpha-inspection' },
    { workspaceDir: ws, sessionKey: 'rollback-session' },
  );
  assert.match(recoveredLoad, /ALPHA_RUNTIME_BODY/);
  assert.doesNotMatch(recoveredLoad, /already active/i);

  // One-shot emits the actual plan as stream-json and places skill bodies only
  // in the dynamic prompt-cache bucket.
  const configPath = path.join(ws, 'composer-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    skills: {
      composer: {
        enabled: true,
        mode: 'rules',
        minScore: 0.05,
        minConfidence: 0,
      },
    },
  }));
  process.env.MOSS_CONFIG_FILE = configPath;
  const calls = [];
  const agent = new MossAgent({
    llmProvider: createCapturingProvider(calls),
    sessionStore: new InMemorySessionStore(),
    model: 'skill-composer-integration',
    baseSystemPrompt: 'Integration test.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 2,
  });
  const output = createWriter();
  process.exitCode = undefined;
  await runOneShot(agent, 'alpha inspection', undefined, {
    sessionKey: 'skill-composer-oneshot',
    outputFormat: 'stream-json',
    stdout: output.writer,
    cwd: ws,
  });
  const events = output.events();
  const composition = events.find((event) =>
    event.type === 'skill_composition' && event.subtype === 'active');
  assert.ok(composition, 'one-shot exposes active composition to the eval collector');
  assert.ok(composition.trace.cardinality >= 1);
  assert.ok(
    composition.trace.finalOrder.some((stableId) => stableId.includes('alpha-inspection')),
    'the installed workspace skill appears in the emitted plan',
  );
  assert.ok(composition.trace.finalNames.includes('alpha-inspection'));
  assert.ok(composition.trace.injectedChars > 0);
  assert.match(calls[0].systemPromptParts.dynamic, /ALPHA_RUNTIME_BODY/);
  assert.doesNotMatch(calls[0].systemPromptParts.stable, /ALPHA_RUNTIME_BODY/);
  await agent.close();

  // Embeddable hosts are also default-off; enabling rules is explicit.
  const runtimeOptions = {
    workspaceDir: ws,
    dataDir: path.join(ws, '.runtime-test'),
    includeBundledRdkSkills: false,
    enableSelfEvolution: false,
    agentConfig: {
      llmProvider: createCapturingProvider([]),
      sessionStore: new InMemorySessionStore(),
      model: 'runtime-default-off',
      baseSystemPrompt: 'Runtime test.',
      domainPrompt: false,
      includeAgentBehaviorPrompt: false,
    },
  };
  const defaultRuntime = await createMossRuntime(runtimeOptions);
  assert.deepEqual(
    await defaultRuntime.composeSkillContext('alpha inspection', 'runtime-default'),
    { context: '' },
  );
  await defaultRuntime.agent.close();

  const enabledRuntime = await createMossRuntime({
    ...runtimeOptions,
    enableSkillComposer: true,
    skillComposer: { mode: 'rules', minScore: 0.05, minConfidence: 0 },
  });
  const runtimeComposed = await enabledRuntime.composeSkillContext(
    'alpha inspection',
    'runtime-enabled',
  );
  assert.match(runtimeComposed.context, /ALPHA_RUNTIME_BODY/);
  await enabledRuntime.agent.close();
} finally {
  if (originalConfigFile === undefined) delete process.env.MOSS_CONFIG_FILE;
  else process.env.MOSS_CONFIG_FILE = originalConfigFile;
  process.exitCode = originalExitCode;
  fs.rmSync(ws, { recursive: true, force: true });
}

console.error('skill-composer-runtime-integration: TUI boundary, one-shot, reload, cache, rollback ✓');
