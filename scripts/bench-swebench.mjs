#!/usr/bin/env node
/**
 * SWE-bench runner for moss.
 *
 * Phase 1 (default): run moss headless inside each official eval container and
 * produce predictions.json in the upstream format.
 * Phase 2 (--eval): grade the predictions with the upstream swebench harness
 * (python) so scoring is the public, official rule.
 *
 * Env: MOSS_BENCH_API_KEY (required unless ~/.qoder-cn deepseek fallback).
 * Flags: --model M --base-url U --samples N --concurrency K --label L
 *        --filter substr --limit N --max-turns T --eval --skip-run
 * Examples:
 *   node scripts/bench-swebench.mjs --samples 2 --concurrency 3
 *   node scripts/bench-swebench.mjs --eval --label <previous-label>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  prepareContainer,
  writeProviderConfig,
  runMossInContainer,
  extractPatch,
  cleanupContainer,
  ensureNodeTarball,
  ensureImage,
  metricsFromStreamJson,
} from './lib/swebench-adapter.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const BOARDS = path.join(repoRoot, 'bench', 'boards', 'swebench-instances.json');
const RESULTS = path.join(repoRoot, 'bench', 'results');
const CACHE = path.join(repoRoot, 'bench', '.cache');

function parseArgs(argv) {
  const out = {
    samples: 2,
    concurrency: 2,
    label: null,
    filter: null,
    limit: null,
    maxTurns: 40,
    eval: false,
    skipRun: false,
    goalVerify: false,
    model: null,
    baseUrl: null,
    dist: null,
  };
  const next = () => {
    const v = argv.shift();
    if (v === undefined) throw new Error('missing flag value');
    return v;
  };
  while (argv.length) {
    const a = argv.shift();
    if (a === '--samples') out.samples = Number(next());
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--label') out.label = next();
    else if (a === '--filter') out.filter = next();
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--max-turns') out.maxTurns = Number(next());
    else if (a === '--model') out.model = next();
    else if (a === '--base-url') out.baseUrl = next();
    else if (a === '--dist') out.dist = next();
    else if (a === '--goal-verify') out.goalVerify = true;
    else if (a === '--eval') out.eval = true;
    else if (a === '--skip-run') out.skipRun = true;
    else if (a === '--rebuild-summary') out.rebuildSummary = true;
    else throw new Error(`unknown flag ${a}`);
  }
  return out;
}

function loadProvider(args) {
  let apiKey = process.env.MOSS_BENCH_API_KEY;
  let model = args.model;
  let baseUrl = args.baseUrl;
  if (!apiKey || !model || !baseUrl) {
    try {
      const settings = JSON.parse(
        fs.readFileSync(path.join(os.homedir(), '.qoder-cn', 'settings.json'), 'utf8')
      );
      for (const entry of Object.values(settings.providers ?? {})) {
        const names = [entry.model, ...(entry.models ?? []).map((m) => m.model)].filter(Boolean);
        if (names.some((n) => String(n).toLowerCase().startsWith('deepseek'))) {
          apiKey = apiKey || entry.apiKey;
          model = model || names.find((n) => String(n).toLowerCase().startsWith('deepseek'));
          baseUrl = baseUrl || entry.baseUrl;
        }
      }
    } catch {
      /* explicit env only */
    }
  }
  if (!apiKey || !model || !baseUrl) {
    console.error('[swe] missing provider config: set MOSS_BENCH_API_KEY/--model/--base-url');
    process.exit(2);
  }
  return { apiKey, model, baseUrl };
}

