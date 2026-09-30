#!/usr/bin/env node
/**
 * read_file reuse stub vs the tool-output budget (Task OS M12 finding #2).
 *
 * The unchanged-read stub promises "the content from the earlier read is still
 * current". When the earlier body was elided by the output budget that promise
 * is false, and the model burns turns re-reading (2-3 per coding run in the
 * Task A benchmark). These cases pin both directions: keep the token win for
 * bodies that survived, tell the truth for bodies that did not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileTool } from '../dist/tools/builtin.js';
import { FILE_UNCHANGED_STUB, FILE_UNCHANGED_TRUNCATED_STUB } from '../dist/tools/tool-helpers.js';
import {
  truncateToolOutput,
  wouldTruncateToolOutput,
} from '../dist/context/tool-output-truncate.js';

function ctx(workspaceDir) {
  return { workspaceDir, sessionKey: 'test', abortSignal: new AbortController().signal };
}

async function workspace() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-read-stub-'));
}

test('an unchanged small read still returns the reuse stub (token win kept)', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'small.txt'), 'alpha\nbeta\ngamma\n');

  const first = await readFileTool.execute({ path: 'small.txt' }, ctx(dir));
  assert.match(first, /alpha/);
  const second = await readFileTool.execute({ path: 'small.txt' }, ctx(dir));
  assert.equal(second, FILE_UNCHANGED_STUB);
});

test('a read whose body the budget will elide is not advertised as still current', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const big = Array.from(
    { length: 1200 },
    (_, index) =>
      `export const filler${index} = ${index}; // padding so the body exceeds the read budget`
  ).join('\n');
  await fs.writeFile(path.join(dir, 'big.ts'), big);

  const first = await readFileTool.execute({ path: 'big.ts' }, ctx(dir));
  assert.ok(
    wouldTruncateToolOutput('read', first),
    'fixture must exceed the read output budget, otherwise this case proves nothing'
  );
  const elided = truncateToolOutput('read', first);
  assert.notEqual(elided, first, 'the budget elides part of this read');

  const second = await readFileTool.execute({ path: 'big.ts' }, ctx(dir));
  assert.notEqual(second, FILE_UNCHANGED_STUB);
  assert.equal(second, FILE_UNCHANGED_TRUNCATED_STUB);
});

test('a changed file invalidates the stub and re-dumps content', async (t) => {
  const dir = await workspace();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'churn.txt');
  await fs.writeFile(file, 'first version\n');
  await readFileTool.execute({ path: 'churn.txt' }, ctx(dir));

  await new Promise((resolve) => setTimeout(resolve, 10));
  await fs.writeFile(file, 'second version with different bytes\n');
  const again = await readFileTool.execute({ path: 'churn.txt' }, ctx(dir));
  assert.match(again, /second version/);
});

test('the elision notice says how to fetch the dropped region', () => {
  const body = Array.from(
    { length: 4000 },
    (_, index) => `line ${index} of a long tool result`
  ).join('\n');
  const out = truncateToolOutput('read', body);
  assert.match(out, /tokens truncated/);
  assert.match(out, /offset\/limit/, 'read elisions must point at paging, not a blind re-read');

  // Tools without a recovery hint keep the bare notice.
  const unknownOut = truncateToolOutput('some_unknown_tool', body);
  assert.match(unknownOut, /tokens truncated/);
  assert.doesNotMatch(unknownOut, /offset\/limit/);
});
