#!/usr/bin/env node
/**
 * O114 — exhausted mid-stream stall, process level.
 *
 * Spawns child processes that run the real runOneShot → MossAgent → agent
 * loop path with a provider whose stream() always throws the watchdog's
 * phase='inter' stall error, then checks:
 *   - JSON mode: final result is_error, PROVIDER_UPSTREAM_ERROR,
 *     recoverable false, message names the upstream stall (zh + en); exit 6.
 *   - `-p` text mode (zh / en): 「重试（第 N 次）…」/"retrying (attempt N)…"
 *     lines, and the LAST stderr line says upstream stream stalled; exit 6.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const mode = process.argv[2];

if (mode) {
  const { runOneShot } = await import('../dist/cli/oneshot.js');
  const { MossAgent } = await import('../dist/core/agent/moss-agent.js');
  const { InMemorySessionStore } = await import('../dist/core/session/session.js');
  const { PiAiFirstEventTimeoutError } = await import('../dist/provider/pi-ai-watchdog.js');
  let calls = 0;
  const stall = () =>
    new PiAiFirstEventTimeoutError({
      timeoutMs: 60_000,
      provider: 'p',
      model: 'm',
      phase: 'inter',
    });
  const agent = new MossAgent({
    llmProvider: {
      id: 'stall',
      displayName: 'Stall',
      async complete() {
        calls += 1;
        throw stall();
      },
      async stream() {
        calls += 1;
        throw stall();
      },
      async countTokens(t) {
        return Math.ceil(t.length / 4);
      },
    },
    sessionStore: new InMemorySessionStore(),
    model: 'stall',
    baseSystemPrompt: 'Answer.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    maxAgentTurns: 3,
  });
  await runOneShot(agent, 'hello', { sessionKey: `o114-${mode}`, outputFormat: mode });
  process.stderr.write(`\n__CALLS__=${calls}\n`);
  process.exit(process.exitCode ?? 0);
}

const strip = (s) => s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
function run(fmt, locale) {
  const env = { ...process.env, LANG: locale, LC_ALL: locale, NO_COLOR: '1' };
  for (const k of [
    'MOSS_LANG',
    'MOSS_LOCALE',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'https_proxy',
    'http_proxy',
  ])
    delete env[k];
  const r = spawnSync(process.execPath, [self, fmt], { env, encoding: 'utf8', timeout: 120_000 });
  const stderrLines = strip(r.stderr)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const callsLine = stderrLines.pop();
  return {
    status: r.status,
    stdout: r.stdout,
    stderrLines,
    calls: Number(callsLine.split('=')[1]),
  };
}

// ─── JSON mode ───────────────────────────────────────────────────────────────
{
  const r = run('json', 'en_US.UTF-8');
  assert.equal(r.status, 6, 'json: process exit code 6 (PROVIDER_UPSTREAM)');
  assert.equal(r.calls, 3, 'json: 1 attempt + 2 retries');
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const result = JSON.parse(lines[lines.length - 1]);
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, true, 'json: final result is an error, not success');
  assert.notEqual(result.subtype, 'success');
  assert.equal(result.error_code, 'PROVIDER_UPSTREAM_ERROR');
  assert.equal(result.recoverable, false, 'json: exhausted → recoverable false');
  assert.match(result.error, /上游流停滞/, 'json: error says 上游流停滞 (zh)');
  assert.match(
    result.error,
    /upstream stream stalled/i,
    'json: error says upstream stream stalled (en)'
  );
  console.log('  [PASS] json: failed result, PROVIDER_UPSTREAM_ERROR, recoverable=false, exit 6');
}

// ─── -p text mode, zh ────────────────────────────────────────────────────────
{
  const r = run('text', 'zh_CN.UTF-8');
  assert.equal(r.status, 6, 'zh -p: exit 6');
  assert.equal(r.calls, 3);
  assert.ok(r.stderrLines.includes('重试（第 1 次）…'), 'zh retry line is a Chinese sentence');
  assert.ok(r.stderrLines.includes('重试（第 2 次）…'));
  const last = r.stderrLines[r.stderrLines.length - 1];
  assert.match(last, /未完成/, 'zh -p: last line is unfinished, never completed');
  assert.match(last, /上游流停滞/, 'zh -p: last line says 上游流停滞');
  console.log(`  [PASS] -p zh: retry lines + last line 「${last}」, exit 6`);
}

// ─── -p text mode, en ────────────────────────────────────────────────────────
{
  const r = run('text', 'en_US.UTF-8');
  assert.equal(r.status, 6, 'en -p: exit 6');
  assert.ok(r.stderrLines.includes('retrying (attempt 1)…'));
  const last = r.stderrLines[r.stderrLines.length - 1];
  assert.match(last, /Incomplete/, 'en -p: last line is Incomplete');
  assert.match(last, /upstream stream stalled/i, 'en -p: last line says upstream stream stalled');
  console.log(`  [PASS] -p en: retry lines + last line "${last}", exit 6`);
}

console.log('[PASS] o114-json-exhausted-stall: 3/3');
