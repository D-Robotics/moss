#!/usr/bin/env node
/**
 * generate_structured tool — host-side enforcement flow. The tool's
 * non-validateOnly path registers a pending host-side validation and returns
 * instructions telling the LLM to produce JSON ONCE; the MossAgent completion
 * gate (output-enforcer) validates automatically and re-prompts on failure.
 * The description + instructions must be honest about this single-step flow
 * and must NOT tell the LLM to self-validate via a second validateOnly call.
 */
import assert from 'node:assert/strict';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import {
  clearPendingStructuredValidation,
  createStructuredOutputTool,
  peekPendingStructuredValidation,
} from '../dist/structured-output/structured-output-tool.js';
import { buildStructuredOutputSystemPrompt } from '../dist/structured-output/structured-output-prompt.js';
import { createMockTranscriptProvider } from './e2e/mock-transcript-provider.mjs';

const tool = createStructuredOutputTool();

const schema = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'number' } },
  required: ['name'],
};

// ─── description describes host-side enforcement, NOT a 2-step self-flow ───

{
  assert.ok(typeof tool.description === 'string');
  assert.ok(
    /host-side enforcement|automatically|host-side/i.test(tool.description),
    'description mentions host-side automatic validation'
  );
  // The old misleading "Two-step flow / call AGAIN with validateOnly" guidance
  // is gone — it caused the LLM to waste a tool call on redundant self-validation.
  assert.ok(!/two-step/i.test(tool.description), 'description no longer describes a 2-step flow');
  assert.ok(
    !/call again/i.test(tool.description),
    'description no longer tells the LLM to call again with validateOnly'
  );
  assert.ok(/once/i.test(tool.description), 'description tells the LLM to call the tool once');
  // validateOnly is still mentioned (as an OPTIONAL pre-check), just not as a
  // required second step.
  assert.ok(
    /validateOnly/i.test(tool.description),
    'description still mentions validateOnly as optional'
  );
}

// ─── non-validateOnly execute returns self-validation instructions ─────────

{
  const out = await tool.execute({ schema, prompt: 'a user profile' }, { sessionKey: 'test' });
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('[generate_structured: ready]'), 'ready marker');
  assert.ok(out.includes('## Expected Schema'), 'schema section');
  assert.ok(
    /host.*enforce|enforce.*automatic|validate.*automatically/i.test(out),
    'instructions mention host-side automatic validation'
  );
  assert.ok(/retr(?:y|ies)/i.test(out), 'instructions mention retries');
}

// ─── validateOnly path validates (existing behavior, unchanged) ───────────

{
  const valid = await tool.execute(
    {
      schema,
      prompt: 'validate',
      validateOnly: true,
      output: JSON.stringify({ name: 'ada', age: 30 }),
    },
    {}
  );
  assert.ok(String(valid).includes('[generate_structured: valid]'), 'valid JSON passes validation');

  const invalid = await tool.execute(
    {
      schema,
      prompt: 'validate',
      validateOnly: true,
      output: JSON.stringify({ age: 30 }), // missing required name
    },
    {}
  );
  assert.ok(String(invalid).includes('[generate_structured: invalid]'), 'invalid JSON is rejected');
  assert.ok(
    String(invalid).startsWith('Error:'),
    'invalid structured output is is_error-detectable'
  );
  assert.ok(String(invalid).includes('name'), 'invalid result names the missing field');

  await assert.rejects(
    tool.execute(
      {
        schema: { type: 'object', minProperties: 1 },
        prompt: 'unsupported schema',
      },
      { sessionKey: 'invalid-schema' }
    ),
    /unsupported schema keyword "minProperties"/i,
    'unsupported schema constraints surface as a real tool error'
  );
}

console.error('structured-output-tool: host-side enforcement flow is described + instructed ✓');

// ─── system prompt aligns with host-side enforcement ──────────────────────

