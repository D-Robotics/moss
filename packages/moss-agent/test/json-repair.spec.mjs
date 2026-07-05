#!/usr/bin/env node
/**
 * json-repair — ported from Pi v0.80.3's repairJson.
 *
 * Verifies that malformed JSON (raw control chars, invalid escapes) is
 * repaired so JSON.parse succeeds, and that valid JSON is untouched.
 */
import assert from 'node:assert/strict';
import { repairJson, parseJsonLoose } from '../dist/utils/json-repair.js';

// ─── 1. valid JSON is untouched ────────────────────────────────────────────
{
  const valid = '{"name":"test","value":42}';
  assert.equal(repairJson(valid), valid, 'valid JSON unchanged');
}

// ─── 2. raw control characters inside strings are escaped ─────────────────
{
  const broken = '{"text":"line1\nline2"}'; // literal newline in string
  const repaired = repairJson(broken);
  assert.ok(repaired.includes('\\n'), 'newline escaped');
  const parsed = JSON.parse(repaired);
  assert.equal(parsed.text, 'line1\nline2', 'parsed value has the newline');
}

{
  const broken = '{"text":"tab\there"}'; // literal tab
  const repaired = repairJson(broken);
  assert.ok(repaired.includes('\\t'), 'tab escaped');
  const parsed = JSON.parse(repaired);
  assert.equal(parsed.text, 'tab\there', 'parsed value has the tab');
}

// ─── 3. invalid escape sequences are fixed (backslash doubled) ────────────
{
  const broken = '{"path":"C:\\Users\\test"}'; // \U \t are valid-ish but \U is invalid
  // Actually \U is invalid in JSON — repairJson should double the backslash
  const broken2 = '{"regex":"\\d+"}'; // \d is invalid JSON escape
  const repaired = repairJson(broken2);
  const parsed = JSON.parse(repaired);
  assert.equal(parsed.regex, '\\d+', 'invalid escape \\d → literal backslash-d');
}

// ─── 4. unicode escape sequences are preserved ─────────────────────────────
{
  const json = '{"emoji":"\\u0041"}'; // A = 'A'
  const repaired = repairJson(json);
  const parsed = JSON.parse(repaired);
  assert.equal(parsed.emoji, 'A', 'unicode escape preserved');
}

// ─── 5. parseJsonLoose: parse with repair fallback ────────────────────────
{
  // Valid JSON — parsed directly
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });

  // Broken JSON (control char) — repaired then parsed
  const broken = '{"text":"line1\nline2"}';
  const result = parseJsonLoose(broken);
  assert.ok(result !== null, 'broken JSON parsed after repair');
  assert.equal(result.text, 'line1\nline2');

  // Unparseable — returns null
  assert.equal(parseJsonLoose(''), null);
  assert.equal(parseJsonLoose(null), null);
  assert.equal(parseJsonLoose('{{{' ), null);
}

// ─── 6. structural JSON outside strings is untouched ──────────────────────
{
  const json = '{"nested":{"key":"value\n"}}';
  const repaired = repairJson(json);
  const parsed = JSON.parse(repaired);
  assert.equal(parsed.nested.key, 'value\n', 'nested structure preserved');
}

console.log('  [PASS] json-repair: control chars + invalid escapes + parseJsonLoose');
