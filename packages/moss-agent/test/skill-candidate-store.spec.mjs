#!/usr/bin/env node
/**
 * Skill candidate store — persistence lifecycle.
 * Tests write → list → remove, deduplication, unsafe-id guard,
 * and sensitive-input redaction.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  writeSkillCandidate,
  listCandidates,
  removeCandidate,
  isUnsafeCandidateId,
} from '../dist/skill-learning/index.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-skill-test-'));
}

function makeToolCalls(overrides) {
  return [
    { name: 'exec', input: { command: 'ls' }, failed: false },
    { name: 'read_file', input: { file_path: '/tmp/a.txt' }, failed: false },
    ...(overrides || []),
  ];
}

const BASE_INPUT = {
  sessionKey: 'test-session',
  turnHash: 'hash-001',
  gate: 'strict',
  userMessage: 'deploy model to RDK X5',
  assistantText: 'Model deployed successfully',
  runMeta: { completionKind: 'complete', model: 'test', totalElapsedMs: 5000 },
};

// ─── 1. Write → list → remove lifecycle ──────────────────────────────────────

{
  const dir = await makeTempDir();
  const result = await writeSkillCandidate({
    ...BASE_INPUT,
    workspaceDir: dir,
    toolCalls: makeToolCalls(),
  });

  assert.ok(result, 'writeSkillCandidate returns a result');
  assert.ok(result.isNew, 'first write is new');
  assert.ok(result.candidateId, 'candidateId assigned');

  const candidates = await listCandidates(dir);
  assert.equal(candidates.length, 1, 'one candidate after write');
  assert.equal(candidates[0].candidateId, result.candidateId);
  assert.equal(candidates[0].sourceSessionKey, 'test-session');
  assert.deepEqual(candidates[0].toolNames, ['exec', 'read_file']);

  const removed = await removeCandidate(dir, result.candidateId);
  assert.equal(removed, true, 'removeCandidate returns true');

  const after = await listCandidates(dir);
  assert.equal(after.length, 0, 'zero candidates after remove');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 2. Deduplication — same session+turnHash+tools ──────────────────────────

{
  const dir = await makeTempDir();
  const input = {
    ...BASE_INPUT,
    workspaceDir: dir,
    toolCalls: makeToolCalls(),
  };

  const first = await writeSkillCandidate(input);
  const second = await writeSkillCandidate(input);

  assert.ok(first.isNew, 'first write is new');
  assert.ok(!second.isNew, 'second write is deduped (not new)');
  assert.equal(second.dedupedFrom, first.candidateId, 'second points to first');

  const candidates = await listCandidates(dir);
  assert.equal(candidates.length, 1, 'dedup keeps single candidate');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 3. Unsafe candidate ID guard ────────────────────────────────────────────

{
  assert.ok(isUnsafeCandidateId(''), 'empty string is unsafe');
  assert.ok(isUnsafeCandidateId('.'), 'dot is unsafe');
  assert.ok(isUnsafeCandidateId('..'), 'double-dot is unsafe');
  assert.ok(isUnsafeCandidateId('foo/bar'), 'slash in ID is unsafe');
  assert.ok(isUnsafeCandidateId('foo\\bar'), 'backslash in ID is unsafe');

  assert.ok(!isUnsafeCandidateId('deploy-model-a1b2c3'), 'normal ID is safe');
  assert.ok(!isUnsafeCandidateId('candidate-20260630-1430-ab12cd'), 'timestamp ID is safe');
}

// ─── 4. Sensitive input redaction ────────────────────────────────────────────

{
  const dir = await makeTempDir();
  await writeSkillCandidate({
    ...BASE_INPUT,
    workspaceDir: dir,
    toolCalls: [
      {
        name: 'exec',
        input: { command: 'curl', api_key: 'sk-secret-12345', token: 'abc' },
        failed: false,
      },
    ],
  });

  const candidates = await listCandidates(dir);
  assert.equal(candidates.length, 1);
  const stored = candidates[0].toolCalls[0].input;
  assert.equal(stored.api_key, '[redacted]', 'api_key redacted');
  assert.equal(stored.token, '[redacted]', 'token redacted');
  assert.equal(stored.command, 'curl', 'non-sensitive field preserved');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 5. List with filters ────────────────────────────────────────────────────

{
  const dir = await makeTempDir();
  await writeSkillCandidate({
    ...BASE_INPUT,
    workspaceDir: dir,
    toolCalls: [{ name: 'exec', input: {}, failed: false }],
  });
  await writeSkillCandidate({
    ...BASE_INPUT,
    turnHash: 'hash-002',
    workspaceDir: dir,
    toolCalls: [{ name: 'read_file', input: {}, failed: false }],
  });

  const all = await listCandidates(dir);
  assert.equal(all.length, 2, 'two candidates total');

  const execOnly = await listCandidates(dir, { toolName: 'exec' });
  assert.equal(execOnly.length, 1, 'filter by toolName works');
  assert.equal(execOnly[0].toolNames[0], 'exec');

  await fs.rm(dir, { recursive: true, force: true });
}

console.log('✓ skill-candidate-store.spec.mjs — all assertions passed');
