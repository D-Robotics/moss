#!/usr/bin/env node
/**
 * Transcript-noise probe (offline, B172).
 *
 * A long real run showed two wrong lines after every command:
 *   - `[moss] Detected shell file mutation … for: /dev/null` for `2>/dev/null`
 *     redirects (there is no file body to re-read);
 *   - `Still reasoning, waited 570s 573s` — the wait verb already carries the
 *     bucket, and the live line appended the raw seconds again.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const { extractShellMutationPaths } = await load('dist/context/stale-read-invalidate.js');
const transcript = await load('dist/cli/tui/transcript.js');

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[transcript-noise] ok ${name}`);
};

// 1. Device redirects are not workspace mutations.
assert.deepEqual(
  extractShellMutationPaths('agent-browser network requests 2>/dev/null | grep X'),
  []
);
assert.deepEqual(extractShellMutationPaths('echo hi > /dev/null'), []);
assert.deepEqual(extractShellMutationPaths('echo hi &>/dev/null'), []);
assert.deepEqual(extractShellMutationPaths('command > /dev/null 2>&1'), []);
assert.deepEqual(
  extractShellMutationPaths('cat <<EOF | agent-browser eval --stdin\nfetch("/api")\nEOF'),
  []
);
// A real file target is still detected, alone or next to a device redirect.
assert.deepEqual(extractShellMutationPaths('echo hi > out.txt'), ['out.txt']);
assert.deepEqual(extractShellMutationPaths('echo hi 2>/dev/null > out.txt'), ['out.txt']);
assert.deepEqual(extractShellMutationPaths('sed -i "s/a/b/" src/a.ts'), ['src/a.ts']);
ok('device redirects are ignored while real file writes are still detected');

// 2. The live thinking line carries the wait bucket exactly once.
{
  const now = Date.now();
  const lines = transcript.renderLive(
    {
      running: true,
      startedAt: now - 570_000,
      streaming: '',
      thinking: 'working',
      thinkingActive: true,
      tokensOut: 4800,
      queued: 0,
      lastEventAt: now,
    },
    120
  );
  const text = lines.map((entry) => entry.text).join('\n');
  assert.match(text, /Still reasoning, waited 570s/);
  assert.doesNotMatch(text, /waited 570s\s+\d+s/);
  assert.doesNotMatch(text, /570s 5\d\ds/);
  assert.match(text, /4\.8k out/);
  const short = transcript.renderLive(
    {
      running: true,
      startedAt: now - 2_000,
      streaming: '',
      thinking: '',
      tokensOut: 0,
      queued: 0,
      lastEventAt: now,
    },
    120
  );
  assert.match(short.map((entry) => entry.text).join('\n'), /Working… 2s/);
}
ok('the wait bucket is not followed by the raw elapsed seconds');

console.log(`[transcript-noise] ${checks}/${checks} checks passed`);
