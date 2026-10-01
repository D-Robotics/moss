#!/usr/bin/env node
/**
 * A/B driver for the capability layer on the capability-mcp-ledger bench task.
 *
 * The capability layer is injected ONLY on the `moss task run` engine path
 * (planning turn, src/cli/task-run.ts) — `moss -p` never sees it. So this
 * driver runs the engine directly, once per sample, with everything identical
 * except MOSS_CAPABILITY_LAYER:
 *
 *   arm "off": pre-v0.16 behaviour — the model must discover the ledger tool
 *              via the mcp__warehouse__search meta-tool before calling it;
 *   arm "on" : capability discovery selects mcp__warehouse__ledger_lookup,
 *              reveals it before the planning turn and names it in the
 *              planning prompt.
 *
 * Per sample the driver records: outcome, engine turns (printed by the CLI and
 * recomputed from .moss/task-events.jsonl), wall time, the server-side
 * tools/call log (ground truth for real MCP usage), and the session transcript
 * counts (did the layer fire? did the model search first or call directly?).
 *
 * Provider config mirrors scripts/run-benchmark.mjs: MOSS_BENCH_API_KEY (+)
 * MOSS_BENCH_MODEL / MOSS_BENCH_BASE_URL, else the deepseek entry in
 * ~/.qoder-cn/settings.json. The key is written only to a 0600 config.json in
 * a scratch MOSS_CONFIG_DIR and never printed.
 *
 * Usage:
 *   set -a; . ~/.moss-ap-env; set +a
 *   node bench/tasks/capability-mcp-ledger/ab-run.mjs [--samples N] [--arms off,on]
 *        [--label NAME] [--keep] [--timeout-ms N]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const taskDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(taskDir, '..', '..', '..');
const CLI_ENTRY = process.env.MOSS_BENCH_CLI ?? path.join(repoRoot, 'dist', 'cli.js');
const FIXTURE_SERVER =
  process.env.MOSS_MCP_BENCH_SERVER ??
  path.join(repoRoot, 'test', 'fixtures', 'mcp-bench-server.mjs');
const REPORTS_DIR = path.join(repoRoot, '.autopilot', 'reports');
const KILL_GRACE_MS = 5_000;

const GOAL =
  'Look up the verification checksum of order ORD-4771 in the ledger through the connected tool server, ' +
  'and write it as the only content of checksum.txt (no extra text). The checksum is only obtainable from ' +
  'the ledger tool — do not guess or compute it yourself.';

function parseArgs(argv) {
  const out = {
    samples: 3,
    arms: ['off', 'on'],
    label: undefined,
    keep: false,
    timeoutMs: 480_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(arg + ' requires a value');
      return value;
    };
    if (arg === '--samples') out.samples = Number(next());
    else if (arg === '--arms')
      out.arms = next()
        .split(',')
        .map((a) => a.trim());
    else if (arg === '--label') out.label = next();
    else if (arg === '--timeout-ms') out.timeoutMs = Number(next());
    else if (arg === '--keep') out.keep = true;
    else throw new Error('unknown flag: ' + arg);
  }
  if (!Number.isInteger(out.samples) || out.samples < 1)
    throw new Error('--samples must be a positive integer');
  return out;
}

function loadQoderDeepseekProvider() {
  const settingsPath = path.join(os.homedir(), '.qoder-cn', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const entry of Object.values(settings.providers ?? {})) {
      const models = Array.isArray(entry.models) ? entry.models.map((m) => m.model) : [];
      const names = [entry.model, ...models].filter(Boolean);
      if (names.some((n) => String(n).toLowerCase().startsWith('deepseek'))) {
        return {
          model: names.find((n) => String(n).toLowerCase().startsWith('deepseek')),
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
        };
      }
    }
  } catch {
    /* fall through to explicit env */
  }
  return null;
}

