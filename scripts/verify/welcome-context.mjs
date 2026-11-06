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
const { renderWelcomeContextLines, renderNextHint, formatAgo } = await import(
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

async function writeRun(record, root = ws) {
  const dir = path.join(root, '.moss', 'runs', record.runId);
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
    assert.match(next, /moss goal "<intent>" --accept "<cmd>"/);
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

  // 8. B144: the empty composer suggests resuming / onboarding, not a slogan.
  {
    const { suggestion } = renderWelcomeContextLines(ws, false);
    assert.match(suggestion ?? '', /^Resume with make the run actually perform the check/);
    const zh = renderWelcomeContextLines(ws, true).suggestion;
    assert.match(zh ?? '', /^继续：make the run actually perform the check/);

    const fresh = path.join(tmp, 'fresh-composer');
    await fs.mkdir(fresh, { recursive: true });
    assert.match(renderWelcomeContextLines(fresh, false).suggestion ?? '', /^Try "\/init"/);
    await fs.writeFile(path.join(fresh, 'AGENTS.md'), '# AGENTS\n', 'utf8');
    assert.equal(
      renderWelcomeContextLines(fresh, false).suggestion,
      undefined,
      'a workspace with AGENTS.md and no runs falls back to the kind default'
    );

    // A completed newest run needs no resume hint.
    await writeRun({
      runId: 'done_run',
      kind: 'task',
      status: 'completed',
      goal: 'done',
      endedAt: Date.now(),
      next: 'moss runs',
    });
    assert.equal(renderWelcomeContextLines(ws, false).suggestion, undefined);
  }
  ok('a pending run or a fresh workspace drives the composer placeholder');

  // 9. B151: the REPL repeats the ledger-derived next step after a run.
  {
    await writeRun({
      runId: 'pending_run',
      kind: 'task',
      status: 'verify_failed',
      goal: 'pending goal',
      endedAt: Date.now() + 1_000,
      next: 'moss task resume task_pending',
    });
    assert.match(renderNextHint(ws, false, 'cli'), /^Next moss task resume task_pending/);
    assert.match(renderNextHint(ws, true, 'cli'), /^下一步/);
    assert.match(renderNextHint(ws, false, 'interactive'), /^Next \/goal resume task_pending/);
    await writeRun({
      runId: 'done_run2',
      kind: 'task',
      status: 'completed',
      goal: 'done',
      endedAt: Date.now() + 2_000,
      next: 'moss runs',
    });
    assert.match(renderNextHint(ws, false, 'cli'), /^Next moss runs/);
    assert.match(renderNextHint(ws, false, 'interactive'), /^Next \/runs/);
    const fresh = path.join(tmp, 'fresh-next');
    await fs.mkdir(fresh, { recursive: true });
    assert.match(renderNextHint(fresh, false, 'cli'), /^Next moss init/);
    assert.match(renderNextHint(fresh, false, 'interactive'), /^Next \/init/);
  }
  ok('the after-run next hint names the resume, the ledger or onboarding');

  // 10. B154: interactive surfaces name the slash command they can actually run.
  {
    const surface = path.join(tmp, 'surface-case');
    await fs.mkdir(surface, { recursive: true });
    assert.match(renderWelcomeContextLines(surface, false, 'cli').next, /^moss init/);
    assert.match(renderWelcomeContextLines(surface, false, 'interactive').next, /^\/init/);
    await fs.writeFile(path.join(surface, 'AGENTS.md'), '# AGENTS\\n', 'utf8');
    assert.equal(
      renderWelcomeContextLines(surface, false, 'interactive').next,
      '/goal "<intent>" --accept "<cmd>"'
    );
    assert.equal(
      renderWelcomeContextLines(surface, false, 'cli').next,
      'moss goal "<intent>" --accept "<cmd>"'
    );
    await writeRun(
      {
        runId: 'surface_done',
        kind: 'task',
        status: 'completed',
        goal: 'done',
        endedAt: Date.now(),
        next: 'moss runs',
      },
      surface
    );
    assert.match(renderWelcomeContextLines(surface, false, 'interactive').next, /^\/runs/);
    assert.match(renderWelcomeContextLines(surface, false, 'cli').next, /^moss runs/);
    await writeRun(
      {
        runId: 'surface_pending',
        kind: 'task',
        status: 'verify_failed',
        goal: 'pending',
        endedAt: Date.now() + 5_000,
        next: 'moss task resume task_surface',
      },
      surface
    );
    assert.equal(
      renderWelcomeContextLines(surface, false, 'interactive').next,
      '/goal resume task_surface'
    );
    assert.equal(
      renderWelcomeContextLines(surface, false, 'cli').next,
      'moss task resume task_surface'
    );
  }
  ok('interactive next hints use /init, /runs and /run resume instead of shell verbs');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`[welcome-context] ${checks}/${checks} checks passed`);
