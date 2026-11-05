#!/usr/bin/env node
/**
 * Run-context carry-over probe (offline, B125).
 *
 * A `/goal` or `/task` run writes its own session, so the chat that follows used
 * to start blind. The REPL now hands one compact `<turn-context>` note to the
 * next user turn. This locks the note's content: identity, counts, acceptance
 * authority, last failure, blocked reason and the resume command — plus the
 * truncation and "settled means no resume" rules.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { formatRunContextNote } = await import(
  pathToFileURL(path.join(root, 'dist/cli/run-context.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[run-context] ok ${name}`);
};

const base = {
  taskId: 'task_mw3vb7d2_l27mf5',
  goal: 'Ask the user which color to use, then write it into color.txt',
  phase: 'accepted',
  status: 'completed',
  attempt: 1,
  repairs: 0,
  failures: 0,
  evidence: 3,
  resumable: false,
  acceptanceCommand: 'test -f color.txt',
  lastFailure: null,
  blockedReason: null,
  engineFailure: null,
  plan: [],
  timeline: [],
};

// 1. A passed run: identity, counts, oracle, and no bogus resume hint.
{
  const note = formatRunContextNote(base, false);
  assert.match(note, /\[task-state\]/, note);
  assert.ok(note.includes(base.taskId), note);
  assert.ok(note.includes('phase accepted'), note);
  assert.ok(note.includes('goal: Ask the user which color'), note);
  assert.ok(note.includes('attempts 1 · repairs 0 · failures 0 · evidence 3'), note);
  assert.ok(note.includes('acceptance: test -f color.txt'), note);
  assert.ok(note.includes('cannot be resumed'), note);
  assert.ok(!note.includes('resume: moss task resume'), note);
  assert.ok(!note.includes('last failure'), note);
  ok('a passed run carries identity, counts and the acceptance oracle');
}

// 2. A failed run: last failure, engine record and the resume command.
{
  const note = formatRunContextNote(
    {
      ...base,
      phase: 'failed',
      status: 'completed',
      attempt: 3,
      repairs: 2,
      failures: 2,
      resumable: true,
      lastFailure: {
        stage: 'acceptance',
        symptom: 'acceptance command failed (exit 1)',
        resolved: false,
      },
      engineFailure: 'verification failed after 3 attempts (repair budget exhausted)',
    },
    false
  );
  assert.ok(note.includes('last failure: acceptance — acceptance command failed (exit 1)'), note);
  assert.ok(note.includes('engine record: verification failed after 3 attempts'), note);
  assert.ok(note.includes(`resume: moss task resume ${base.taskId}`), note);
  assert.ok(note.includes('resolved') === false, 'unresolved failure must not claim resolved');
  ok('a failed run carries the failure, the engine reason and the resume command');
}

// 3. A resolved failure is labelled as such.
{
  const note = formatRunContextNote(
    {
      ...base,
      phase: 'accepted',
      lastFailure: { stage: 'verifying', symptom: 'missing color.txt', resolved: true },
    },
    false
  );
  assert.ok(note.includes('missing color.txt (resolved)'), note);
  ok('a resolved failure is labelled resolved instead of looking active');
}

// 4. Blocked runs explain why and stay resumable.
{
  const note = formatRunContextNote(
    {
      ...base,
      phase: 'blocked',
      status: 'blocked',
      resumable: true,
      blockedReason: 'acceptance command is not runnable: bash: line 1: false: command not found',
    },
    false
  );
  assert.ok(note.includes('blocked: acceptance command is not runnable'), note);
  assert.ok(note.includes('resume: moss task resume'), note);
  ok('a blocked run carries the reason and stays resumable');
}

// 5. An aborted run keeps the pause/resume story.
{
  const note = formatRunContextNote(
    { ...base, phase: 'failed', resumable: true, engineFailure: 'aborted' },
    false
  );
  assert.ok(note.includes('phase failed'), note);
  assert.ok(note.includes('engine record: aborted'), note);
  assert.ok(note.includes('/run resume'), note);
  ok('an interrupted run points at the interactive resume');
}

// 6. Chinese locale mirrors the same facts.
{
  const note = formatRunContextNote(
    {
      ...base,
      phase: 'failed',
      resumable: true,
      lastFailure: { stage: 'acceptance', symptom: '退出码 1', resolved: false },
    },
    true
  );
  assert.ok(note.includes('[任务状态]'), note);
  assert.ok(note.includes('最近失败：acceptance — 退出码 1'), note);
  assert.ok(note.includes('可续跑：moss task resume'), note);
  ok('the Chinese note keeps the same fields');
}

// 7. Long goals are flattened and truncated so the note stays small.
{
  const note = formatRunContextNote(
    { ...base, goal: `${'长目标 '.repeat(80)}\nwith a newline` },
    false
  );
  const goalLine = note.split('\n').find((line) => line.startsWith('goal: '));
  assert.ok(goalLine, note);
  assert.ok(goalLine.length <= 170, `goal line ${goalLine.length}`);
  assert.ok(goalLine.endsWith('…'), goalLine);
  assert.ok(note.length < 1200, `note ${note.length}`);
  ok('long goals are flattened, truncated and bounded');
}

// 8. No task means no note at all (never invent state).
{
  assert.equal(formatRunContextNote({ ...base, taskId: '' }, false), '');
  ok('an empty task id produces no note');
}

console.log(`[run-context] ${checks}/${checks} checks passed`);
