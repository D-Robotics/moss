#!/usr/bin/env node
/** search_code fixed_strings searches the text literally (Qoder Grep `fixed_strings`). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { searchCodeTool } from '../dist/tools/search-tools.js';

const ctxFor = (workspaceDir) => ({
  workspaceDir,
  sessionKey: 'search-fixed-strings',
  abortSignal: new AbortController().signal,
});

test('search_code: fixed_strings treats regex punctuation as text', async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-search-fixed-'));
  try {
    await fs.writeFile(
      path.join(workspaceDir, 'src.js'),
      [
        'const a = call(service);',
        'const b = callservice;',
        'const c = obj.field;',
        'const d = objxfield;',
        'const e = split(unclosed;',
      ].join('\n') + '\n'
    );
    const ctx = ctxFor(workspaceDir);

    const literalParen = await searchCodeTool.execute(
      { pattern: 'call(service)', fixed_strings: true, output_mode: 'content' },
      ctx
    );
    assert.match(literalParen, /src\.js:1:> const a = call\(service\);/);
    assert.doesNotMatch(literalParen, /callservice/);

    const dotted = await searchCodeTool.execute(
      { pattern: 'obj.field', fixed_strings: true, output_mode: 'content' },
      ctx
    );
    assert.match(dotted, /obj\.field/);
    assert.doesNotMatch(dotted, /objxfield/);

    // The same dotted pattern as a regex matches both identifiers.
    const regexDotted = await searchCodeTool.execute(
      { pattern: 'obj.field', output_mode: 'content' },
      ctx
    );
    assert.match(regexDotted, /obj\.field/);
    assert.match(regexDotted, /objxfield/);

    // Text that is not a valid regex works literally, and the regex path says
    // how to get there instead of only failing.
    const invalid = await searchCodeTool.execute({ pattern: 'split(unclosed' }, ctx);
    assert.match(invalid, /Invalid regex pattern/);
    assert.match(invalid, /pass fixed_strings: true/);

    const escapedLiteral = await searchCodeTool.execute(
      { pattern: 'split(unclosed', fixed_strings: true, output_mode: 'content' },
      ctx
    );
    assert.match(escapedLiteral, /src\.js:5:> const e = split\(unclosed;/);
  } finally {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  }
});
