#!/usr/bin/env node
/**
 * generate_structured tool — the 2-step self-validation flow. The tool's
 * non-validateOnly path returns instructions that tell the LLM to produce JSON
 * and then self-validate via a second validateOnly call (host-side enforcement
 * is not wired, so self-validation is the contract). The description must be
 * honest about this flow.
 */
import assert from 'node:assert/strict';

import { createStructuredOutputTool } from '../dist/structured-output/structured-output-tool.js';

const tool = createStructuredOutputTool();

const schema = {
  type: 'object',
  properties: { name: { type: 'string' }, age: { type: 'number' } },
  required: ['name'],
};

// ─── description is honest about the 2-step flow ───────────────────────────

{
  assert.ok(typeof tool.description === 'string');
  assert.ok(/validateOnly/i.test(tool.description), 'description mentions validateOnly');
  assert.ok(/two-step/i.test(tool.description) || /call again/i.test(tool.description),
    'description describes the 2-step produce-then-validate flow');
  // The old misleading "validated automatically" promise is gone.
  assert.ok(!/validated against the schema automatically/i.test(tool.description),
    'description no longer claims automatic validation (host-side enforcement is not wired)');
}

// ─── non-validateOnly execute returns self-validation instructions ─────────

{
  const out = await tool.execute({ schema, prompt: 'a user profile' }, {});
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('[generate_structured: ready]'), 'ready marker');
  assert.ok(out.includes('## Expected Schema'), 'schema section');
  assert.ok(out.includes('SELF-VALIDATE'), 'instructions include a self-validate section');
  assert.ok(/validateOnly: true/i.test(out), 'instructions tell the LLM to call validateOnly: true');
  assert.ok(/output: <your JSON/i.test(out), 'instructions tell the LLM to pass output: <JSON>');
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

console.error('structured-output-tool: 2-step self-validation flow is described + instructed ✓');
