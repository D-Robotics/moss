#!/usr/bin/env node
/**
 * background-exec — output capture + stop kill + safety gate.
 *
 * The subsystem previously had zero tests. These pin down:
 *  (1) full output capture for a fast-exiting process — 'exit' was used instead
 *      of 'close', so tail output could be lost when the process exited before
 *      the stdout pipe drained;
 *  (2) exec_stop kills a long-running process (SIGTERM → SIGKILL escalation);
 *  (3) exec_background blocks dangerous commands (isCommandDangerous gate).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

// Capture the real result without changing taskkill's arguments, stdio, or deadline.
// Diagnostics perform additional process queries only after the original assertion fails.
const originalSpawnSync = childProcess.spawnSync;
const taskkillCalls = [];
function observeTaskkill(delegate, findChild, calls) {
  return function (...args) {
    if (!/(?:^|[\\/])taskkill(?:\.exe)?$/i.test(String(args[0]))) {
      return delegate.apply(this, args);
    }
    const pidIndex = args[1].findIndex((arg) => String(arg).toLowerCase() === '/pid');
    const pid = Number(args[1][pidIndex + 1]);
    const child = findChild(pid);
    const before = {
      pid,
      exitCode: child?.exitCode,
      signalCode: child?.signalCode,
    };
    const lifecycle = {};
    child?.once('exit', (code, signal) => {
      lifecycle.exit = { at: Date.now(), code, signal };
    });
    child?.once('close', (code, signal) => {
      lifecycle.close = { at: Date.now(), code, signal };
    });
    const startedAt = Date.now();
    const result = delegate.apply(this, args);
    calls.push({
      before,
      lifecycle,
      args: args[1],
      stdio: args[2]?.stdio,
      timeout: args[2]?.timeout,
      durationMs: Date.now() - startedAt,
      status: result.status,
      signal: result.signal,
      error: result.error && { code: result.error.code, message: result.error.message },
    });
    return result;
  };
}
// A pure oracle proves delegation preserves object identity and all kill options.
{
  const records = [];
  const options = { stdio: 'ignore', windowsHide: true, timeout: 2000 };
  const argv = ['/pid', '42', '/T', '/F'];
  const result = {
    status: null,
    signal: 'SIGTERM',
    error: { code: 'ETIMEDOUT', message: 'oracle' },
  };
  const receiver = {};
  const observed = observeTaskkill(
    function (command, actualArgv, actualOptions) {
      assert.equal(this, receiver);
      assert.equal(command, 'taskkill');
      assert.equal(actualArgv, argv);
      assert.equal(actualOptions, options);
      return result;
    },
    () => undefined,
    records
  );
  assert.equal(observed.call(receiver, 'taskkill', argv, options), result);
  assert.equal(records.length, 1);
  assert.equal(records[0].args, argv);
  assert.equal(records[0].timeout, 2000);
  assert.equal(records[0].stdio, 'ignore');
  assert.equal(records[0].error.code, 'ETIMEDOUT');
  const passthrough = observeTaskkill(
    () => result,
    () => assert.fail('non-taskkill queried a child'),
    records
  );
  assert.equal(passthrough('node', ['--version']), result);
  assert.equal(records.length, 1);
}
if (process.platform === 'win32') {
  childProcess.spawnSync = observeTaskkill(
    originalSpawnSync,
    (pid) => [...backgroundProcesses.values()].find((entry) => entry.child.pid === pid)?.child,
    taskkillCalls
  );
  syncBuiltinESMExports();
}
// runProcessSync captures spawnSync at module load, so install the test observer first.
const { execBackgroundTool, execLogsTool, execStopTool } =
  await import('../dist/tools/background-exec.js');
const { execTool } = await import('../dist/tools/builtin.js');
const { appendTaskEvent, createDraftTask } = await import('../dist/core/task/task-store.js');
const { resolveHostShell } = await import('../dist/utils/host-shell.js');
const {
  backgroundProcesses,
  clearBackgroundRegistryForTests,
  getBackgroundProcessSnapshot,
  listBackgroundProcessSnapshots,
  setKillEscalationMsForTests,
} = await import('../dist/core/tools/background-process-registry.js');

process.on('uncaughtExceptionMonitor', () => {
  if (process.platform !== 'win32') return;
  console.error('[background-taskkill-failure]', JSON.stringify({ taskkillCalls }));
  for (const proc of backgroundProcesses.values()) {
    console.error(
      '[background-child-failure]',
      JSON.stringify({
        snapshot: getBackgroundProcessSnapshot(proc.id),
        exitCode: proc.child.exitCode,
        signalCode: proc.child.signalCode,
        shellAlive: proc.child.pid && isProcessAlive(proc.child.pid),
        logs: proc.buffer,
      })
    );
    // Own fixture output is used for relationship queries, never production kill targets.
    for (const match of proc.buffer.matchAll(/\bnative_pid=(\d+)\b/g)) {
      const nativePid = Number(match[1]);
      if (!Number.isSafeInteger(nativePid) || nativePid <= 0 || !isProcessAlive(nativePid))
        continue;
      const result = originalSpawnSync(
        path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ProcessId=${nativePid}" | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
        ],
        { encoding: 'utf8', timeout: 2000, windowsHide: true }
      );
      console.error(
        '[background-owned-native-relationship]',
        JSON.stringify({
          shellPid: proc.child.pid,
          queryPid: nativePid,
          status: result.status,
          error: result.error && { code: result.error.code, message: result.error.message },
          stdout: result.stdout,
          stderr: result.stderr,
        })
      );
    }
  }
});

const ctx = () => ({ abortSignal: new AbortController().signal });
function cleanupTempDirectory(directory, prefix) {
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()), 'cleanup stays in system temp');
  assert.ok(path.basename(target).startsWith(prefix), 'cleanup names a created fixture directory');
  fs.rmSync(target, { recursive: true, force: true });
}
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), '.moss-background-exec-'));
process.on('exit', () => {
  cleanupTempDirectory(testDir, '.moss-background-exec-');
});
const quote = (value) =>
  process.platform === 'win32'
    ? `"${String(value).replaceAll('"', '""')}"`
    : `'${String(value).replaceAll("'", "'\\''")}'`;
const nodeCommand = (scriptPath) => {
  if (process.platform === 'win32') {
    return `${resolveHostShell().kind === 'pwsh' ? '& ' : ''}${quote(process.execPath)} ${quote(scriptPath)}`;
  }
  const relativePath = path.relative(process.cwd(), scriptPath).split(path.sep).join('/');
  return `node ${quote(relativePath)}`;
};
const goalNodeCommand = (scriptPath) =>
  process.platform === 'win32' ? nodeCommand(scriptPath) : `node ${quote(scriptPath)}`;
const writeScript = (name, source) => {
  const file = path.join(testDir, name);
  fs.writeFileSync(file, source);
  return file;
};
const nativePidOutput =
  process.platform === 'win32' ? 'console.log(`native_pid=${process.pid}`);' : '';
const sleepScript = writeScript('sleep.cjs', `${nativePidOutput}setInterval(() => {}, 1000)`);
const outputCommand =
  process.platform === 'win32'
    ? 'echo line1&echo line2&echo line3'
    : 'printf "line1\\nline2\\nline3\\n"';
const longRunningCommand = nodeCommand(sleepScript);

async function waitForTerminalStatus(id, timeoutMs = 8000) {
  // Poll the snapshot — subscribing to lifecycle events races with fast-exiting
  // processes (the 'close' notification can fire before a post-execute
  // subscription is in place).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = getBackgroundProcessSnapshot(id);
    if (snap && (snap.status === 'exited' || snap.status === 'killed' || snap.status === 'error')) {
      return snap;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

function extractBgId(out) {
  const m = out.match(/bg_\d+/);
  return m ? m[0] : null;
}

function isProcessAlive(pid) {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (/^\d+ \(.+\) Z /.test(stat)) return false;
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}

// ─── 1. pre-aborted execution fails before spawn/registry ──────────────────
{
  clearBackgroundRegistryForTests();
  const controller = new AbortController();
  controller.abort();
  const out = await execBackgroundTool.execute(
    { command: longRunningCommand, settle_ms: 0 },
    { abortSignal: controller.signal }
  );
  assert.match(out, /abort|cancel/i, 'pre-aborted execution reports cancellation');
  assert.deepEqual(
    listBackgroundProcessSnapshots(),
    [],
    'pre-aborted execution does not spawn or register a process'
  );
}

// ─── 2. full output captured for a fast-exiting process (exit vs close) ─────
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute({ command: outputCommand, settle_ms: 0 }, ctx());
  const id = extractBgId(out);
  assert.ok(id, `exec_background returned a bg id: ${out}`);
  const term = await waitForTerminalStatus(id);
  assert.ok(term, 'process reached a terminal status');
  const logs = await execLogsTool.execute({ id, tail: 100 }, ctx());
  assert.ok(/line1/.test(logs), 'line1 captured');
  assert.ok(/line2/.test(logs), 'line2 captured (tail not lost to the exit-before-drain race)');
  assert.ok(/line3/.test(logs), 'line3 captured');
}

// ─── 3. exec_stop kills a long-running process ─────────────────────────────
{
  setKillEscalationMsForTests(200); // speed up SIGTERM → SIGKILL
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute(
    { command: longRunningCommand, settle_ms: 0 },
    ctx()
  );
  const id = extractBgId(out);
  assert.ok(id, 'long-running process started');
  const stopResult = await execStopTool.execute({ id }, ctx());
  assert.match(stopResult, /kill|stop|terminat/i, 'exec_stop reports termination');
  const term = await waitForTerminalStatus(id, 3000);
  assert.ok(term, 'long-running process reached terminal status after stop');
  // On POSIX, exec_stop sends SIGTERM→SIGKILL → status 'killed'. On Windows,
  // process termination semantics differ (no Unix signals) → status 'exited'.
  // Both mean the process was successfully terminated by exec_stop.
  assert.ok(
    term.status === 'killed' || term.status === 'exited',
    `process terminated by exec_stop (got status: ${term.status})`
  );
}

// ─── 4. abort kills the process tree and reaches a terminal state ──────────
{
  setKillEscalationMsForTests(200);
  clearBackgroundRegistryForTests();
  const controller = new AbortController();
  const parentScript = [
    'const { spawn } = require("node:child_process")',
    `const child = spawn(process.execPath, [${JSON.stringify(sleepScript)}], { stdio: "ignore" })`,
    'console.log(child.pid)',
    'setInterval(() => {}, 1000)',
  ].join(';');
  const command = nodeCommand(writeScript('parent.cjs', parentScript));
  const out = await execBackgroundTool.execute(
    { command, settle_ms: 50 },
    { abortSignal: controller.signal }
  );
  const id = extractBgId(out);
  assert.ok(id, `background process returned before cancellation: ${out}`);

  let childPid = null;
  {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !childPid) {
      const logs = await execLogsTool.execute({ id, tail: 20 }, ctx());
      const match = logs.match(/(?:^|\n)(\d+)(?:\r?\n|$)/);
      childPid = match ? Number(match[1]) : null;
      if (!childPid) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(childPid, 'child process pid was captured before cancellation');
  }

  controller.abort();
  const term = await waitForTerminalStatus(id, 3000);
  assert.ok(term, 'aborted process reached a terminal registry status');
  assert.equal(
    term.status,
    'killed',
    `aborted process is observable as killed, got ${term.status}`
  );
  if (childPid) {
    assert.equal(
      await waitForProcessExit(childPid, 3000),
      true,
      'abort kills the actual native child (a detached process group on POSIX)'
    );
  }
}

// ─── 5. exec_background blocks dangerous commands ──────────────────────────
{
  clearBackgroundRegistryForTests();
  const out = await execBackgroundTool.execute({ command: 'rm -rf /', settle_ms: 0 }, ctx());
  assert.match(out, /block/i, 'dangerous command is blocked by the safety gate');
}

async function stopAndConfirmGone(out, stopCtx, label) {
  const id = extractBgId(out);
  assert.ok(id, `${label}: no background id in ${out}`);
  const pid = Number(out.match(/pid (\d+)/)?.[1]);
  const child = backgroundProcesses.get(id)?.child;
  const stopObservation = {
    startedAt: Date.now(),
    childPid: child?.pid,
    exitCode: child?.exitCode,
    signalCode: child?.signalCode,
  };
  child?.once('exit', (code, signal) => {
    stopObservation.exit = { at: Date.now(), code, signal };
  });
  child?.once('close', (code, signal) => {
    stopObservation.close = { at: Date.now(), code, signal };
  });
  await execStopTool.execute({ id }, stopCtx);
  const [terminal, shellGone] = await Promise.all([
    waitForTerminalStatus(id, 5000),
    Number.isFinite(pid) && pid > 0 ? waitForProcessExit(pid, 5000) : Promise.resolve(true),
  ]);
  if (!terminal) {
    const logs = await execLogsTool.execute({ id, tail: 100 }, stopCtx);
    console.error(
      '[background-stop-observation]',
      JSON.stringify({
        label,
        snapshot: getBackgroundProcessSnapshot(id),
        stopObservation,
        taskkillCalls: taskkillCalls.filter((call) => call.before.pid === child?.pid),
        shellGone,
        nativeProcesses: [...logs.matchAll(/\bnative_pid=(\d+)\b/g)].map((match) => ({
          pid: Number(match[1]),
          alive: isProcessAlive(Number(match[1])),
        })),
        logs,
      })
    );
  }
  assert.ok(terminal, `${label}: background stdio did not close after exec_stop`);
  if (Number.isFinite(pid) && pid > 0) {
    assert.equal(shellGone, true, `${label}: pid ${pid} survived exec_stop`);
  }
  const logs = await execLogsTool.execute({ id, tail: 100 }, stopCtx);
  for (const match of logs.matchAll(/\bnative_pid=(\d+)\b/g)) {
    assert.equal(
      isProcessAlive(Number(match[1])),
      false,
      `${label}: native child survived exec_stop`
    );
  }
}

// ─── 6. /goal waits only when this run injected goalExecWait ──────────────
{
  clearBackgroundRegistryForTests();
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), '.moss-goal-exec-wait-'));
  process.on('exit', () => cleanupTempDirectory(ws, '.moss-goal-exec-wait-'));
  const sleepMs = 2000;
  const script = path.join(ws, 'sleep.cjs');
  fs.writeFileSync(script, `${nativePidOutput}setTimeout(() => process.exit(0), ${sleepMs});\n`);
  const command = goalNodeCommand(script);
  const { taskId } = await createDraftTask(ws, 'diagnosing on disk is not a goal run');
  await appendTaskEvent(ws, taskId, 'execution_started');
  await appendTaskEvent(ws, taskId, 'verification_started');
  await appendTaskEvent(ws, taskId, 'acceptance_fail', { detail: 'no evidence' });
  const diskCtx = { workspaceDir: ws, abortSignal: new AbortController().signal };
  const goalCtx = { ...diskCtx, goalExecWait: true };

  const idleStarted = Date.now();
  const idle = await execBackgroundTool.execute({ command: goalNodeCommand(sleepScript) }, diskCtx);
  const idleElapsed = Date.now() - idleStarted;
  assert.match(idle, /Still running after/, 'a diagnosing task on disk does not make exec wait');
  assert.ok(idleElapsed < 1700, `no wait outside /goal, elapsed ${idleElapsed}`);
  await stopAndConfirmGone(idle, diskCtx, 'idle');

  const goalStarted = Date.now();
  const waited = await execTool.execute({ command, run_in_background: true }, goalCtx);
  const goalElapsed = Date.now() - goalStarted;
  assert.doesNotMatch(waited, /Still running after/, `goal exec waited: ${waited}`);
  assert.match(waited, /exited/, `goal exec reports the exit: ${waited}`);
  assert.ok(goalElapsed >= 1700, `goal exec waited past the settle window, elapsed ${goalElapsed}`);

  const optOutStarted = Date.now();
  const optedOut = await execBackgroundTool.execute(
    { command: goalNodeCommand(sleepScript), wait: false },
    goalCtx
  );
  const optOutElapsed = Date.now() - optOutStarted;
  assert.match(optedOut, /Still running after/, `wait:false returns fast: ${optedOut}`);
  assert.ok(
    optOutElapsed < 1700,
    `dev server with wait:false returns fast, elapsed ${optOutElapsed}`
  );
  await stopAndConfirmGone(optedOut, goalCtx, 'wait:false');

  const settleStarted = Date.now();
  const settled = await execTool.execute(
    { command: goalNodeCommand(sleepScript), run_in_background: true, settle_ms: 200 },
    goalCtx
  );
  const settleElapsed = Date.now() - settleStarted;
  assert.match(settled, /Still running after/, `explicit settle_ms stays backgrounded: ${settled}`);
  assert.ok(settleElapsed < 1000, `settle_ms during a goal returns fast, elapsed ${settleElapsed}`);
  await stopAndConfirmGone(settled, goalCtx, 'settle_ms');

  const capStarted = Date.now();
  const capped = await execBackgroundTool.execute({ command, timeout_ms: 300 }, goalCtx);
  const capElapsed = Date.now() - capStarted;
  assert.match(capped, /exec_wait/, `timeout tells the model how to await: ${capped}`);
  assert.match(capped, /Still running after/, `timeout still returns a handle: ${capped}`);
  assert.ok(capElapsed < 1000, `timeout_ms bounds the wait, elapsed ${capElapsed}`);
  await stopAndConfirmGone(capped, goalCtx, 'timeout_ms cap');
  // Windows can still hold the stopped child's handles on ws for a moment
  // (EBUSY or EPERM); rmSync's maxRetries does not cover EPERM.
  for (let attempt = 0; ; attempt += 1) {
    try {
      cleanupTempDirectory(ws, '.moss-goal-exec-wait-');
      break;
    } catch (error) {
      if (attempt >= 25 || !['EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

// ─── 7. Esc during a goal wait kills the command immediately ───────────────
{
  setKillEscalationMsForTests(200);
  clearBackgroundRegistryForTests();
  const controller = new AbortController();
  const started = Date.now();
  const command = goalNodeCommand(sleepScript);
  const pending = execBackgroundTool.execute(
    { command, timeout_ms: 4000 },
    { goalExecWait: true, abortSignal: controller.signal }
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  controller.abort();
  const out = await pending;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1500, `esc stopped the goal wait immediately, elapsed ${elapsed}`);
  assert.doesNotMatch(out, /Still running after/, `esc does not leave the wait running: ${out}`);
  const id = extractBgId(out);
  assert.ok(id, `aborted goal exec names the process: ${out}`);
  const term = await waitForTerminalStatus(id, 3000);
  assert.ok(term, 'aborted goal exec reached a terminal status');
  assert.notEqual(term.status, 'running');
  if (term.pid) {
    assert.equal(isProcessAlive(term.pid), false, 'esc kills the waited process');
  }
}

// A real positive proves the script can mutate; cancelled startup must end
// without leaving either its native child or that later mutation behind.
{
  const marker = path.join(testDir, 'startup-late-marker');
  const script = writeScript(
    'startup.cjs',
    [
      'console.log(`native_pid=${process.pid}`)',
      `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)), 350)`,
      'setTimeout(() => process.exit(0), 700)',
    ].join(';')
  );
  const command = nodeCommand(script);
  const positive = await execBackgroundTool.execute({ command, settle_ms: 50 }, ctx());
  const positiveId = extractBgId(positive);
  assert.ok(positiveId, 'startup positive returns a real process id');
  const positiveTerminal = await waitForTerminalStatus(positiveId, 3000);
  assert.ok(positiveTerminal, 'startup positive really completed');
  assert.equal(positiveTerminal.status, 'exited');
  assert.equal(positiveTerminal.exitCode, 0);
  const nativePid = Number(fs.readFileSync(marker, 'utf8'));
  assert.ok(nativePid > 0, 'the native script really performed the delayed mutation');
  assert.equal(isProcessAlive(nativePid), false, 'positive native process exited');
  fs.unlinkSync(marker);

  const controller = new AbortController();
  const cancelled = await execBackgroundTool.execute(
    { command, settle_ms: 50 },
    { abortSignal: controller.signal }
  );
  const cancelledId = extractBgId(cancelled);
  assert.ok(cancelledId, 'cancelled startup names the actual process');
  controller.abort();
  const terminal = await waitForTerminalStatus(cancelledId, 3000);
  assert.ok(terminal, 'cancelled startup reaches a real closed-stdio terminal state');
  assert.equal(terminal.status, 'killed');
  assert.ok(Number.isInteger(terminal.pid) && terminal.pid > 0, 'cancelled shell has a real PID');
  assert.equal(isProcessAlive(terminal.pid), false, 'cancelled startup shell exited');
  const logs = await execLogsTool.execute({ id: cancelledId, tail: 100 }, ctx());
  for (const match of logs.matchAll(/\bnative_pid=(\d+)\b/g)) {
    assert.equal(
      isProcessAlive(Number(match[1])),
      false,
      'cancelled native startup process exited'
    );
  }
  assert.equal(fs.existsSync(marker), false, 'cancelled startup has no late mutation');
}

console.log('  [PASS] background-exec: abort lifecycle, output capture, stop kill, safety gate');
clearBackgroundRegistryForTests();
cleanupTempDirectory(testDir, '.moss-background-exec-');
