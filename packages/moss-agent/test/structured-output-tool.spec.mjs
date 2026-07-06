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

import { createStructuredOutputTool } from '../dist/structured-output/structured-output-tool.js';
import { buildStructuredOutputSystemPrompt } from '../dist/structured-output/structured-output-prompt.js';

const tool = createStructuredOutputTool();

const schema = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'number' } },
  required: ['name'],
};

// ─── description describes host-side enforcement, NOT a 2-step self-flow ───

{
  assert.ok(typeof tool.description === 'string');
  assert.ok(/host-side enforcement|automatically|host-side/i.test(tool.description),
    'description mentions host-side automatic validation');
  // The old misleading "Two-step flow / call AGAIN with validateOnly" guidance
  // is gone — it caused the LLM to waste a tool call on redundant self-validation.
  assert.ok(!/two-step/i.test(tool.description),
    'description no longer describes a 2-step flow');
  assert.ok(!/call again/i.test(tool.description),
    'description no longer tells the LLM to call again with validateOnly');
  assert.ok(/once/i.test(tool.description),
    'description tells the LLM to call the tool once');
  // validateOnly is still mentioned (as an OPTIONAL pre-check), just not as a
  // required second step.
  assert.ok(/validateOnly/i.test(tool.description), 'description still mentions validateOnly as optional');
}

// ─── non-validateOnly execute returns self-validation instructions ─────────

{
  const out = await tool.execute({ schema, prompt: 'a user profile' }, { sessionKey: 'test' });
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('[generate_structured: ready]'), 'ready marker');
  assert.ok(out.includes('## Expected Schema'), 'schema section');
  assert.ok(/host.*enforce|enforce.*automatic|validate.*automatically/i.test(out),
    'instructions mention host-side automatic validation');
  assert.ok(/retr(?:y|ies)/i.test(out), 'instructions mention retries');
}

// ─── validateOnly path validates (existing behavior, unchanged) ───────────

{
  const valid = await tool.execute({
    schema,
    prompt: 'validate',
    validateOnly: true,
    output: JSON.stringify({ name: 'ada', age: 30 }),
  }, {});
  assert.ok(String(valid).includes('[generate_structured: valid]'), 'valid JSON passes validation');

  const invalid = await tool.execute({
    schema,
    prompt: 'validate',
    validateOnly: true,
    output: JSON.stringify({ age: 30 }), // missing required name
  }, {});
  assert.ok(String(invalid).includes('[generate_structured: invalid]'), 'invalid JSON is rejected');
  assert.ok(String(invalid).includes('name'), 'invalid result names the missing field');
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
  assert.ok(/validates your JSON against the schema automatically/i.test(prompt),
    'system prompt states host-side automatic validation');
  assert.ok(/do not need to call the tool again/i.test(prompt),
    'system prompt tells the LLM not to self-validate via a second call');
  assert.ok(/once/i.test(prompt), 'system prompt says to call the tool once');
  assert.ok(/validateOnly: true` is an optional/i.test(prompt),
    'system prompt frames validateOnly as optional, not a required step');
}
