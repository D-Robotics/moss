#!/usr/bin/env node
// Agent capability benchmark runner.
//
// Runs each bench/tasks/<id>/ task against a pinned model through the headless
// JSONL contract (`moss -p --output-format stream-json`), scores the run with
// the task's check.mjs post-condition, and writes an aggregated report to
// bench/results/<label>/summary.json. Zero npm dependencies by design: the
// benchmark itself must not grow the complexity it measures.
//
// Provider defaults come from the Qoder custom provider entry that serves a
// deepseek model (~/.qoder-cn/settings.json). Override with MOSS_BENCH_API_KEY /
// --model / --base-url. The API key is written only to a 0600 config.json in a
// temporary MOSS_CONFIG_DIR and is never printed or committed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchRoot = path.join(repoRoot, 'bench');
const tasksRoot = path.join(benchRoot, 'tasks');
const resultsRoot = path.join(benchRoot, 'results');
const CLI_ENTRY = process.env.MOSS_BENCH_CLI ?? path.join(repoRoot, 'dist', 'cli.js');
const CHECK_TIMEOUT_MS = 90_000;
const KILL_GRACE_MS = 5_000;

function usage() {
  return [
    'Usage: npm run bench [-- <flags>]',
    '',
    'Flags:',
    '  --samples <n>        Runs per task (default 3)',
    '  --task <substr>      Only run tasks whose id contains <substr> (repeatable)',
    '  --temperature <t>    Pin MOSS_TEMPERATURE (default 0; "none" leaves it unset)',
    '  --model <id>         Override the benchmark model id',
    '  --base-url <url>     Override the provider base URL',
    '  --label <name>       Result directory name (default run-<timestamp>)',
    '  --baseline <name>    Compare against a prior run (label or results path).',
    '  --capability-gate <name>  Release gate: hard-tier score must beat the named',
    '                       baseline run by >=10 points; exit 1 otherwise.',
    '                       Reads bench/results/noise-band.json when present; exit 1',
    '                       if any task pass-rate drops beyond the noise band.',
    '  --keep               Keep temporary workspaces/config for debugging',
    '  --list               List tasks and exit',
    '  --help               Show this help',
    '',
    'API key resolution: MOSS_BENCH_API_KEY env var, else the deepseek entry in',
    '~/.qoder-cn/settings.json providers.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    samples: 3,
    taskFilters: [],
    temperature: 0,
    label: undefined,
    keep: false,
    baseline: undefined,
    capabilityGate: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--samples') out.samples = Number(next());
    else if (arg === '--task') out.taskFilters.push(next());
    else if (arg === '--baseline') out.baseline = next();
    else if (arg === '--capability-gate') out.capabilityGate = next();
    else if (arg === '--temperature') {
      out.temperature = next() === 'none' ? undefined : Number(next());
    } else if (arg === '--model') out.model = next();
    else if (arg === '--base-url') out.baseUrl = next();
    else if (arg === '--label') out.label = next();
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown flag: ${arg}`);
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
    // fall through to explicit env
  }
  return null;
}

function resolveProviderConfig(args) {
  const qoder = loadQoderDeepseekProvider();
  const apiKey = process.env.MOSS_BENCH_API_KEY || qoder?.apiKey;
  const model = args.model || qoder?.model;
  const baseUrl = args.baseUrl || qoder?.baseUrl;
  if (!apiKey || !model || !baseUrl) {
    console.error(
      '[bench] no provider config: set MOSS_BENCH_API_KEY (with --model/--base-url) or add a deepseek provider to ~/.qoder-cn/settings.json'
    );
    process.exit(2);
  }
  return { apiKey, model, baseUrl };
}

function loadTasks(filters) {
  if (!fs.existsSync(tasksRoot)) throw new Error(`missing ${tasksRoot}`);
  const tasks = fs
    .readdirSync(tasksRoot)
    .sort()
    .filter((name) => fs.existsSync(path.join(tasksRoot, name, 'task.json')))
    .map((name) => {
      const dir = path.join(tasksRoot, name);
      const task = JSON.parse(fs.readFileSync(path.join(dir, 'task.json'), 'utf8'));
      return {
        id: task.id ?? name,
        dir,
        prompt: task.prompt,
        maxTurns: task.maxTurns ?? 16,
        timeoutMs: task.timeoutMs ?? 300_000,
        env: task.env ?? {},
        tags: task.tags ?? [],
        // Environment variables copied from the bench parent process (values
        // never live in task.json — credentials stay in env/.env).
        passEnv: Array.isArray(task.passEnv) ? task.passEnv : [],
        // Task runs only when all of these are set; otherwise skipped (not
        // failed) so device tasks do not break device-less CI benches.
        requiresEnv: Array.isArray(task.requiresEnv) ? task.requiresEnv : [],
      };
    })
    .filter((task) => filters.length === 0 || filters.some((f) => task.id.includes(f)));
  if (tasks.length === 0) throw new Error('no tasks matched the filters');
  return tasks;
}

function gitSha() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

function runMossSample({ cliArgs, workspace, env, timeoutMs }) {
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

function parseJsonl(raw) {
  const events = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // non-JSON diagnostics on stdout are ignored
    }
  }
  return events;
}

function metricsFromEvents(events) {
  let result;
  let tokensIn = 0;
  let tokensOut = 0;
  let cacheRead = 0;
  let compactions = 0;
  let toolCalls = 0;
  const tokensByModel = {};
  for (const event of events) {
    if (event.type === 'llm_usage') {
      tokensIn += event.input_tokens ?? 0;
      tokensOut += event.output_tokens ?? 0;
      cacheRead += event.cache_read_tokens ?? 0;
      const model = event.model ?? '(default)';
      tokensByModel[model] =
        (tokensByModel[model] ?? 0) + (event.input_tokens ?? 0) + (event.output_tokens ?? 0);
    } else if (event.type === 'compaction') {
      compactions += 1;
    } else if (event.type === 'user') {
      const blocks = event.message?.content;
      if (Array.isArray(blocks)) toolCalls += blocks.filter((b) => b && b.tool_use_id).length;
    } else if (event.type === 'result') {
      result = event;
    }
  }
  return { result, tokensIn, tokensOut, cacheRead, compactions, toolCalls, tokensByModel };
}

function runCheck(task, workspace, canaryDir) {
  const r = spawnSync(process.execPath, [path.join(task.dir, 'check.mjs')], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: CHECK_TIMEOUT_MS,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: 'C',
      LC_ALL: 'C',
      MOSS_BENCH_TASK_DIR: task.dir,
      MOSS_BENCH_CANARY_DIR: canaryDir,
    },
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  return { pass: r.status === 0, output: output.slice(-800) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const tasks = loadTasks(args.taskFilters);
  if (args.list) {
    for (const task of tasks)
      console.log(
        `${task.id.padEnd(24)} turns<=${task.maxTurns} timeout=${task.timeoutMs}ms tags=${task.tags.join(',')}`
      );
    return;
  }
  if (!fs.existsSync(CLI_ENTRY)) {
    console.error(`[bench] ${CLI_ENTRY} missing — run npm run build first`);
    process.exit(2);
  }
  const provider = resolveProviderConfig(args);

  const label = args.label ?? `run-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)}`;
  const runDir = path.join(resultsRoot, label);
  fs.mkdirSync(runDir, { recursive: true });

  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-bench-'));
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
  // Opt-in skills provisioning for the skills-bench-trigger evidence run;
  // default bench behavior is unchanged (scratch config dir stays skill-free).
  if (process.env.MOSS_BENCH_WITH_SKILLS === '1') {
    const repoSkills = path.join(repoRoot, '.moss', 'skills');
    if (fs.existsSync(repoSkills)) {
      fs.cpSync(repoSkills, path.join(configDir, 'skills'), { recursive: true });
      console.error(
        `[bench] skills provisioned: ${fs.readdirSync(path.join(configDir, 'skills')).length} skill dirs -> ${configDir}/skills`
      );
    }
  }
  const canaryDir = path.join(scratchRoot, 'canary');
  fs.mkdirSync(canaryDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const require = createRequire(import.meta.url);
  const rows = [];
  const total = tasks.length * args.samples;
  let done = 0;
  console.log(
    `[bench] model=${provider.model} samples=${args.samples} tasks=${tasks.length} temperature=${args.temperature ?? 'unset'} label=${label}`
  );

  try {
    for (const task of tasks) {
      const missingEnv = task.requiresEnv.filter((key) => process.env[key] === undefined);
      if (missingEnv.length > 0) {
        console.log(
          `[bench] SKIP ${task.id} — missing required env: ${missingEnv.join(', ')} (device task; set it to include this benchmark)`
        );
        for (let sample = 1; sample <= args.samples; sample++) done += 1;
        continue;
      }
      for (let sample = 1; sample <= args.samples; sample++) {
        done += 1;
        const workspace = fs.mkdtempSync(path.join(scratchRoot, 'ws-'));
        const filesDir = path.join(task.dir, 'files');
        if (fs.existsSync(filesDir)) fs.cpSync(filesDir, workspace, { recursive: true });
        fs.rmSync(canaryDir, { recursive: true, force: true });
        fs.mkdirSync(canaryDir, { recursive: true });
        const prompt = task.prompt.replaceAll('{{CANARY_DIR}}', canaryDir);

        const mossEnv = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: os.tmpdir(),
          LANG: 'C',
          LC_ALL: 'C',
          MOSS_CONFIG_DIR: configDir,
          MOSS_RUN_ID: `bench/${task.id}/${String(sample).padStart(2, '0')}`,
          MOSS_SAFETY_MODE: 'workspace-write',
          MOSS_APPROVAL_POLICY: 'never',
          ...(args.temperature !== undefined ? { MOSS_TEMPERATURE: String(args.temperature) } : {}),
          ...(process.env.MOSS_GOAL_VERIFY_LOOP === '1'
            ? {
                MOSS_GOAL_VERIFY_LOOP: '1',
                MOSS_GOAL_VERIFY_CMD: `node ${JSON.stringify(path.join(task.dir, 'check.mjs'))}`,
                MOSS_BENCH_TASK_DIR: task.dir,
                MOSS_BENCH_CANARY_DIR: canaryDir,
              }
            : {}),
          ...task.env,
        };
        for (const key of task.passEnv) {
          if (process.env[key] !== undefined) mossEnv[key] = process.env[key];
        }
        const cliArgs = [
          CLI_ENTRY,
          '-p',
          '--output-format',
          'stream-json',
          '--ask-for-approval',
          'never',
          '--model',
          provider.model,
          '--base-url',
          provider.baseUrl,
          '--max-turns',
          String(task.maxTurns),
          prompt,
        ];

        const t0 = Date.now();
        const run = await runMossSample({
          cliArgs,
          workspace,
          env: mossEnv,
          timeoutMs: task.timeoutMs,
        });
        const wallMs = Date.now() - t0;
        const events = parseJsonl(run.stdout);
        const metrics = metricsFromEvents(events);
        fs.writeFileSync(
          path.join(runDir, `${task.id}-${String(sample).padStart(2, '0')}.jsonl`),
          run.stdout
        );
        if (run.stderr.trim())
          fs.writeFileSync(
            path.join(runDir, `${task.id}-${String(sample).padStart(2, '0')}.stderr.log`),
            run.stderr
          );

        const check = timedOutOrCrashed(run, metrics)
          ? {
              pass: false,
              output: run.timedOut
                ? 'moss run timed out'
                : 'moss run crashed before producing a result',
            }
          : runCheck(task, workspace, canaryDir);

        const row = {
          task: task.id,
          sample,
          pass: check.pass,
          mossExitCode: run.code,
          timedOut: run.timedOut,
          subtype: metrics.result?.subtype ?? null,
          numTurns: metrics.result?.num_turns ?? null,
          durationMs: metrics.result?.duration_ms ?? null,
          wallMs,
          tokensIn: metrics.tokensIn,
          tokensOut: metrics.tokensOut,
          cacheRead: metrics.cacheRead,
          toolCalls: metrics.toolCalls,
          compactions: metrics.compactions,
          tokensByModel: metrics.tokensByModel,
          checkOutput: check.output,
        };
        rows.push(row);
        console.log(
          `[${String(done).padStart(String(total).length, ' ')}/${total}] ${task.id} #${sample} ${row.pass ? 'PASS' : 'FAIL'} (${row.numTurns ?? '?'} turns, ${(wallMs / 1000).toFixed(1)}s, in=${metrics.tokensIn}, out=${metrics.tokensOut}, tools=${metrics.toolCalls}, compact=${metrics.compactions}${row.timedOut ? ', TIMEOUT' : ''})`
        );
        if (!row.pass && check.output)
          console.log(`    ↳ ${check.output.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
        if (!args.keep) fs.rmSync(workspace, { recursive: true, force: true });
      }
    }
  } finally {
    if (!args.keep) fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  const perTask = tasks.map((task) => {
    const runs = rows.filter((r) => r.task === task.id);
    const mean = (pick) => {
      const values = runs.map(pick).filter((v) => typeof v === 'number');
      return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
    };
    return {
      task: task.id,
      tags: task.tags,
      passes: runs.filter((r) => r.pass).length,
      samples: runs.length,
      meanTurns: mean((r) => r.numTurns),
      meanWallMs: mean((r) => r.wallMs),
      meanTokensIn: mean((r) => r.tokensIn),
      meanTokensOut: mean((r) => r.tokensOut),
      meanToolCalls: mean((r) => r.toolCalls),
      meanCompactions: mean((r) => r.compactions),
    };
  });

  // v0.10 capability score: tier:hard tasks weigh 3, everything else 1.
  const weightOf = (tags) => (Array.isArray(tags) && tags.includes('tier:hard') ? 3 : 1);
  const hardTasks = perTask.filter((t) => weightOf(t.tags) === 3);
  const easyTasks = perTask.filter((t) => weightOf(t.tags) !== 3);
  const rateOf = (t) => (t.samples > 0 ? t.passes / t.samples : 0);
  const capability = {
    hardScore: hardTasks.length
      ? Number(((hardTasks.reduce((n, t) => n + rateOf(t), 0) / hardTasks.length) * 100).toFixed(1))
      : null,
    easyScore: easyTasks.length
      ? Number(((easyTasks.reduce((n, t) => n + rateOf(t), 0) / easyTasks.length) * 100).toFixed(1))
      : null,
    weightedScore: perTask.length
      ? Number(perTask.reduce((n, t) => n + rateOf(t) * weightOf(t.tags), 0).toFixed(1))
      : null,
    hardTasks: hardTasks.length,
  };

  const summary = {
    meta: {
      startedAt,
      finishedAt: new Date().toISOString(),
      gitSha: gitSha(),
      mossVersion: require(path.join(repoRoot, 'package.json')).version,
      nodeVersion: process.version,
      platform: `${os.platform()}/${os.arch()}`,
      model: provider.model,
      baseUrl: provider.baseUrl,
      temperature: args.temperature ?? 'unset',
      samples: args.samples,
    },
    overall: {
      passes: rows.filter((r) => r.pass).length,
      runs: rows.length,
      passRate: rows.length ? rows.filter((r) => r.pass).length / rows.length : 0,
    },
    capability,
    tokensByModel: rows.reduce((acc, r) => {
      for (const [model, tokens] of Object.entries(r.tokensByModel ?? {}))
        acc[model] = (acc[model] ?? 0) + tokens;
      return acc;
    }, {}),
    perTask,
    rows,
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n===== benchmark summary =====');
  console.log('task                     pass    turns   tokIn   tokOut  tools  compact   wall(s)');
  for (const t of perTask) {
    console.log(
      `${t.task.padEnd(24)} ${`${t.passes}/${t.samples}`.padEnd(6)} ${String(t.meanTurns ?? '?').padStart(6)} ${String(t.meanTokensIn ?? '?').padStart(7)} ${String(t.meanTokensOut ?? '?').padStart(7)} ${String(t.meanToolCalls ?? '?').padStart(6)} ${String(t.meanCompactions ?? '?').padStart(7)} ${t.meanWallMs ? (t.meanWallMs / 1000).toFixed(1).padStart(9) : '?'}`
    );
  }
  console.log(
    `overall: ${summary.overall.passes}/${summary.overall.runs} = ${(summary.overall.passRate * 100).toFixed(1)}%`
  );
  if (capability.hardScore !== null) {
    console.log(
      `capability: hard ${capability.hardScore}/100 (${capability.hardTasks} task(s)) · easy ${capability.easyScore}/100 · weighted ${capability.weightedScore}`
    );
  }
  console.log(`report: ${path.join(runDir, 'summary.json')}`);

  if (args.capabilityGate) {
    const resultsRoot = path.join(repoRoot, 'bench', 'results');
    const gatePath = path.isAbsolute(args.capabilityGate)
      ? args.capabilityGate
      : fs.existsSync(path.join(resultsRoot, args.capabilityGate, 'summary.json'))
        ? path.join(resultsRoot, args.capabilityGate, 'summary.json')
        : args.capabilityGate;
    const base = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
    const baseHard = base.capability?.hardScore;
    const curHard = capability.hardScore;
    console.log(`\n===== capability gate (vs ${path.basename(path.dirname(gatePath))}) =====`);
    if (typeof baseHard !== 'number' || curHard === null) {
      console.error('[bench] capability gate: missing hard-tier scores on one side — BLOCKED');
      process.exit(1);
    }
    const delta = curHard - baseHard;
    const okGate = delta >= 10;
    console.log(
      `hard score: ${baseHard} -> ${curHard} (delta ${delta.toFixed(1)}pt, need >= +10) — ${okGate ? 'PASS' : 'BLOCKED'}`
    );
    if (!okGate) {
      console.error('[bench] capability gate failed: improvement below +10pt');
      process.exit(1);
    }
  }

  if (args.baseline) {
    const resultsRoot = path.join(repoRoot, 'bench', 'results');
    const baselinePath = path.isAbsolute(args.baseline)
      ? args.baseline
      : fs.existsSync(path.join(resultsRoot, args.baseline, 'summary.json'))
        ? path.join(resultsRoot, args.baseline, 'summary.json')
        : args.baseline;
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    let band = { maxDropPerTask: 0 };
    const noisePath = path.join(resultsRoot, 'noise-band.json');
    if (fs.existsSync(noisePath)) {
      band = JSON.parse(fs.readFileSync(noisePath, 'utf8'));
    }
    const base = new Map(
      (baseline.perTask ?? []).map((t) => [t.task, t.samples > 0 ? t.passes / t.samples : 0])
    );
    const cur = new Map(perTask.map((t) => [t.task, t.samples > 0 ? t.passes / t.samples : 0]));
    const allowed = Math.max(band.maxDropPerTask ?? 0, 0.0);
    const regressions = [];
    console.log(`\n===== baseline comparison (${path.basename(path.dirname(baselinePath))}) =====`);
    for (const [task, rate] of cur) {
      const before = base.get(task);
      if (before === undefined) {
        console.log(`${task.padEnd(24)} NEW (no baseline)`);
        continue;
      }
      const drop = before - rate;
      const status = drop > allowed + 1e-9 ? 'REGRESSION' : 'ok';
      if (status === 'REGRESSION') regressions.push({ task, before, now: rate });
      console.log(
        `${task.padEnd(24)} ${(before * 100).toFixed(0)}% -> ${(rate * 100).toFixed(0)}%  ${status} (band ${(allowed * 100).toFixed(0)}%)`
      );
    }
    for (const [task] of base) {
      if (!cur.has(task)) console.log(`${task.padEnd(24)} MISSING in this run`);
    }
    if (regressions.length > 0) {
      console.error(
        `\n[bench] BLOCKED: ${regressions.length} task(s) dropped beyond the noise band`
      );
      process.exit(1);
    }
    console.log('[bench] baseline gate passed');
  }
}

function timedOutOrCrashed(run, metrics) {
  if (run.timedOut) return true;
  if (run.code !== 0 && !metrics.result) return true;
  return false;
}

main().catch((err) => {
  console.error(`[bench] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
