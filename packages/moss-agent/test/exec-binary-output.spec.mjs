#!/usr/bin/env node
/**
 * looksBinary — detect binary output from exec (e.g. `cat /bin/ls`).
 * Binary commands produce U+FFFD replacement chars + control chars when
 * captured as UTF-8. The exec tool returns a safe summary instead of
 * flooding the model's context with MB of garbage.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { looksBinary } from '../dist/tools/builtin.js';

// ─── plain text is NOT binary ──────────────────────────────────────────────

assert.equal(looksBinary('Hello, world!'), false, 'plain text is not binary');
assert.equal(looksBinary('line one\nline two\nline three'), false, 'multiline text is not binary');
assert.equal(looksBinary(''), false, 'empty string is not binary');
assert.equal(looksBinary('short'), false, 'short string is not binary (<20 chars threshold)');

// ─── actual binary data IS binary ──────────────────────────────────────────

{
  // Read a real binary file (/bin/ls or /bin/cat) and convert to UTF-8 string
  // the way runProcess does (chunk.toString() with no encoding = UTF-8 default).
  const binPath = '/bin/ls';
  if (fs.existsSync(binPath)) {
    const buf = fs.readFileSync(binPath);
    const asString = buf.toString('utf-8'); // mirrors runProcess's chunk.toString()
    assert.ok(looksBinary(asString), 'real binary file (/bin/ls) read as UTF-8 is detected as binary');
  }
}

// ─── synthetic binary (high replacement-char + control-char ratio) ─────────

{
  // 50% replacement chars + 50% normal text — clearly binary.
  const synthetic = '�'.repeat(500) + 'hello'.repeat(100);
  assert.ok(looksBinary(synthetic), '50% replacement chars is binary');
}

{
  // 50% null bytes — clearly binary.
  const synthetic = '\x00'.repeat(500) + 'hello'.repeat(100);
  assert.ok(looksBinary(synthetic), '50% null bytes is binary');
}

{
  // 50% control chars (excluding \n \t \r which are allowed) — binary.
  const synthetic = '\x01'.repeat(500) + 'hello'.repeat(100);
  assert.ok(looksBinary(synthetic), '50% control chars is binary');
}

// ─── text with allowed whitespace is NOT binary ────────────────────────────

{
  // Tabs, newlines, carriage returns are allowed — not binary.
  const text = '\t'.repeat(50) + '\n'.repeat(50) + 'hello world';
  assert.equal(looksBinary(text), false, 'tabs + newlines are not binary');
}

// ─── large text (sampling) ─────────────────────────────────────────────────

{
  // Large text with a few replacement chars (legitimate UTF-8 with some
  // bad bytes) should NOT be flagged if the ratio is low.
  const text = 'a'.repeat(10000) + '�'.repeat(100); // 1% replacement
  assert.equal(looksBinary(text), false, '1% replacement chars in large text is not binary');
}

console.error('looksBinary: detects binary output, plain text passes ✓');