{
  // Disabled → empty (no injection).
  assert.equal(buildStructuredOutputSystemPrompt({}), '');
  assert.equal(buildStructuredOutputSystemPrompt({ structuredOutputEnabled: false }), '');

  const prompt = buildStructuredOutputSystemPrompt({ structuredOutputEnabled: true });
  assert.ok(typeof prompt === 'string' && prompt.length > 0, 'enabled prompt is non-empty');
  // The system prompt must tell the LLM the loop validates automatically and
  // that it does NOT need to self-validate — matching the host-side gate.
  assert.ok(
    /validates your JSON against the schema automatically/i.test(prompt),
    'system prompt states host-side automatic validation'
  );
  assert.ok(
    /do not need to call the tool again/i.test(prompt),
    'system prompt tells the LLM not to self-validate via a second call'
  );
  assert.ok(/once/i.test(prompt), 'system prompt says to call the tool once');
  assert.ok(
    /validateOnly: true` is an optional/i.test(prompt),
    'system prompt frames validateOnly as optional, not a required step'
  );
}

// ─── completion gate retains the schema across retries and fails closed ───

{
  const sessionKey = 'structured-output-invalid-retries';
  const provider = createMockTranscriptProvider(
    'structured-output-test',
    'Structured Output Test',
    [
      {
        toolCalls: [
          {
            name: 'generate_structured',
            input: { schema, prompt: 'Return a user profile' },
          },
        ],
      },
      { text: '```json\n{"age":30}\n```' },
      { text: '```json\n{"age":31}\n```' },
      { text: '```json\n{"age":32}\n```' },
    ]
  );
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'structured-output-test',
    baseSystemPrompt: 'Return the requested structured output.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 8,
  });
  agent.tools.register(createStructuredOutputTool());

  try {
    await assert.rejects(
      agent.chat(sessionKey, 'Return a user profile as structured JSON.'),
      /structured output validation failed/i,
      'invalid structured output must fail after bounded retries instead of being released'
    );
    assert.equal(
      peekPendingStructuredValidation(sessionKey),
      undefined,
      'terminal validation failure clears the pending schema'
    );
  } finally {
    clearPendingStructuredValidation(sessionKey);
  }
}

console.error('structured-output-tool: invalid retries remain enforced and fail closed ✓');

{
  const sessionKey = 'structured-output-recovery';
  const runId = 'structured-output-recovery-run';
  const provider = createMockTranscriptProvider(
    'structured-output-recovery',
    'Structured Output Recovery',
    [
      {
        toolCalls: [
          {
            name: 'generate_structured',
            input: { schema, prompt: 'Return a user profile' },
          },
        ],
      },
      { text: '```json\n{"age":30}\n```' },
      { text: '```json\n{"name":"Ada","age":30}\n```' },
    ]
  );
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'structured-output-recovery',
    baseSystemPrompt: 'Return the requested structured output.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 8,
  });
  agent.tools.register(createStructuredOutputTool({ maxRetries: 2 }));

  const result = await agent.chat(sessionKey, 'Return a user profile as structured JSON.', {
    runId,
  });
  assert.equal(result.response, '```json\n{"name":"Ada","age":30}\n```');
  assert.equal(
    peekPendingStructuredValidation(sessionKey, runId),
    undefined,
    'successful correction clears the run-scoped pending schema'
  );
}

{
  const first = createStructuredOutputTool({ maxRetries: 2 });
  const second = createStructuredOutputTool({ maxRetries: 4 });
  await first.execute(
    { schema, prompt: 'first' },
    { sessionKey: 'shared-session', runId: 'run-a' }
  );
  await second.execute(
    { schema: { type: 'object', required: ['title'] }, prompt: 'second' },
    { sessionKey: 'shared-session', runId: 'run-b' }
  );
  assert.equal(peekPendingStructuredValidation('shared-session', 'run-a')?.maxRetries, 2);
  assert.equal(peekPendingStructuredValidation('shared-session', 'run-b')?.maxRetries, 4);
  assert.notDeepEqual(
    peekPendingStructuredValidation('shared-session', 'run-a')?.schema,
    peekPendingStructuredValidation('shared-session', 'run-b')?.schema,
    'same-session concurrent runs retain independent schemas'
  );
  clearPendingStructuredValidation('shared-session', 'run-a');
  clearPendingStructuredValidation('shared-session', 'run-b');
}

console.error('structured-output-tool: recovery, retry config, and run isolation ✓');

{
  const strictSchema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      role: { type: 'string', default: 'developer' },
    },
    required: ['name', 'role'],
    additionalProperties: false,
  };
  const provider = createMockTranscriptProvider(
    'structured-output-strict',
    'Structured Output Strict',
    [
      {
        toolCalls: [
          {
            name: 'generate_structured',
            input: { schema: strictSchema, prompt: 'Return a user profile' },
          },
        ],
      },
      { text: '```json\n{"name":"Ada","extra":true}\n```' },
      { text: '```json\n{"name":"Ada","role":"developer"}\n```' },
    ]
  );
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: new InMemorySessionStore(),
    model: 'structured-output-strict',
    baseSystemPrompt: 'Return the requested structured output.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 8,
  });
  agent.tools.register(createStructuredOutputTool({ maxRetries: 2 }));

  const result = await agent.chat('structured-output-strict', 'Return strict JSON.');
  assert.equal(
    result.response,
    '```json\n{"name":"Ada","role":"developer"}\n```',
    'host validation must reject raw output that only becomes valid after hidden auto-repair'
  );
}

console.error('structured-output-tool: successful responses conform without hidden repair ✓');