function resolveProviderConfig() {
  const qoder = loadQoderDeepseekProvider();
  const apiKey = process.env.MOSS_BENCH_API_KEY || qoder?.apiKey;
  const model = process.env.MOSS_BENCH_MODEL || qoder?.model;
  const baseUrl = process.env.MOSS_BENCH_BASE_URL || qoder?.baseUrl;
  if (!apiKey || !model || !baseUrl) {
    console.error(
      '[ab] no provider config: set MOSS_BENCH_API_KEY + MOSS_BENCH_MODEL + MOSS_BENCH_BASE_URL (see ~/.moss-ap-env)'
    );
    process.exit(2);
  }
  return { apiKey, model, baseUrl };
}

function runMossTask(options) {
  const { cliArgs, workspace, env, timeoutMs } = options;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cliArgs, {
      cwd: workspace,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (c) => stdout.push(c));
    child.stderr.on('data', (c) => stderr.push(c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: String(err), timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      });
    });
  });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** Engine turns recomputed from lifecycle events: 1 planning turn + one per
 * execution loop (verification_started) + one per repair (repair_applied). */
function engineTurnsFromEvents(workspace) {
  const events = readJsonl(path.join(workspace, '.moss', 'task-events.jsonl'));
  const count = (type) => events.filter((e) => e.type === type || e.event === type).length;
  return 1 + count('verification_started') + count('repair_applied');
}

/** Session-transcript counts, parsed from the JSONL message structure:
 * tool_use blocks counted exactly (no raw-text false positives from tool
 * result bodies), plus whether the planning prompt carried the capability
 * layer and which MCP action came first (search vs direct call). */
