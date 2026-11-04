#!/usr/bin/env node
/**
 * Deterministic probe for the compaction look-back pointer (backlog B02).
 *
 * Before this change the checkpoint summary was the only trace of dropped
 * history: the messages were gone from context and nothing told the next model
 * the transcript still existed. Now the summary ends with a deterministic
 * `<historical-transcript>` block pointing at `.moss/sessions/<key>.jsonl`
 * (# HISTORICAL — DO NOT EDIT), so a dropped command/output/detail can be
 * looked up instead of re-derived.
 *
 * No model call: the real `compactHistoryIfNeeded` path runs with a stub
 * summarize, and the pointer must survive both the LLM and fallback strategies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const compaction = await import(pathToFileURL(path.join(root, 'dist/context/compaction.js')).href);
const storeMod = await import(
  pathToFileURL(path.join(root, 'dist/core/session/jsonl-session-store.js')).href
);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[compaction-history] ok ${name}`);
}

const workspaceDir = '/tmp/moss-compaction-probe-ws';
const transcriptPath = path.join(workspaceDir, '.moss', 'sessions', 'demo.jsonl');
const messages = Array.from({ length: 10 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `message ${index}: ${'detail '.repeat(40)}`,
  timestamp: 1_700_000_000_000 + index,
}));
const summarize = async () => '<summary>## 1. 主要目标\nprobe</summary>';

async function compact(extra = {}) {
  return compaction.compactHistoryIfNeeded({
    summarize,
    messages,
    contextWindowTokens: 100_000,
    forceCompaction: true,
    ...extra,
  });
}

// ── 1. The pointer is appended deterministically ───────────────────────────

const result = await compact({ transcriptPath, workspaceDir });
assert.ok(result.summary.includes('<historical-transcript>'));
assert.ok(result.summary.includes('# HISTORICAL — DO NOT EDIT'));
assert.ok(result.summary.includes('.moss/sessions/demo.jsonl'));
assert.ok(/read_file \/ grep/.test(result.summary));
assert.ok(
  !result.summary.includes(`${workspaceDir}/.moss/sessions`),
  'label should be workspace-relative'
);
const summaryMessageText =
  typeof result.summaryMessage.content === 'string'
    ? result.summaryMessage.content
    : JSON.stringify(result.summaryMessage.content);
assert.ok(summaryMessageText.includes('# HISTORICAL — DO NOT EDIT'));
ok('checkpoint summary carries the relative transcript pointer');

// Explicit disclosure that the file is an audit trail, not an edit target.
assert.ok(/Do not modify it/.test(result.summary));
ok('pointer marks the transcript read-only');

// ── 2. No transcript path means no false pointer ───────────────────────────

const withoutPointer = await compact({ workspaceDir });
assert.ok(!withoutPointer.summary.includes('<historical-transcript>'));
assert.ok(!withoutPointer.summary.includes('HISTORICAL'));
ok('stores without a file get no pointer');

// ── 3. Fallback strategies keep the pointer ────────────────────────────────

const failing = await compaction.compactHistoryIfNeeded({
  summarize: async () => {
    throw new Error('probe: summarizer down');
  },
  messages,
  contextWindowTokens: 100_000,
  forceCompaction: true,
  transcriptPath,
  workspaceDir,
});
assert.ok(failing.summary.includes('# HISTORICAL — DO NOT EDIT'));
ok('deterministic fallback summary still points at the transcript');

// ── 4. Path rendering ──────────────────────────────────────────────────────

assert.equal(
  compaction.formatHistoricalTranscriptPointer({
    transcriptPath: '/elsewhere/sessions/a.jsonl',
    workspaceDir,
  }),
  [
    '',
    '',
    '<historical-transcript>',
    '# HISTORICAL — DO NOT EDIT',
    'Messages dropped by this compaction are still on disk at: /elsewhere/sessions/a.jsonl',
    'Use read_file / grep on that file to look up a dropped detail (command, output, path, decision) before re-deriving it.',
    "Do not modify it: it is this session's audit trail.",
    '</historical-transcript>',
  ].join('\n')
);
assert.ok(
  compaction
    .formatHistoricalTranscriptPointer({
      transcriptPath: 'C:\\proj\\.moss\\sessions\\w.jsonl',
      workspaceDir: 'C:\\proj',
    })
    .includes('at: .moss/sessions/w.jsonl')
);
assert.ok(
  !compaction
    .formatHistoricalTranscriptPointer({ transcriptPath: '/a/b.jsonl', workspaceDir: '/a/../x' })
    .includes('undefined')
);
ok('pointer renders relative, absolute, and Windows paths');

// ── 5. The real session store exposes the file it writes ───────────────────

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-compaction-store-'));
try {
  const store = new storeMod.JsonlSessionStore({ dir });
  const file = store.transcriptPath('demo/session');
  assert.equal(path.dirname(file), dir);
  assert.ok(file.endsWith('.jsonl'));
  await store.appendMessage('demo/session', { role: 'user', content: 'hi' });
  await fs.access(file);
  ok('JsonlSessionStore.transcriptPath names the file it actually writes');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}

console.log(`[compaction-history] PASS (${checks} checks)`);
