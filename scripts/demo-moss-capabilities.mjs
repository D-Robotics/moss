#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createMossRuntime } from '../packages/moss-agent/dist/runtime/shared-runtime.js';
import { InMemorySessionStore } from '../packages/moss-agent/dist/core/session/session.js';
import { startMossWebServer } from '../packages/moss-agent/dist/web-ui/web-server.js';
import { createSubagentTool } from '../packages/moss-agent/dist/tools/create-subagent.js';
import { createAuthorizedWebFetch } from './lib/web-authorized-fetch.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-capability-demo-'));
const processLog = [];
const authorizedWebFetch = createAuthorizedWebFetch();

function toolResults(messages) {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block) => block.type === 'tool_result')
    .map((block) => block.content);
}

const provider = {
  id: 'deterministic-showcase',
  displayName: 'Deterministic showcase provider',
  capabilities: { streaming: false },
  async complete(request) {
    if (request.systemPrompt.includes('TRUSTED_RELEASE_AUDITOR')) {
      processLog.push({ phase: 'expert', outcome: 'independent review passed' });
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'AUDITOR_OK: evidence is read-only and release-ready.' }],
      };
    }
    const results = toolResults(request.messages);
    if (results.length === 0) {
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'skill-1',
            name: 'load_skill',
            input: { name: 'verified-release' },
          },
        ],
      };
    }
    if (results.length === 1) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'evidence-1', name: 'collect_release_evidence', input: {} },
        ],
      };
    }
    if (results.length === 2) {
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'expert-1',
            name: 'create_subagent',
            input: {
              expert: 'release-auditor',
              task: 'Independently audit the collected release evidence.',
              maxTurns: 2,
            },
          },
        ],
      };
    }
    const evidence = results.join('\n');
    assert.match(evidence, /RELEASE_EVIDENCE_OK/);
    assert.match(evidence, /AUDITOR_OK/);
    return {
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'VERIFIED_SHOWCASE_COMPLETE: plugin evidence and independent expert review agree.',
        },
      ],
    };
  },
  async stream() {
    throw new Error('streaming disabled');
  },
};

const runtime = await createMossRuntime({
  workspaceDir: root,
  dataDir: path.join(root, '.data'),
  enableSelfEvolution: false,
  toolProfile: 'desktop-safe',
  extraTools: [createSubagentTool],
  plugins: [
    {
      id: 'showcase/release-evidence',
      setup(context) {
        context.registerTool({
          name: 'collect_release_evidence',
          description: 'Collect deterministic build, test, and documentation evidence.',
          metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
          inputSchema: { type: 'object', properties: {} },
          async execute() {
            processLog.push({ phase: 'plugin-tool', outcome: 'RELEASE_EVIDENCE_OK' });
            return 'RELEASE_EVIDENCE_OK: build=pass tests=pass docs=pass';
          },
        });
        context.registerSkill({
          name: 'verified-release',
          stableId: 'verified-release',
          description: 'Require tool evidence and an independent expert review.',
          sourcePath: 'plugin://showcase/release-evidence',
          version: '1.0.0',
          tags: ['release', 'verification'],
          trigger: ['verify release'],
          risk: 'low',
          permissions: { workspaceRead: true },
          enabled: true,
          updatedAt: 1,
          body: 'Collect release evidence, delegate an independent audit, and cite both results.',
        });
        context.registerExpert({
          id: 'release-auditor',
          displayName: 'Release auditor',
          description: 'Independently reviews release evidence.',
          instructions: 'TRUSTED_RELEASE_AUDITOR. Return a concise evidence verdict.',
          scope: 'read-only',
          allowedTools: [],
          maxTurns: 2,
        });
      },
    },
  ],
  agentConfig: {
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  },
});

const web = await startMossWebServer(runtime.agent, {
  port: 0,
  taskRunFile: path.join(root, '.moss', 'task-runs.jsonl'),
});
try {
  const bootstrap = await fetch(`${web.url}/api/bootstrap`).then((response) => response.json());
  assert.ok(bootstrap.tools.includes('collect_release_evidence'));
  assert.ok(bootstrap.plugins.some((plugin) => plugin.id === 'showcase/release-evidence'));
  processLog.push({
    phase: 'composition',
    tools: bootstrap.tools.length,
    plugins: bootstrap.plugins.length,
  });

  const created = await authorizedWebFetch(`${web.url}/api/sessions`, { method: 'POST' }).then(
    (response) => response.json()
  );
  const wire = await authorizedWebFetch(`${web.url}/api/sessions/${created.sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Verify this release with plugin, Skill, and expert evidence.',
    }),
  }).then((response) => response.text());
  assert.match(wire, /VERIFIED_SHOWCASE_COMPLETE/);
  processLog.push({ phase: 'assistant-result', outcome: 'VERIFIED_SHOWCASE_COMPLETE' });

  const terminal = wire
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((event) => event.type === 'done');

  const history = await fetch(`${web.url}/api/runs/${terminal.run.id}`).then((response) =>
    response.json()
  );
  const tools = history.events
    .filter((event) => event.type === 'tool.succeeded')
    .map((event) => event.data.name);
  assert.deepEqual(tools, ['load_skill', 'collect_release_evidence', 'create_subagent']);
  assert.equal(history.run.status, 'completed');
  assert.equal(history.run.verification, 'unverified');
  processLog.push({
    phase: 'task-ledger',
    runId: terminal.run.id,
    status: history.run.status,
    verification: history.run.verification,
    evidenceTools: tools,
  });
  processLog.push({
    phase: 'honest-verdict',
    outcome: 'execution completed; trusted terminal verification was not configured',
  });
  process.stdout.write(`${JSON.stringify({ ok: true, process: processLog }, null, 2)}\n`);
} finally {
  await web.close();
  await runtime.close();
  await fs.rm(root, { recursive: true, force: true });
}