function sessionCounts(workspace) {
  const sessionsDir = path.join(workspace, '.moss', 'sessions');
  const counts = {
    sessionFiles: 0,
    layerInPlanning: 0,
    assistantMessages: 0,
    toolUses: 0,
    searchCalls: 0,
    ledgerDirectCalls: 0,
    otherMcpCalls: 0,
    firstMcpAction: 'none',
    toolSequence: [],
  };
  if (!fs.existsSync(sessionsDir)) return counts;
  const mcpWire = /^mcp__warehouse__(search|ledger_lookup|inventory_count|shipping_eta)$/;
  for (const file of fs.readdirSync(sessionsDir).sort()) {
    if (!file.endsWith('.jsonl')) continue;
    counts.sessionFiles += 1;
    for (const entry of readJsonl(path.join(sessionsDir, file))) {
      const message = entry.message ?? entry;
      const content = message?.content;
      if (message?.role === 'assistant') {
        counts.assistantMessages += 1;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block?.type === 'tool_use' && typeof block.name === 'string') {
            counts.toolUses += 1;
            counts.toolSequence.push(block.name);
            if (block.name === 'mcp__warehouse__search') {
              counts.searchCalls += 1;
              if (counts.firstMcpAction === 'none') counts.firstMcpAction = 'search';
            } else if (block.name === 'mcp__warehouse__ledger_lookup') {
              counts.ledgerDirectCalls += 1;
              if (counts.firstMcpAction === 'none') counts.firstMcpAction = 'direct';
            } else if (mcpWire.test(block.name)) {
              counts.otherMcpCalls += 1;
              if (counts.firstMcpAction === 'none') counts.firstMcpAction = 'other';
            }
          }
        }
      } else if (message?.role === 'user') {
        const text = Array.isArray(content)
          ? content.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n')
          : typeof content === 'string'
            ? content
            : '';
        if (text.includes('Task capability discovery')) counts.layerInPlanning += 1;
      }
    }
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(CLI_ENTRY)) {
    console.error('[ab] ' + CLI_ENTRY + ' missing — run npm run build first');
    process.exit(2);
  }
  if (!fs.existsSync(FIXTURE_SERVER)) {
    console.error('[ab] fixture server missing: ' + FIXTURE_SERVER);
    process.exit(2);
  }
  const provider = resolveProviderConfig();
  const label =
    args.label ??
    'capability-mcp-ab-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13);
  const outDir = path.join(REPORTS_DIR, label);
  fs.mkdirSync(outDir, { recursive: true });

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-cap-ab-'));
  const configDir = path.join(scratchRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        provider: 'openai-compatible',
        model: provider.model,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  const rows = [];
  const total = args.arms.length * args.samples;
  let done = 0;
  console.log(
    '[ab] model=' +
      provider.model +
      ' samples=' +
      args.samples +
      ' arms=' +
      args.arms.join(',') +
      ' label=' +
      label
  );

  try {
    for (const arm of args.arms) {
      for (let sample = 1; sample <= args.samples; sample++) {
        done += 1;
        const workspace = fs.mkdtempSync(path.join(scratchRoot, 'ws-'));
        fs.cpSync(path.join(taskDir, 'files'), workspace, { recursive: true });
        const nonce = randomBytes(16).toString('hex');
        const logAbs = path.join(scratchRoot, 'mcp-calls-' + arm + '-' + sample + '.jsonl');
        const env = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: os.tmpdir(),
          LANG: 'C',
          LC_ALL: 'C',
          MOSS_CONFIG_DIR: configDir,
          MOSS_RUN_ID: 'capability-ab/' + arm + '/' + String(sample).padStart(2, '0'),
          MOSS_SAFETY_MODE: 'workspace-write',
          MOSS_APPROVAL_POLICY: 'never',
          MOSS_TEMPERATURE: '0',
          MOSS_CAPABILITY_LAYER: arm,
          MOSS_MCP_BENCH_SERVER: FIXTURE_SERVER,
          MOSS_MCP_BENCH_NONCE: nonce,
          MOSS_MCP_BENCH_LOG: logAbs,
        };
        const cliArgs = [
          CLI_ENTRY,
          'task',
          'run',
          '--goal',
          GOAL,
          '--accept',
          'node check-goal.mjs',
        ];
        const t0 = Date.now();
        const run = await runMossTask({ cliArgs, workspace, env, timeoutMs: args.timeoutMs });
        const wallMs = Date.now() - t0;

        const outcomeMatch = run.stdout.match(/Task (\S+) — (PASS|FAIL|BLOCKED)/);
        const turnsMatch = run.stdout.match(/turns: (\d+)/);
        const mcpCalls = readJsonl(logAbs)
          .filter((e) => e.method === 'tools/call')
          .map((e) => ({ tool: e.tool, order: e.arguments?.order ?? null }));
        // Full process logs per sample — crash attribution must not depend
        // on how much of the tail we kept in the row.
        const logsDir = path.join(outDir, 'logs');
        fs.mkdirSync(logsDir, { recursive: true });
        fs.writeFileSync(path.join(logsDir, arm + '-' + sample + '.out.log'), run.stdout);
        fs.writeFileSync(path.join(logsDir, arm + '-' + sample + '.err.log'), run.stderr);
        // Durable crash triage: full logs stay on disk only (*.log is
        // gitignored), so the committed samples.json carries an error class.
        const errorClass =
          run.code === 0
            ? null
            : /429|rate limit|budget exceeded/i.test(run.stderr)
              ? 'rate-limit'
              : /ETIMEDOUT|timed out/i.test(run.stderr)
                ? 'timeout'
                : /ECONNREFUSED|ENOTFOUND|\b50[23]\b/i.test(run.stderr)
                  ? 'provider-unavailable'
                  : 'crash-exit-' + run.code;
        const row = {
          arm,
          sample,
          pass: run.code === 0 && outcomeMatch?.[2] === 'PASS',
          outcome: outcomeMatch?.[2] ?? null,
          exitCode: run.code,
          errorClass,
          timedOut: run.timedOut,
          engineTurnsPrinted: turnsMatch ? Number(turnsMatch[1]) : null,
          engineTurnsEvents: engineTurnsFromEvents(workspace),
          wallMs,
          mcpCalls,
          sessions: (() => {
            const s = sessionCounts(workspace);
            s.toolSequence = s.toolSequence.slice(0, 40);
            return s;
          })(),
          stdoutTail: run.stdout.trim().split('\n').slice(-8).join('\n').slice(-1200),
          stderrTail: run.stderr.trim().split('\n').slice(-30).join('\n').slice(-3000),
          workspace: args.keep ? workspace : null,
        };
        rows.push(row);
        fs.writeFileSync(
          path.join(outDir, 'samples.json'),
          JSON.stringify({ label, goal: GOAL, rows }, null, 2)
        );
        console.log(
          '[' +
            String(done).padStart(String(total).length, ' ') +
            '/' +
            total +
            '] ' +
            arm +
            ' #' +
            sample +
            ' ' +
            (row.pass ? 'PASS' : 'FAIL') +
            ' (engineTurns=' +
            (row.engineTurnsPrinted ?? '?') +
            '/ev:' +
            row.engineTurnsEvents +
            ', wall=' +
            (wallMs / 1000).toFixed(1) +
            's' +
            ', mcpCalls=[' +
            mcpCalls.map((c) => c.tool + (c.order ? ':' + c.order : '')).join(',') +
            ']' +
            ', layer=' +
            row.sessions.layerInPlanning +
            ', search=' +
            row.sessions.searchCalls +
            ', direct=' +
            row.sessions.ledgerDirectCalls +
            (row.timedOut ? ', TIMEOUT' : '') +
            ')'
        );
        if (!row.pass)
          console.log('    ↳ ' + row.stdoutTail.split('\n').slice(0, 3).join(' | ').slice(0, 300));
      }
    }
  } finally {
    // The scratch config dir holds the provider API key (0600 config.json) —
    // it is removed even with --keep; --keep preserves only the workspaces.
    fs.rmSync(configDir, { recursive: true, force: true });
    if (!args.keep) fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  const perArm = args.arms.map((arm) => {
    const runs = rows.filter((r) => r.arm === arm);
    const mean = (pick) => {
      const values = runs.map(pick).filter((v) => typeof v === 'number');
      return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
    };
    return {
      arm,
      passes: runs.filter((r) => r.pass).length,
      samples: runs.length,
      meanEngineTurns: mean((r) => r.engineTurnsPrinted),
      meanWallMs: mean((r) => r.wallMs),
      meanSearchCalls: mean((r) => r.sessions.searchCalls),
      meanDirectCalls: mean((r) => r.sessions.ledgerDirectCalls),
      meanAssistantMessages: mean((r) => r.sessions.assistantMessages),
      meanToolUses: mean((r) => r.sessions.toolUses),
      firstActionSearch: runs.filter((r) => r.sessions.firstMcpAction === 'search').length,
      firstActionDirect: runs.filter((r) => r.sessions.firstMcpAction === 'direct').length,
      layerFiredIn: runs.filter((r) => r.sessions.layerInPlanning > 0).length,
    };
  });
  const summary = {
    meta: {
      startedLabel: label,
      finishedAt: new Date().toISOString(),
      goal: GOAL,
      model: provider.model,
      temperature: 0,
      samples: args.samples,
      arms: args.arms,
      gitSha: execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim(),
    },
    perArm,
    rows,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n===== capability layer A/B =====');
  console.log(
    'arm   pass      turns  wall(s)  asstMsg  toolUses  search  direct  first=search  first=direct  layerFired'
  );
  for (const a of perArm) {
    console.log(
      a.arm.padEnd(5) +
        (a.passes + '/' + a.samples).padEnd(9) +
        String(a.meanEngineTurns ?? '?').padStart(5) +
        String(a.meanWallMs ? (a.meanWallMs / 1000).toFixed(1) : '?').padStart(8) +
        String(a.meanAssistantMessages ?? '?').padStart(8) +
        String(a.meanToolUses ?? '?').padStart(9) +
        String(a.meanSearchCalls ?? '?').padStart(7) +
        String(a.meanDirectCalls ?? '?').padStart(8) +
        String(a.firstActionSearch + '/' + a.samples).padStart(13) +
        String(a.firstActionDirect + '/' + a.samples).padStart(13) +
        String(a.layerFiredIn + '/' + a.samples).padStart(12)
    );
  }
  console.log('report: ' + path.join(outDir, 'summary.json'));
}

main().catch((err) => {
  console.error('[ab] ' + (err instanceof Error ? err.message : String(err)));
  process.exit(2);
});
