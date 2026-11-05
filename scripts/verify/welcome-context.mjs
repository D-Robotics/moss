#!/usr/bin/env node
/**
 * Welcome context probe (offline, B136).
 *
 * The first REPL screen answers "what happened last / what do I do now": it
 * reads the unified run ledger and AGENTS.md, so a failed run surfaces its own
 * resume command instead of a generic greeting.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { renderWelcomeContextLines, formatAgo } = await import(
  pathToFileURL(path.join(root, 'dist/cli/onboarding.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[welcome-context] ok ${name}`);
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-welcome-'));
const ws = path.join(tmp, 'ws');
await fs.mkdir(ws, { recursive: true });

async function writeRun(record) {
  const dir = path.join(ws, '.moss', 'runs', record.runId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'run.json'),
    `${JSON.stringify({ version: 1, startedAt: record.endedAt - 1000, durationMs: 1000, ...record }, null, 2)}\n`,
    'utf8'
  );
}

try {
  // 1. Brand-new project: no runs, no AGENTS.md -> init is the next step.
  {
    const { lines, next } = renderWelcomeContextLines(ws, false);
    assert.deepEqual(lines, []);
    assert.match(next, /moss init/);
    assert.match(next, /detect this project/);
  }
  ok('a brand-new workspace points at `moss init`');

  // 2. AGENTS.md present, still no runs -> the verified-run command.
  await fs.writeFile(path.join(ws, 'AGENTS.md'), '# AGENTS.md\n', 'utf8');
  {
    const { lines, next } = renderWelcomeContextLines(ws, false);
    assert.deepEqual(lines, []);
    assert.match(next, /moss run "<intent>" --accept "<cmd>"/);
  }
  ok('a project with AGENTS.md points at the verified run');

  // 3. A completed run: status + age + goal, and the full ledger as the next step.
  await writeRun({
    runId: 'task_done',
    kind: 'task',
    status: 'completed',
    goal: 'create hello.txt',
    endedAt: Date.now() - 5 * 60_000,
  });
  {
    const { lines, next } = renderWelcomeContextLines(ws, false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /last run: completed · 5m ago · task task_done — create hello\.txt/);
    assert.match(next, /moss runs/);
  }
  ok('a completed run shows its status, age and goal; next step is the ledger');

  // 4. A failed run wins: its own resume command is the next step.
  await writeRun({
    runId: 'task_failed',
    kind: 'task',
    status: 'verify_failed',
    goal: 'say hi in fail.txt',
    endedAt: Date.now() - 60_000,
    next: 'moss task resume task_failed',
    taskId: 'task_failed',
  });
  {
    const { lines, next } = renderWelcomeContextLines(ws, false);
    assert.match(lines[0], /verify_failed · 1m ago · task task_failed/);
    assert.equal(next, 'moss task resume task_failed');
  }
  ok('the newest run wins and a failed run surfaces its resume command');

  // 5. Unverified chat runs use their own recorded next step.
  await writeRun({
    runId: 'chat_unverified',
    kind: 'chat',
    status: 'unverified',
    goal: 'claim tests passed',
    endedAt: Date.now() - 10_000,
    next: 'make the run actually perform the check it claims, then re-run',
  });
  {
    const { lines, next } = renderWelcomeContextLines(ws, false);
    assert.match(lines[0], /unverified · 10s ago · chat chat_unverified/);
    assert.match(next, /actually perform the check/);
  }
  ok('an unverified chat run keeps its recorded next step');

  // 6. Chinese labels and malformed records.
  await fs.mkdir(path.join(ws, '.moss', 'runs', 'broken'), { recursive: true });
  await fs.writeFile(path.join(ws, '.moss', 'runs', 'broken', 'run.json'), '{', 'utf8');
  {
    const { lines, next } = renderWelcomeContextLines(ws, true);
    assert.match(lines[0], /上次运行/);
    assert.match(next, /actually perform the check/);
  }
  ok('Chinese labels render and a half-written record is skipped');

  // 7. Age formatting is human, not raw milliseconds.
  assert.equal(formatAgo(Date.now() - 30_000), '30s ago');
  assert.equal(formatAgo(Date.now() - 5 * 60_000), '5m ago');
  assert.equal(formatAgo(Date.now() - 2 * 60 * 60_000), '2h ago');
  assert.equal(formatAgo(Date.now() - 3 * 24 * 60 * 60_000), '3d ago');
  ok('ages read as 30s / 5m / 2h / 3d');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[welcome-context] ${checks}/${checks} checks passed`);
