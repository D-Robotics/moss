#!/usr/bin/env node
/**
 * Background completion must be user-visible in TUI formatters and headless CLI.
 * (Not model-only [System] reminders.)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  formatBackgroundCompletionFlash,
  formatBackgroundCompletionNotice,
} from '../dist/cli/background-completion-ui.js';
import { createCliRunRenderer } from '../dist/cli/output.js';
import {
  clearBackgroundRegistryForTests,
  execBackgroundTool,
} from '../dist/tools/background-exec.js';
import { clearBackgroundCompletionReminderForTests } from '../dist/tools/background-completion-reminder.js';

const base = {
  id: 'bg_test1',
  command: 'npm test',
  label: 'unit',
  status: 'exited',
  exitCode: 0,
  signal: null,
  startedAt: Date.now() - 5000,
  endedAt: Date.now(),
};

{
  const notice = formatBackgroundCompletionNotice(base, false);
  assert.match(notice, /Background finished bg_test1/);
  assert.match(notice, /exit 0/);
  assert.match(notice, /npm test/);
  const flash = formatBackgroundCompletionFlash(base, false);
  assert.equal(flash, 'bg done bg_test1 exit 0');
}

{
  const fail = {
    ...base,
    id: 'bg_fail',
    status: 'exited',
    exitCode: 1,
    command: 'npm run build',
  };
  const notice = formatBackgroundCompletionNotice(fail, true);
  assert.match(notice, /后台命令已结束 bg_fail/);
  assert.match(notice, /exit 1/);
  const flash = formatBackgroundCompletionFlash(fail, true);
  assert.equal(flash, '后台失败 bg_fail exit 1');
}

{
  const err = {
    ...base,
    id: 'bg_err',
    status: 'error',
    exitCode: null,
    errorMessage: 'spawn ENOENT',
  };
  const notice = formatBackgroundCompletionNotice(err, false);
  assert.match(notice, /error: spawn ENOENT|Background finished bg_err/);
  const flash = formatBackgroundCompletionFlash(err, false);
  assert.match(flash, /bg failed bg_err/);
}

// Headless CLI renderer must print a completion line when a background process ends.
{
  const testDir = fs.mkdtempSync(path.join(process.cwd(), '.moss-bg-cli-visible-'));
  const scriptName = 'sleep-then-exit.cjs';
  fs.writeFileSync(
    path.join(testDir, scriptName),
    'setTimeout(() => { console.log("cli-done-line"); process.exit(0); }, 250);'
  );

  clearBackgroundRegistryForTests();
  clearBackgroundCompletionReminderForTests();

  const stderrChunks = [];
  const renderer = createCliRunRenderer({
    detailMode: 'progress',
    interactive: false,
    workspaceDir: testDir,
    stdout: { write: () => {} },
    stderr: {
      write: (value) => {
        stderrChunks.push(String(value));
      },
      isTTY: false,
    },
  });

  const out = await execBackgroundTool.execute(
    {
      command: process.platform === 'win32' ? `node ${scriptName}` : `node ${scriptName}`,
      settle_ms: 50,
      label: 'cli-visible',
    },
    {
      abortSignal: new AbortController().signal,
      workspaceDir: testDir,
    }
  );
  assert.match(String(out), /Still running|Started bg_|exited immediately/i);

  // Wait for the child to finish and lifecycle listeners to fire.
  await sleep(900);

  const text = stderrChunks.join('');
  assert.match(
    text,
    /Background finished|后台命令已结束|bg done|cli-done-line/i,
    `CLI renderer should surface background completion to the user; got:\n${text}`
  );

  renderer.dispose?.();
  clearBackgroundRegistryForTests();
  clearBackgroundCompletionReminderForTests();
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// waitForBackgroundProcessesIdle resolves when short-lived bg work finishes.
{
  const { waitForBackgroundProcessesIdle } = await import('../dist/tools/background-exec.js');
  clearBackgroundRegistryForTests();
  clearBackgroundCompletionReminderForTests();
  const idle = await waitForBackgroundProcessesIdle(200);
  assert.equal(idle, true, 'no running processes => idle immediately');

  const testDir = fs.mkdtempSync(path.join(process.cwd(), '.moss-bg-wait-'));
  const scriptName = 'wait-exit.cjs';
  fs.writeFileSync(path.join(testDir, scriptName), 'setTimeout(() => process.exit(0), 200);');
  await execBackgroundTool.execute(
    {
      command: `node ${scriptName}`,
      settle_ms: 30,
    },
    {
      abortSignal: new AbortController().signal,
      workspaceDir: testDir,
    }
  );
  const started = Date.now();
  const ok = await waitForBackgroundProcessesIdle(1_500);
  const elapsed = Date.now() - started;
  assert.equal(ok, true, 'short bg process becomes idle within timeout');
  assert.ok(elapsed < 1_500, `should not always burn full timeout (elapsed=${elapsed})`);
  clearBackgroundRegistryForTests();
  clearBackgroundCompletionReminderForTests();
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// Oneshot still-running notice (pure formatter; no long-lived process required)
{
  const { formatOneshotStillRunningBackgroundNotice } = await import('../dist/cli/oneshot.js');
  assert.equal(formatOneshotStillRunningBackgroundNotice([]), '');
  const now = 1_000_000;
  const notice = formatOneshotStillRunningBackgroundNotice(
    [
      {
        id: 'bg_long1',
        command: 'npm run dev',
        label: 'server',
        startedAt: now - 12_000,
      },
      {
        id: 'bg_long2',
        command: 'npm test -- --watch',
        startedAt: now - 3_000,
      },
    ],
    { zh: false, now }
  );
  assert.match(notice, /still running/i);
  assert.match(notice, /will not monitor them after exit/i);
  assert.match(notice, /bg_long1 \(server\) running 12s/);
  assert.match(notice, /bg_long2 running 3s/);
  assert.match(notice, /npm run dev/);

  const zhNotice = formatOneshotStillRunningBackgroundNotice(
    [{ id: 'bg_zh', command: 'sleep 999', startedAt: now - 5_000 }],
    { zh: true, now }
  );
  assert.match(zhNotice, /仍在运行/);
  assert.match(zhNotice, /不再监视完成状态/);
  assert.match(zhNotice, /bg_zh 已运行 5s/);
}

// JSON headless surface for leftover background processes
{
  const { formatOneshotStillRunningBackgroundNotice } = await import('../dist/cli/oneshot.js');
  const { formatHeadlessBackgroundStillRunningEvent } = await import('../dist/cli/print.js');
  const now = 2_000_000;
  const message = formatOneshotStillRunningBackgroundNotice(
    [{ id: 'bg_json', command: 'npm run dev', label: 'server', startedAt: now - 8_000 }],
    { zh: false, now }
  );
  const event = formatHeadlessBackgroundStillRunningEvent({
    sessionId: 'sess-json-1',
    message,
    processes: [{ id: 'bg_json', command: 'npm run dev', label: 'server', startedAt: now - 8_000 }],
    now,
  });
  assert.equal(event.type, 'system');
  assert.equal(event.subtype, 'background_still_running');
  assert.equal(event.will_monitor_after_exit, false);
  assert.equal(event.session_id, 'sess-json-1');
  assert.match(event.message, /still running/i);
  assert.equal(event.processes.length, 1);
  assert.equal(event.processes[0].id, 'bg_json');
  assert.equal(event.processes[0].command, 'npm run dev');
  assert.equal(event.processes[0].label, 'server');
  assert.equal(event.processes[0].started_at, now - 8_000);
  assert.equal(event.processes[0].running_for_ms, 8_000);
}

// Pure json result can embed still-running metadata (hosts that only parse result).
{
  const message =
    '[moss] 1 background command(s) still running; oneshot will not monitor them after exit:\n  · bg_embed running 4s — npm run dev';
  const resultEvent = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'started server',
    duration_ms: 100,
    num_turns: 1,
    session_id: 'sess-embed',
    total_cost_usd: null,
    cost_unavailable: true,
    background_still_running: {
      message,
      will_monitor_after_exit: false,
      processes: [
        {
          id: 'bg_embed',
          command: 'npm run dev',
          started_at: 1000,
          running_for_ms: 4000,
        },
      ],
    },
  };
  assert.equal(resultEvent.type, 'result');
  assert.equal(resultEvent.background_still_running.will_monitor_after_exit, false);
  assert.equal(resultEvent.background_still_running.processes[0].id, 'bg_embed');
  assert.match(resultEvent.background_still_running.message, /still running/i);
  // Ensure the embedded shape is JSON-serializable for headless hosts.
  const roundTrip = JSON.parse(JSON.stringify(resultEvent));
  assert.equal(roundTrip.background_still_running.processes[0].command, 'npm run dev');
}

console.log('[PASS] background completion user-visible');
