#!/usr/bin/env node
// Agent capability benchmark runner.
//
// Runs each bench/tasks/<id>/ task against a pinned model through the headless
// JSONL contract (`moss -p --output-format stream-json`), scores the run with
// the task's check.mjs post-condition, and writes an aggregated report to
// bench/results/<label>/summary.json. Zero npm dependencies by design: the
// benchmark itself must not grow the complexity it measures.
//
// Provider settings come from MOSS_BENCH_API_KEY, MOSS_BENCH_MODEL and
// MOSS_BENCH_BASE_URL; --model and --base-url override the latter two.
// The API key is written to a 0600 temporary config.json; --keep retains it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { releaseBenchWorkspace } from './lib/bench-artifacts.mjs';
import {
  HARNESS_FLAKE_RETRY_LIMIT,
  MINIMUM_GATED_SAMPLES,
  isHarnessFlakeSample,
  scoredBenchmarkRows,
} from './lib/bench-flake.mjs';

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
    '  --samples <n>        Runs per task (default 3). Baseline and capability',
    '                       gates require >=3. Zero-turn harness flakes are',
    '                       retried twice and exhausted flakes are excluded from scores.',
    '  --task <substr>      Only run tasks whose id contains <substr> (repeatable)',
    '  --tasks <n>          Random subset of n tasks. safety-boundary stays in the',
    '                       sample when it is in the pool. Same --seed draws the',
    '                       same subset. Default seed is moss-bench. Re-measure',
    '                       bench:noise on that subset; do not reuse a larger band.',
    '  --seed <text>        Seed for --tasks (default moss-bench)',
    '  --temperature <t>    Pin MOSS_TEMPERATURE to 0..2 (default 0; "none" does not pin it)',
    '  --model <id>         Model id (overrides MOSS_BENCH_MODEL)',
    '  --base-url <url>     Provider base URL (overrides MOSS_BENCH_BASE_URL)',
    '  --label <name>       Result directory name (default run-<timestamp>)',
    '  --baseline <name>    Compare against a prior run (label or results path).',
    '  --capability-gate <name>  Release gate: hard-tier score must beat the named',
    '                       baseline run by >=10 points; exit 1 otherwise.',
    '                       Reads bench/results/noise-band.json when present; exit 1',
    '                       if any task pass-rate drops beyond the noise band.',
    '  --keep               Keep temporary workspaces/config, including the provider key',
    '  --keep-artifacts     Copy <workspace>/.moss to bench/results/<label>/<task>-NN.moss',
    '                       before the workspace is deleted',
    '  --list               List tasks and exit',
    '  --help               Show this help',
    '',
    'Options with values also accept --option=value, including values starting with --.',
    '',
    'Set MOSS_BENCH_API_KEY, MOSS_BENCH_MODEL and MOSS_BENCH_BASE_URL in the',
    'environment, or supply the model and base URL with the flags above.',
    'The summary omits the base URL because it may contain credentials.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    samples: 3,
    taskFilters: [],
    temperature: 0,
    label: undefined,
    keep: false,
    keepArtifacts: false,
    baseline: undefined,
    capabilityGate: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const rawArg = argv[i];
    const equals = rawArg.indexOf('=');
    const arg = equals === -1 ? rawArg : rawArg.slice(0, equals);
    let inlineValue = equals === -1 ? undefined : rawArg.slice(equals + 1);
    const next = () => {
      const inline = inlineValue !== undefined;
      const value = inline ? inlineValue : argv[++i];
      inlineValue = undefined;
      if (
        value === undefined ||
        (arg !== '--seed' && value.trim() === '') ||
        (!inline && (value === '-h' || value.startsWith('--')))
      ) {
        throw new Error(`${arg} requires a value`);
      }
      return value;
    };
    if (arg === '--samples') out.samples = Number(next());
    else if (arg === '--task') out.taskFilters.push(next());
    else if (arg === '--tasks') out.tasks = Number(next());
    else if (arg === '--seed') out.seed = next();
    else if (arg === '--baseline') out.baseline = next();
    else if (arg === '--capability-gate') out.capabilityGate = next();
    else if (arg === '--temperature') {
      const value = next();
      if (value === 'none') {
        out.temperature = undefined;
      } else {
        const temperature = Number(value);
        if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
          throw new Error('--temperature must be a number between 0 and 2, or none');
        }
        out.temperature = temperature;
      }
    } else if (arg === '--model') out.model = next();
    else if (arg === '--base-url') out.baseUrl = next();
    else if (arg === '--label') out.label = next();
    else if (arg === '--keep') out.keep = true;
    else if (arg === '--keep-artifacts') out.keepArtifacts = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown flag: ${rawArg}`);
    if (inlineValue !== undefined) throw new Error(`${arg} does not accept a value`);
  }
  if (!Number.isInteger(out.samples) || out.samples < 1)
    throw new Error('--samples must be a positive integer');
  if (out.tasks !== undefined && (!Number.isInteger(out.tasks) || out.tasks < 1))
    throw new Error('--tasks must be a positive integer');
  return out;
}

function hashSeed(text) {
  let hash = 2166136261;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable subset. safety-boundary is kept when present. */
export function sampleTaskIds(ids, count, seed = 'moss-bench') {
  if (!Number.isInteger(count) || count < 1) throw new Error('--tasks must be a positive integer');
  const unique = [...new Set(ids)].sort();
  if (count > unique.length) throw new Error(`--tasks ${count} exceeds ${unique.length} tasks`);
  const pinned = unique.includes('safety-boundary') ? ['safety-boundary'] : [];
  const rest = unique.filter((id) => id !== 'safety-boundary');
  const random = mulberry32(hashSeed(seed));
  for (let i = rest.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...pinned, ...rest.slice(0, count - pinned.length)].sort();
}

function resolveProviderConfig(args) {
  const apiKey = process.env.MOSS_BENCH_API_KEY;
  const model = args.model ?? process.env.MOSS_BENCH_MODEL;
  const baseUrl = args.baseUrl ?? process.env.MOSS_BENCH_BASE_URL;
  if (!apiKey?.trim() || !model?.trim() || !baseUrl?.trim()) {
    console.error(
      '[bench] no provider config: set MOSS_BENCH_API_KEY, MOSS_BENCH_MODEL (or --model), and MOSS_BENCH_BASE_URL (or --base-url)'
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

const BENCH_LOCK_PATH = path.join(os.tmpdir(), 'moss-bench.lock');

function benchProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * B340: `npm run bench` clean-builds first, so a second concurrent run removed
 * dist/cli.js from under the first and every remaining task failed in 0.1s with
 * "Cannot find module .../dist/cli.js". Refuse to start instead.
 */
function acquireBenchLock() {
  const owner = () => {
    try {
      return Number.parseInt(fs.readFileSync(BENCH_LOCK_PATH, 'utf8').split('\n')[0] ?? '', 10);
    } catch {
      return Number.NaN;
    }
  };
  const pid = owner();
  if (Number.isInteger(pid) && pid > 1 && benchProcessAlive(pid) && pid !== process.pid) {
    console.error(
      `[bench] another bench run is in progress (pid ${pid}); wait for it to finish or delete ${BENCH_LOCK_PATH}`
    );
    return null;
  }
  fs.writeFileSync(BENCH_LOCK_PATH, `${process.pid}\n${new Date().toISOString()}\n`, {
    mode: 0o600,
  });
  const release = () => {
    try {
      if (owner() === process.pid) fs.rmSync(BENCH_LOCK_PATH, { force: true });
    } catch {
      // The lock is advisory; a failed cleanup must not mask the run's result.
    }
  };
  process.once('exit', release);
  return release;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  let tasks = loadTasks(args.taskFilters);
  if (args.tasks) {
    const seed = args.seed ?? 'moss-bench';
    const ids = sampleTaskIds(
      tasks.map((task) => task.id),
      args.tasks,
      seed
    );
    const chosen = new Set(ids);
    tasks = tasks.filter((task) => chosen.has(task.id));
    args.seed = seed;
    console.log(`[bench] task sample n=${tasks.length} seed=${seed} ids=${ids.join(',')}`);
  }
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
  if ((args.baseline || args.capabilityGate) && args.samples < MINIMUM_GATED_SAMPLES) {
    console.error(
      `[bench] --baseline/--capability-gate require at least ${MINIMUM_GATED_SAMPLES} samples (got ${args.samples}); ` +
        'single-sample runs are diagnostic only'
    );
    process.exit(2);
  }
  if (args.samples < MINIMUM_GATED_SAMPLES) {
    console.error('[bench] diagnostic run: samples<3 cannot support a regression or publish claim');
  }

  const taskSet = tasks.map((task) => task.id);
  const taskSetSha256 = createHash('sha256').update(JSON.stringify(taskSet)).digest('hex');
  const protocolId = createHash('sha256')
    .update(
      JSON.stringify({
        taskSet,
        samples: args.samples,
        temperature: args.temperature ?? null,
        harnessFlakeRetryLimit: HARNESS_FLAKE_RETRY_LIMIT,
      })
    )
    .digest('hex');

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
    `[bench] model=${provider.model} samples=${args.samples} tasks=${tasks.length} temperature=${args.temperature ?? 'not-pinned'} label=${label}`
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
        const sampleStem = `${task.id}-${String(sample).padStart(2, '0')}`;
        const standardJson = path.join(runDir, `${sampleStem}.jsonl`);
        const standardStderr = path.join(runDir, `${sampleStem}.stderr.log`);
        const harnessFlakeAttempts = [];
        let row;
        let totalWallMs = 0;

        for (let attempt = 1; attempt <= HARNESS_FLAKE_RETRY_LIMIT + 1; attempt += 1) {
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
            // B340: run ids are filesystem-safe flat names; slashes made the
            // run ledger reject every bench run (`invalid run id: bench/...`).
            MOSS_RUN_ID: `bench-${task.id}-${String(sample).padStart(2, '0')}`,
            MOSS_BENCH_RETRY_ATTEMPT: String(attempt),
            MOSS_SAFETY_MODE: 'workspace-write',
            MOSS_APPROVAL_POLICY: 'never',
            ...(args.temperature !== undefined
              ? { MOSS_TEMPERATURE: String(args.temperature) }
              : {}),
            ...(process.env.MOSS_GOAL_VERIFY_LOOP === '1'
              ? {
                  MOSS_GOAL_VERIFY_LOOP: '1',
                  MOSS_GOAL_VERIFY_CMD: `node ${JSON.stringify(path.join(task.dir, 'check.mjs'))}`,
                  MOSS_BENCH_TASK_DIR: task.dir,
                  MOSS_BENCH_CANARY_DIR: canaryDir,
                }
              : {}),
            // Per-task env may point at repo tooling without hard-coding the
            // checkout path: `{{REPO_ROOT}}` expands per run (e.g. MOSS_TSC_PATH).
            ...(task.env
              ? Object.fromEntries(
                  Object.entries(task.env).map(([key, value]) => [
                    key,
                    typeof value === 'string'
                      ? value.replaceAll('{{REPO_ROOT}}', repoRoot)
                      : String(value),
                  ])
                )
              : {}),
          };
          for (const key of ['MOSS_DISABLE_NUDGES', ...task.passEnv]) {
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
          totalWallMs += wallMs;
          const events = parseJsonl(run.stdout);
          const metrics = metricsFromEvents(events);
          const attemptStem =
            attempt === 1
              ? sampleStem
              : `${sampleStem}-attempt-${String(attempt).padStart(2, '0')}`;
          const attemptJson = path.join(runDir, `${attemptStem}.jsonl`);
          const attemptStderr = path.join(runDir, `${attemptStem}.stderr.log`);
          fs.writeFileSync(attemptJson, run.stdout);
          if (run.stderr.trim()) fs.writeFileSync(attemptStderr, run.stderr);

          const candidate = {
            task: task.id,
            sample,
            pass: false,
            mossExitCode: run.code,
            timedOut: run.timedOut,
            subtype: metrics.result?.subtype ?? null,
            numTurns: metrics.result?.num_turns ?? null,
            durationMs: metrics.result?.duration_ms ?? null,
            wallMs,
            totalWallMs,
            attempt,
            tokensIn: metrics.tokensIn,
            tokensOut: metrics.tokensOut,
            cacheRead: metrics.cacheRead,
            toolCalls: metrics.toolCalls,
            compactions: metrics.compactions,
            tokensByModel: metrics.tokensByModel,
            checkOutput: '',
          };

          if (isHarnessFlakeSample(candidate)) {
            candidate.harnessFlake = true;
            harnessFlakeAttempts.push(candidate);
            if (attempt <= HARNESS_FLAKE_RETRY_LIMIT) {
              console.error(
                `[bench] harness_flake ${task.id} #${sample} attempt ${attempt}: zero-turn error with no model/tool usage; retrying`
              );
              releaseBenchWorkspace({
                workspace,
                artifactDest: path.join(runDir, `${attemptStem}.moss`),
                keep: args.keep,
                keepArtifacts: args.keepArtifacts,
              });
              continue;
            }

            candidate.excludedAsHarnessFlake = true;
            candidate.checkOutput =
              'harness_flake: zero-turn error with no model/tool usage after retries; excluded from scored denominator';
            row = candidate;
            fs.copyFileSync(attemptJson, standardJson);
            if (fs.existsSync(attemptStderr)) fs.copyFileSync(attemptStderr, standardStderr);
            releaseBenchWorkspace({
              workspace,
              artifactDest: path.join(runDir, `${sampleStem}.moss`),
              keep: args.keep,
              keepArtifacts: args.keepArtifacts,
            });
            break;
          }

          const check = timedOutOrCrashed(run, metrics)
            ? {
                pass: false,
                output: run.timedOut
                  ? 'moss run timed out'
                  : 'moss run crashed before producing a result',
              }
            : runCheck(task, workspace, canaryDir);
          row = { ...candidate, pass: check.pass, checkOutput: check.output };
          if (harnessFlakeAttempts.length > 0) {
            row.harnessFlake = true;
            row.harnessFlakeAttempts = harnessFlakeAttempts;
          }
          if (attempt > 1) {
            fs.copyFileSync(attemptJson, standardJson);
            if (fs.existsSync(attemptStderr)) fs.copyFileSync(attemptStderr, standardStderr);
          }
          releaseBenchWorkspace({
            workspace,
            artifactDest: path.join(runDir, `${sampleStem}.moss`),
            keep: args.keep,
            keepArtifacts: args.keepArtifacts,
          });
          break;
        }

        rows.push(row);
        console.log(
          `[${String(done).padStart(String(total).length, ' ')}/${total}] ${task.id} #${sample} ${row.pass ? 'PASS' : 'FAIL'} (${row.numTurns ?? '?'} turns, ${(row.wallMs / 1000).toFixed(1)}s, in=${row.tokensIn}, out=${row.tokensOut}, tools=${row.toolCalls}, compact=${row.compactions}${row.timedOut ? ', TIMEOUT' : ''}${row.harnessFlake ? `, harness_flake${row.excludedAsHarnessFlake ? ':excluded' : ':retried'}` : ''})`
        );
        if (!row.pass && row.checkOutput)
          console.log(`    ↳ ${row.checkOutput.split('\n').slice(0, 3).join(' | ').slice(0, 300)}`);
      }
    }
  } finally {
    if (!args.keep) fs.rmSync(scratchRoot, { recursive: true, force: true });
  }

  const perTask = tasks.map((task) => {
    const runs = rows.filter((r) => r.task === task.id);
    const scoredRuns = scoredBenchmarkRows(runs);
    const mean = (pick) => {
      const values = scoredRuns.map(pick).filter((v) => typeof v === 'number');
      return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
    };
    return {
      task: task.id,
      tags: task.tags,
      passes: scoredRuns.filter((r) => r.pass).length,
      samples: runs.length,
      scoredSamples: scoredRuns.length,
      harnessFlakes: {
        retried: runs.filter((r) => r.harnessFlake && !r.excludedAsHarnessFlake).length,
        exhausted: runs.filter((r) => r.excludedAsHarnessFlake).length,
      },
      meanTurns: mean((r) => r.numTurns),
      meanWallMs: mean((r) => r.wallMs),
      meanTokensIn: mean((r) => r.tokensIn),
      meanTokensOut: mean((r) => r.tokensOut),
      meanToolCalls: mean((r) => r.toolCalls),
      meanCompactions: mean((r) => r.compactions),
    };
  });

  // v0.10 capability score: tier:hard tasks weigh 3, everything else 1.
  // Exhausted zero-turn harness flakes leave the scored denominator instead of
  // becoming false capability failures.
  const weightOf = (tags) => (Array.isArray(tags) && tags.includes('tier:hard') ? 3 : 1);
  const hardTasks = perTask.filter((t) => weightOf(t.tags) === 3);
  const easyTasks = perTask.filter((t) => weightOf(t.tags) !== 3);
  const rateOf = (t) => (t.scoredSamples > 0 ? t.passes / t.scoredSamples : null);
  const meanRate = (items) => {
    const rates = items.map(rateOf).filter((rate) => rate !== null);
    return rates.length === 0 ? null : rates.reduce((a, b) => a + b, 0) / rates.length;
  };
  const scoredPerTask = perTask.filter((t) => rateOf(t) !== null);
  const weightedDenominator = scoredPerTask.reduce((n, t) => n + weightOf(t.tags), 0);
  const capability = {
    hardScore: meanRate(hardTasks) === null ? null : Number((meanRate(hardTasks) * 100).toFixed(1)),
    easyScore: meanRate(easyTasks) === null ? null : Number((meanRate(easyTasks) * 100).toFixed(1)),
    weightedScore:
      weightedDenominator === 0
        ? null
        : Number(
            (
              (scoredPerTask.reduce((n, t) => n + (rateOf(t) ?? 0) * weightOf(t.tags), 0) /
                weightedDenominator) *
              100
            ).toFixed(1)
          ),
    hardTasks: hardTasks.length,
    scoredHardTasks: hardTasks.filter((t) => rateOf(t) !== null).length,
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
      baseUrl: '[omitted]',
      temperature: args.temperature ?? 'not-pinned',
      samples: args.samples,
      protocol: {
        harnessFlakeRetryLimit: HARNESS_FLAKE_RETRY_LIMIT,
        minimumGatedSamples: MINIMUM_GATED_SAMPLES,
        taskSet,
        taskSetSha256,
        protocolId,
      },
      ...(args.tasks
        ? {
            taskSample: { count: tasks.length, seed: args.seed, ids: tasks.map((task) => task.id) },
          }
        : {}),
    },
    overall: {
      passes: scoredBenchmarkRows(rows).filter((r) => r.pass).length,
      runs: rows.length,
      scoredRuns: scoredBenchmarkRows(rows).length,
      passRate: scoredBenchmarkRows(rows).length
        ? scoredBenchmarkRows(rows).filter((r) => r.pass).length / scoredBenchmarkRows(rows).length
        : null,
    },
    harnessFlakes: {
      retryLimit: HARNESS_FLAKE_RETRY_LIMIT,
      retried: rows.filter((r) => r.harnessFlake && !r.excludedAsHarnessFlake).length,
      exhausted: rows.filter((r) => r.excludedAsHarnessFlake).length,
      exhaustedRows: rows
        .filter((r) => r.excludedAsHarnessFlake)
        .map((r) => ({ task: r.task, sample: r.sample, attempts: r.attempt })),
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
    `overall: ${summary.overall.passes}/${summary.overall.scoredRuns} scored${summary.overall.passRate === null ? ' (no scored samples)' : ` = ${(summary.overall.passRate * 100).toFixed(1)}%`}`
  );
  console.log(
    `harness flakes: retried=${summary.harnessFlakes.retried} exhausted=${summary.harnessFlakes.exhausted} (retry limit ${HARNESS_FLAKE_RETRY_LIMIT})`
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
      (baseline.perTask ?? [])
        .map((t) => {
          const denominator = t.scoredSamples ?? t.samples;
          return [t.task, denominator > 0 ? t.passes / denominator : null];
        })
        .filter(([, rate]) => rate !== null)
    );
    const cur = new Map(
      perTask
        .filter((t) => t.scoredSamples > 0)
        .map((t) => [t.task, t.scoredSamples > 0 ? t.passes / t.scoredSamples : null])
    );
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

function isDirect() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirect()) {
  const releaseLock = acquireBenchLock();
  if (!releaseLock) process.exit(2);
  main()
    .catch((err) => {
      console.error(`[bench] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    })
    .finally(releaseLock);
}
