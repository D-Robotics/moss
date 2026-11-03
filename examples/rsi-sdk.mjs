#!/usr/bin/env node
// Offline API wiring example only. Scripted responses below are NOT evidence of
// model improvement. Real acceptance must inject a real provider and task oracle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RsiEngine,
  createRsiLearningProvider,
  MossAgent,
  InMemorySessionStore,
  rsiDigest,
} from '../dist/index.js';

const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-rsi-example-'));
const scope = { ownerKey: 'example-operator', environment: 'test' };
const llm = {
  id: 'offline-scripted-example',
  capabilities: { streaming: false },
  async complete(request) {
    const instructions = request.systemPrompt.includes('complete improved instructions');
    const actor = request.systemPrompt.includes('Return exactly one JSON object');
    const text = instructions
      ? '{"instructions":"Diagnose observed errors before retrying."}'
      : actor
        ? JSON.stringify({
            action: request.systemPrompt.includes('Diagnose observed errors')
              ? 'diagnose'
              : 'retry',
          })
        : 'offline response';
    return { stopReason: 'end_turn', content: [{ type: 'text', text }] };
  },
};
const engine = new RsiEngine({
  rootDir,
  learning: createRsiLearningProvider({
    model: 'scripted',
    identityDigest: 'offline-identity',
    createProvider: () => llm,
  }),
});
async function execute(runId) {
  const selected = engine.captureAdapter(scope, {
    model: 'scripted',
    providerIdentityDigest: 'offline-identity',
  });
  const observer = engine.createRunObserver({ scope, runId, adapter: selected, model: 'scripted' });
  const agent = new MossAgent({
    model: 'scripted',
    llmProvider: llm,
    sessionStore: new InMemorySessionStore(),
    domainPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    onAgentLoopEvent(event, identity) {
      if (identity.runId === runId) observer.onEvent(event);
    },
  });
  try {
    const result = await agent.chat(runId, 'Reply once for this offline wiring example.', {
      runId,
      taskFlow: false,
      harnessAdapter: selected.harnessAdapter,
    });
    assert.equal(result.response, 'offline response');
    observer.finish('completed');
    return result;
  } finally {
    await agent.close();
  }
}
try {
  const selectedCases = [];
  for (const split of ['training', 'validation', 'holdout']) {
    const runId = `example-${split}`;
    await execute(runId);
    selectedCases.push(
      engine.enrollCase(scope, {
        runId,
        split,
        input: 'Offline fixture: a read-only probe failed; decide the next step.',
        expectedOutcome: 'diagnose',
      })
    );
  }
  const budget = { maxModelCalls: 6, maxOutputTokens: 256 };
  const runtimeConfig = {
    runnerVersion: 'offline-classification:1',
    oracleVersion: 'scripted-action-label:1',
    modelConfigDigest: rsiDigest('scripted;temperature=0;thinking=disabled'),
    tools: [],
    permissionsDigest: rsiDigest('no-tools'),
  };
  const protocol = engine.freezeProtocol(scope, {
    caseIds: selectedCases.map((c) => c.id),
    budget,
    runtimeConfig,
  });
  const candidate = await engine.propose(scope, {
    caseIds: [selectedCases[0].id],
    budget,
    protocolId: protocol.id,
    runtimeConfig,
  });
  const evaluation = await engine.evaluate(scope, candidate.adapter.digest, {
    caseIds: selectedCases.map((c) => c.id),
    budget,
    protocolId: protocol.id,
    runtimeConfig,
  });
  assert.equal(evaluation.status, 'passed', 'controlled fixture exercises the promotion branch');
  engine.promote(scope, candidate.adapter.digest, {
    evaluationId: evaluation.id,
    expectedPolicyVersion: 0,
    protocolId: protocol.id,
    runtimeConfig,
  });
  const adopted = await execute('example-adopted');
  assert.equal(adopted.harnessAdapter.sha256, candidate.adapter.digest);
  engine.rollback(scope, 1);
  const reverted = await execute('example-reverted');
  assert.equal(reverted.harnessAdapter, undefined);
  console.log(
    JSON.stringify({
      source: 'offline-scripted-sdk-example',
      protocolDigest: protocol.digest,
      adopted: adopted.harnessAdapter,
      reverted: reverted.harnessAdapter ?? null,
      policyVersion: engine.status(scope).policy.version,
    })
  );
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}