function gitSha() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Eval never calls the LLM — don't demand provider config for it.
  const provider = args.eval ? { apiKey: '', model: 'eval-only', baseUrl: '' } : loadProvider(args);
  const board = JSON.parse(fs.readFileSync(BOARDS, 'utf8'));
  let instances = board.instances;
  if (args.filter) instances = instances.filter((i) => i.instance_id.includes(args.filter));
  if (args.limit) instances = instances.slice(0, args.limit);
  const label = args.label ?? `swe-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)}`;
  const runDir = path.join(RESULTS, label);
  fs.mkdirSync(runDir, { recursive: true });

  if (args.eval) {
    await gradePredictions(runDir, label, args);
    return;
  }
  if (args.skipRun) {
    console.log(`[swe] skip-run: predictions already at ${path.join(runDir, 'predictions.json')}`);
    return;
  }
  if (args.rebuildSummary) {
    const samplesDir = path.join(runDir, 'samples');
    const results = fs.existsSync(samplesDir)
      ? fs
          .readdirSync(samplesDir)
          .filter((d) => fs.existsSync(path.join(samplesDir, d, 'meta.json')))
          .map((d) => JSON.parse(fs.readFileSync(path.join(samplesDir, d, 'meta.json'), 'utf8')))
      : [];
    if (results.length === 0) throw new Error(`no sample meta records under ${samplesDir}`);
    await writeAggregates(runDir, label, instances, results, {
      samples: args.samples,
      model: args.model ?? 'unknown',
      baseUrl: args.baseUrl ?? '',
      wallMs: 0,
    });
    return;
  }

  const distDir = args.dist ? path.resolve(args.dist) : path.join(repoRoot, 'dist');
  if (!fs.existsSync(path.join(distDir, 'cli.js'))) {
    console.error(
      `[swe] ${path.join(distDir, 'cli.js')} missing — run npm run build first or pass --dist`
    );
    process.exit(2);
  }
  const nodeModulesDir = path.join(path.dirname(distDir), 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    console.error(
      `[swe] ${nodeModulesDir} missing — snapshot dir must contain dist/ + node_modules/`
    );
    process.exit(2);
  }
  const nodeTar = await ensureNodeTarball(CACHE);

  const jobs = [];
  for (const inst of instances) {
    for (let s = 1; s <= args.samples; s += 1) jobs.push({ inst, sample: s });
  }
  console.log(
    `[swe] label=${label} instances=${instances.length} jobs=${jobs.length} model=${provider.model} sha=${gitSha()}`
  );

  // Prefetch images serially (avoids concurrent pull of the same layers).
  const images = [...new Set(instances.map((i) => i.image))];
  let pulled = 0;
  for (const image of images) {
    const ok = await ensureImage(image);
    pulled += ok ? 1 : 0;
    if (!ok) console.error(`[swe] image pull FAILED: ${image}`);
  }
  console.log(`[swe] images ready ${pulled}/${images.length}`);

  const t0 = Date.now();
  let done = 0;
  const results = [];
  let cursor = 0;
  async function worker(wid) {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const { inst, sample } = job;
      const name = `moss-swe-${inst.instance_id}-${sample}`.toLowerCase();
      const jobDir = path.join(runDir, 'samples', `${inst.instance_id}-${sample}`);
      fs.mkdirSync(jobDir, { recursive: true });
      const t = Date.now();
      try {
        await prepareContainer(inst, {
          containerName: name,
          mossDistDir: distDir,
          mossNodeModulesDir: nodeModulesDir,
          nodeTarballPath: nodeTar,
        });
        await writeProviderConfig(name, provider);
        // --goal-verify: hand the agent its own acceptance command (run the
        // instance's known failing tests) — the headless /goal engine then
        // forces one continuation turn when the fix doesn't pass them yet.
        const goalEnv = args.goalVerify
          ? {
              MOSS_GOAL_VERIFY_LOOP: '1',
              MOSS_GOAL_VERIFY_CMD: `cd /testbed && conda run -n testbed python -m pytest -x -q ${inst.fail_to_pass
                .slice(0, 8)
                .map((t) => JSON.stringify(t.split('::')[0]))
                .join(' ')} || true`,
            }
          : {};
        const run = await runMossInContainer(inst, {
          containerName: name,
          provider,
          maxTurns: args.maxTurns,
          ...(Object.keys(goalEnv).length ? { extraEnv: goalEnv } : {}),
        });
        fs.writeFileSync(path.join(jobDir, 'run.jsonl'), run.stdout || '');
        if (run.stderr) fs.writeFileSync(path.join(jobDir, 'run.stderr.log'), run.stderr);
        const metrics = metricsFromStreamJson(run.stdout || '');
        const patch = await extractPatch(inst, name);
        fs.writeFileSync(path.join(jobDir, 'patch.diff'), patch);
        const record = {
          instance_id: inst.instance_id,
          sample,
          exitCode: run.exitCode,
          wallMs: Date.now() - t,
          patchEmpty: patch.trim() === '',
          ...metrics,
        };
        results.push(record);
        fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify(record, null, 2));
        fs.appendFileSync(path.join(runDir, 'results.jsonl'), `${JSON.stringify(record)}\n`);
        console.log(
          `[swe] w${wid} ${inst.instance_id}#${sample} exit=${run.exitCode} patch=${
            patch.trim() === '' ? 'EMPTY' : `${patch.split('\n').length}L`
          } turns=${metrics.turns} tokens=${metrics.tokensIn + metrics.tokensOut} ${(
            record.wallMs / 60000
          ).toFixed(1)}m`
        );
      } catch (err) {
        results.push({
          instance_id: inst.instance_id,
          sample,
          error: String(err?.message ?? err).slice(0, 500),
          wallMs: Date.now() - t,
        });
        fs.appendFileSync(
          path.join(runDir, 'results.jsonl'),
          `${JSON.stringify(results[results.length - 1])}\n`
        );
        fs.writeFileSync(
          path.join(jobDir, 'meta.json'),
          JSON.stringify({ instance_id: inst.instance_id, sample, error: String(err) }, null, 2)
        );
        console.error(`[swe] w${wid} ${inst.instance_id}#${sample} ERROR ${err?.message ?? err}`);
      } finally {
        await cleanupContainer(name);
        done += 1;
        if (done % 5 === 0 || done === jobs.length)
          console.log(
            `[swe] progress ${done}/${jobs.length} elapsed=${((Date.now() - t0) / 60000).toFixed(
              1
            )}m`
          );
      }
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, (_, i) => worker(i + 1)));

  await writeAggregates(runDir, label, instances, results, {
    samples: args.samples,
    model: provider.model,
    baseUrl: provider.baseUrl,
    wallMs: Date.now() - t0,
  });
}

