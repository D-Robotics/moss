#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizedWebFetch as fetch } from './web-authorized-fetch.mjs';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { startMossWebServer } from '../dist/web-ui/web-server.js';

test('Web comprehensive delivery clarifies and approves before the provider is invoked', async () => {
  let providerCalls = 0;
  const agent = new MossAgent({
    llmProvider: {
      id: 'delivery-gate-provider',
      capabilities: { streaming: false },
      async complete() {
        providerCalls += 1;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'DELIVERY_EXECUTED' }] };
      },
    },
    sessionStore: new InMemorySessionStore(),
    model: 'delivery-gate-model',
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  });
  const web = await startMossWebServer(agent, { port: 0 });
  try {
    const session = await fetch(`${web.url}/api/sessions`, { method: 'POST' }).then((response) =>
      response.json()
    );
    const intake = await fetch(`${web.url}/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'Add plugin permission preview and a security gate across Web and CLI',
        attachmentIds: [],
      }),
    }).then((response) => response.text());
    assert.match(intake, /paused for structured clarification/);
    assert.equal(providerCalls, 0, 'the provider cannot run before the comprehensive gate');

    let execution = (
      await fetch(`${web.url}/api/executions?sessionId=${session.sessionId}`).then((response) =>
        response.json()
      )
    ).executions[0];
    assert.equal(execution.deliveryCase.depth, 'comprehensive');
    assert.equal(execution.deliveryCase.stage, 'elaborating');
    const round = execution.deliveryCase.elaborationRounds[0];
    const answers = Object.fromEntries(
      round.questions.map((question) => [
        question.id,
        question.options[0] ?? 'Deliver the requested observable outcome without expanding scope',
      ])
    );
    execution = (
      await fetch(`${web.url}/api/executions/${execution.graphId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: execution.revision,
          action: { type: 'answer_elaboration', roundId: round.id, answers },
        }),
      }).then((response) => response.json())
    ).execution;
    execution = (
      await fetch(`${web.url}/api/executions/${execution.graphId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: execution.revision,
          action: { type: 'prepare_proposal' },
        }),
      }).then((response) => response.json())
    ).execution;
    assert.equal(execution.deliveryCase.stage, 'proposed');
    assert.equal(execution.reviews[0].scope, 'proposal');
    execution = (
      await fetch(`${web.url}/api/executions/${execution.graphId}/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedRevision: execution.revision,
          action: { type: 'approve_proposal', evidenceId: 'human-approval-1' },
        }),
      }).then((response) => response.json())
    ).execution;
    const result = await fetch(`${web.url}/api/executions/${execution.graphId}/run`, {
      method: 'POST',
    }).then((response) => response.text());
    assert.match(result, /DELIVERY_EXECUTED/);
    assert.equal(providerCalls, 1);
    const finalGraph = agent.executionStore.load(execution.graphId);
    assert.equal(finalGraph.deliveryCase.stage, 'verifying');
    assert.equal(finalGraph.deliveryCase.completionReport, undefined);
    assert.equal(finalGraph.nodes['delivery-work'].status, 'succeeded');
  } finally {
    await web.close();
    await agent.close();
  }
});

test('Web minimal read-only delivery generates a reviewed evidence-bound completion report', async () => {
  let providerCalls = 0;
  const agent = new MossAgent({
    llmProvider: {
      id: 'delivery-report-provider',
      capabilities: { streaming: false },
      async complete(options) {
        providerCalls += 1;
        if (options.systemPrompt.includes('independent, read-only delivery reviewer')) {
          return {
            stopReason: 'end_turn',
            content: [{ type: 'text', text: '{"verdict":"PASS","blockers":[],"notes":[]}' }],
          };
        }
        return { stopReason: 'end_turn', content: [{ type: 'text', text: 'PARSER_EXPLAINED' }] };
      },
    },
    sessionStore: new InMemorySessionStore(),
    model: 'delivery-report-model',
    domainPrompt: false,
    includeLanguagePolicyPrompt: false,
    includeAgentBehaviorPrompt: false,
  });
  const web = await startMossWebServer(agent, { port: 0 });
  try {
    const session = await fetch(`${web.url}/api/sessions`, { method: 'POST' }).then((response) =>
      response.json()
    );
    const result = await fetch(`${web.url}/api/sessions/${session.sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Explain parser behavior', attachmentIds: [] }),
    }).then((response) => response.text());
    assert.match(result, /PARSER_EXPLAINED/);
    const execution = (
      await fetch(`${web.url}/api/executions?sessionId=${session.sessionId}`).then((response) =>
        response.json()
      )
    ).executions[0];
    assert.equal(execution.deliveryCase.stage, 'completed');
    assert.equal(execution.verification.verdict, 'verified');
    assert.match(execution.completionReport.summary, /PARSER_EXPLAINED/);
    assert.equal(execution.reviews.filter((review) => review.scope === 'whole_change').length, 1);
    assert.equal(providerCalls, 3, 'main turn and two isolated reviewer contexts must run');
    assert.ok(execution.reviews.every((review) => review.independent && review.readOnly));
  } finally {
    await web.close();
    await agent.close();
  }
});
