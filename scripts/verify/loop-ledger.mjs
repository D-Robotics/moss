#!/usr/bin/env node
/**
 * Loop ledger probe (offline, scripted provider).
 *
 * Cursor keeps a PR/branch record for autopilot and Claude keeps task
 * directories; a local `moss loop` that runs unattended needs the same audit
 * trail. This checks the ledger contract: one line per attempt with the check
 * exit code and durations, a final summary with an honest reason, and the
 * `--max-duration` wall-clock cap that stops between attempts.
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
const { runLoopCommand } = await import(dist('cli/loop-command.js'));

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

const workspaceDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-loop-')));
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
const readLedger = (runId) =>
  fs
    .readFileSync(path.join(ledgerDir, `${runId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
const ledgerFiles = () => fs.readdirSync(ledgerDir).filter((name) => name.endsWith('.jsonl'));
let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[loop-ledger] ok ${name}`);
};

try {
  // 1. Two failing attempts: the ledger keeps both and says why it stopped.
  const codeFailing = await runLoopCommand(['--until', 'false', '--max', '2', 'Say hi'], ctx);
  assert.equal(codeFailing, 1);
  const failLedger = ledgerFiles();
  assert.equal(failLedger.length, 1);
  const failRun = failLedger[0].replace(/\.jsonl$/, '');
  const failRecords = readLedger(failRun);
  assert.equal(failRecords.length, 3, 'two attempts + one summary');
  assert.deepEqual(
    failRecords.slice(0, 2).map((r) => [r.type, r.attempt, r.check.exitCode, r.passed]),
    [
      ['attempt', 1, 1, false],
      ['attempt', 2, 1, false],
    ]
  );
  assert.ok(failRecords[0].durationMs >= 0);
  assert.equal(failRecords[2].type, 'summary');
  assert.equal(failRecords[2].passed, false);
  assert.equal(failRecords[2].attempts, 2);
  assert.equal(failRecords[2].reason, 'attempts_exhausted');
  ok('every attempt is recorded and the summary names attempts_exhausted');

  // 2. A passing first attempt: the summary says passed, not "no attempts".
  const codePassing = await runLoopCommand(['--until', 'true', 'Say hi'], ctx);
  assert.equal(codePassing, 0);
  const passingRun = ledgerFiles().find((name) => name !== failLedger[0]);
  assert.ok(passingRun);
  const passingRecords = readLedger(passingRun.replace(/\.jsonl$/, ''));
  assert.equal(passingRecords.at(-1).passed, true);
  assert.equal(passingRecords.at(-1).attempts, 1);
  assert.equal(passingRecords.at(-1).reason, 'passed');
  ok('a pass is recorded as passed after one attempt');

  // 3. The wall-clock cap stops between attempts with an honest reason.
  const codeBudget = await runLoopCommand(
    ['--until', 'false', '--max', '3', '--max-duration', '1ms', 'Say hi'],
    ctx
  );
  assert.equal(codeBudget, 1);
  const all = ledgerFiles();
  assert.equal(all.length, 3);
  const budgetRun = all.find((name) => name !== failLedger[0] && name !== passingRun);
  assert.ok(budgetRun);
  const budgetSummary = readLedger(budgetRun.replace(/\.jsonl$/, '')).at(-1);
  assert.equal(budgetSummary.reason, 'budget_exhausted');
  assert.equal(budgetSummary.attempts, 1, 'the cap is checked before starting attempt 2');
  assert.equal(budgetSummary.maxAttempts, 3);
  ok('--max-duration stops with budget_exhausted instead of max attempts');
} finally {
  await agent.close();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
}

// `runOneShot` writes process.exitCode for the inner headless attempts (a
// blocked outcome is exit 9); the probe's own verdict is the checks above.
process.exitCode = 0;
console.log(`[loop-ledger] ${checks}/3 checks passed`);
