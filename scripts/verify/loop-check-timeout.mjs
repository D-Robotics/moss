#!/usr/bin/env node
/**
 * Loop check-timeout probe (offline, scripted provider).
 *
 * A `--until` command that hangs (a test waiting on stdin, a dev server, a
 * wedged toolchain) used to be invisible: the check ran under a fixed 10-minute
 * cap and its kill surfaced as `exit 1`, i.e. "your work failed" — burning the
 * remaining attempts on a check that will hang every time. The loop now has
 * `--until-timeout`, records `check.timedOut`, states `check_timeout` in the
 * summary and stops without burning attempts. This probe locks that contract.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const dist = (rel) => pathToFileURL(path.join(root, 'dist', rel)).href;
const { MossAgent } = await import(dist('core/agent/moss-agent.js'));
const { InMemorySessionStore } = await import(dist('core/session/session.js'));
const {
  runLoopCommand,
  listLoopRuns,
  readLoopLedger,
  renderLoopRunRows,
  formatLoopRunDetail,
  parseLoopArgs,
} = await import(dist('cli/loop-command.js'));

const provider = {
  id: 'scripted',
  displayName: 'scripted (offline)',
  capabilities: { streaming: true },
  async complete() {
    return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  },
  async stream(_options, onEvent) {
    const response = await this.complete();
    onEvent({ type: 'message_start' });
    onEvent({ type: 'content_block_start' });
    onEvent({ type: 'content_block_delta', text: 'ok' });
    onEvent({ type: 'content_block_stop' });
    onEvent({ type: 'message_delta', stopReason: response.stopReason });
    onEvent({ type: 'message_stop' });
    return response;
  },
};

const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-loopct-')));
const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  baseSystemPrompt: 'You are a test agent.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
});
const ctx = { agent, workspaceDir };
const ledgerDir = path.join(workspaceDir, '.moss', 'loops');
const ledgerFiles = () => fs.readdirSync(ledgerDir).filter((name) => name.endsWith('.jsonl'));
const readLedger = (runId) =>
  fs
    .readFileSync(path.join(ledgerDir, `${runId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-check-timeout] ok ${name}`);
};

try {
  // 1. A hanging check is killed at --until-timeout, marked as such, and stops
  //    the loop after one attempt even though --max is 3.
  const codeHang = await runLoopCommand(
    ['--until', 'sleep 5', '--until-timeout', '150ms', '--max', '3', 'Say hi'],
    ctx
  );
  assert.equal(codeHang, 1, 'a hung check exits 1');
  const hangRun = ledgerFiles()[0].replace(/\.jsonl$/, '');
  const hangRecords = readLedger(hangRun);
  const hangStart = hangRecords.find((record) => record.type === 'start');
  assert.equal(hangStart.untilTimeoutMs, 150, 'the start record carries the cap');
  const hangAttempts = hangRecords.filter((record) => record.type === 'attempt');
  assert.equal(hangAttempts.length, 1, 'a hang stops the loop instead of burning attempts');
  assert.equal(hangAttempts[0].check.timedOut, true, 'the attempt records the timeout');
  assert.equal(hangAttempts[0].passed, false);
  assert.ok(hangAttempts[0].check.durationMs < 5_000, 'the check was killed near the cap');
  const hangSummary = hangRecords.find((record) => record.type === 'summary');
  assert.equal(hangSummary.reason, 'check_timeout');
  assert.equal(hangSummary.attempts, 1);
  assert.equal(hangSummary.passed, false);
  assert.equal(hangSummary.untilTimeoutMs, 150);
  ok('a hung check stops the loop with reason check_timeout after one attempt');

  // 2. Read paths say "timed out", not "failed check".
  const runs = listLoopRuns(workspaceDir);
  const hang = runs.find((run) => run.runId === hangRun);
  assert.equal(hang.reason, 'check_timeout');
  const rows = renderLoopRunRows(runs, { zh: false });
  assert.ok(
    rows.some((line) => line.includes('check timed out (hang)')),
    `table row names the hang: ${rows.join('\n')}`
  );
  const read = readLoopLedger(path.join(workspaceDir, hang.ledger));
  const detail = formatLoopRunDetail(hang, read, { zh: false });
  const detailText = detail.join('\n');
  assert.match(detailText, /RESULT\s+failed · check_timeout/);
  assert.match(detailText, /check TIMEOUT/);
  assert.ok(
    rows.some((line) => line.includes('fail')),
    'the outcome column stays fail'
  );
  ok('list/show name the timeout instead of implying a failing check');

  // 3. The default cap is 10m and a fast check still passes normally.
  const fastCode = await runLoopCommand(['--until', 'true', 'Say hi'], ctx);
  assert.equal(fastCode, 0);
  const fastRun = ledgerFiles()
    .map((name) => name.replace(/\.jsonl$/, ''))
    .find((runId) => runId !== hangRun);
  assert.ok(fastRun);
  const fastRecords = readLedger(fastRun);
  assert.equal(fastRecords[0].untilTimeoutMs, 600_000, 'default --until-timeout is 10m');
  const fastSummary = fastRecords.find((record) => record.type === 'summary');
  assert.equal(fastSummary.reason, 'passed');
  ok('default cap is 10m and a passing check still succeeds');

  // 4. Bad caps are rejected at parse time.
  assert.throws(
    () => parseLoopArgs(['--until', 'true', '--until-timeout', '0', 'x']),
    /greater than 0/
  );
  assert.throws(
    () => parseLoopArgs(['--until', 'true', '--until-timeout', 'soon', 'x']),
    /duration/
  );
  assert.equal(
    parseLoopArgs(['--until', 'true', '--until-timeout', '2m', 'x']).untilTimeoutMs,
    120_000
  );
  ok('--until-timeout validates and accepts ms/s/m/h');

  console.log(`[loop-check-timeout] ${checks}/4 checks passed`);
} finally {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}