// Rebuilds predictions.json + summary.json from per-sample meta records; shared
// by the live run path and --rebuild-summary (process-death recovery).
async function writeAggregates(runDir, label, instances, results, meta) {
  // One prediction per instance: prefer the last non-empty sample patch.
  const predictions = [];
  for (const inst of instances) {
    const sampleResults = results
      .filter((r) => r.instance_id === inst.instance_id)
      .sort((a, b) => a.sample - b.sample);
    const chosen = [...sampleResults].reverse().find((r) => !r.patchEmpty && !r.error);
    predictions.push({
      instance_id: inst.instance_id,
      model_patch: chosen
        ? fs.readFileSync(
            path.join(runDir, 'samples', `${inst.instance_id}-${chosen.sample}`, 'patch.diff'),
            'utf8'
          )
        : '',
      model_name_or_path: 'moss',
    });
  }
  fs.writeFileSync(path.join(runDir, 'predictions.json'), JSON.stringify(predictions, null, 2));

  const summary = {
    label,
    sha: gitSha(),
    model: meta.model,
    baseUrl: meta.baseUrl,
    instances: instances.length,
    samples: meta.samples,
    wallMs: meta.wallMs ?? 0,
    withPatch: predictions.filter((p) => p.model_patch.trim() !== '').length,
    emptyPatch: predictions.filter((p) => p.model_patch.trim() === '').length,
    errors: results.filter((r) => r.error).length,
    tokensIn: results.reduce((a, r) => a + (r.tokensIn ?? 0), 0),
    tokensOut: results.reduce((a, r) => a + (r.tokensOut ?? 0), 0),
  };
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log('[swe] aggregates written', JSON.stringify(summary));
  console.log(
    `[swe] next: MOSS_BENCH_API_KEY=... node scripts/bench-swebench.mjs --eval --label ${label}`
  );
}

async function gradePredictions(runDir, label, args) {
  const predsPath = path.join(runDir, 'predictions.json');
  if (!fs.existsSync(predsPath)) throw new Error(`missing ${predsPath}`);
  const venvPython = await ensureSwebenchVenv();
  // Native docker socket first (Linux hosts); fall back to the colima socket
  // (macOS) so the eval harness works on both.
  const defaultDockerHost = fs.existsSync('/var/run/docker.sock')
    ? 'unix:///var/run/docker.sock'
    : `unix://${path.join(os.homedir(), '.colima/default/docker.sock')}`;
  const env = {
    ...process.env,
    DOCKER_HOST: process.env.DOCKER_HOST ?? defaultDockerHost,
  };
  const harnessArgs = [
    '-m',
    'swebench.harness.run_evaluation',
    '--predictions_path',
    predsPath,
    '--dataset_name',
    'SWE-bench/SWE-bench_Verified',
    '--run_id',
    label,
    '--max_workers',
    String(args.concurrency),
    '--report_dir',
    path.join(runDir, 'harness-report'),
  ];
  console.log(`[swe:eval] ${venvPython} ${harnessArgs.join(' ')}`);
  const child = spawn(venvPython, harnessArgs, {
    cwd: runDir,
    env,
    stdio: 'inherit',
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  console.log(`[swe:eval] harness exit=${code}`);
  // The harness writes <model_name_or_path>.<run_id>.json into --report_dir.
  const reportDir = path.join(runDir, 'harness-report');
  const reportPath = fs.existsSync(reportDir)
    ? fs
        .readdirSync(reportDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(reportDir, f))[0]
    : undefined;
  console.log(`[swe:eval] report=${reportPath ?? 'NOT FOUND'}`);
  if (reportPath) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const resolved = [...(report.resolved_ids ?? [])];
    // resolved% is over SUBMITTED instances — total_instances counts the whole
    // dataset (500) even when only a subset was predicted.
    const total = report.submitted_instances ?? report.total_instances ?? resolved.length;
    const resolvedPct = total > 0 ? Math.round((resolved.length / total) * 1000) / 10 : 0;
    console.log(`[swe:eval] resolved ${resolved.length}/${total} (${resolvedPct}%)`);
    fs.writeFileSync(
      path.join(runDir, 'grade-summary.json'),
      JSON.stringify(
        {
          reportPath,
          resolvedCount: resolved.length,
          resolvedIds: resolved,
          submittedInstances: total,
          resolvedPct,
        },
        null,
        2
      )
    );
  }
  if (code !== 0) process.exit(code);
}

async function ensureSwebenchVenv() {
  const venvDir = path.join(CACHE, 'swebench-venv');
  const python = path.join(venvDir, 'bin', 'python');
  if (fs.existsSync(python)) return python;
  fs.mkdirSync(CACHE, { recursive: true });
  const create = spawnSync('python3', ['-m', 'venv', venvDir], { stdio: 'inherit' });
  if (create.status !== 0) throw new Error('python3 venv creation failed');
  const install = spawnSync(path.join(venvDir, 'bin', 'pip'), ['install', '--quiet', 'swebench'], {
    stdio: 'inherit',
  });
  if (install.status !== 0) throw new Error('pip install swebench failed');
  return python;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
