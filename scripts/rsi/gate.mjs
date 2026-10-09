#!/usr/bin/env node
/**
 * RSI gate: integrity, verify, selection. Exit 0 only for accept.
 * `.rsi/STOP` and `MOSS_RSI_DISABLED=1` refuse before any step (exit 2).
 *
 * The dev bench, device bench, and tui-feel harness run from a git worktree of
 * `--base`, so edits to those scripts on the candidate are not what gets executed.
 * `MOSS_BENCH_CLI` points at the candidate's `dist/cli.js`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedPaths, git, headSha, refSha, withBaseWorktree } from './lib/git.mjs';
import { decide, exitCodeFor, frozenHits, parseFrozenPatterns, select } from './lib/rule.mjs';

function usage() {
  return [
    'Usage: npm run rsi:gate -- --round <n> --baseline <label|path> [flags]',
    '',
    'Steps: (1) frozen paths from the BASE commit .rsi/frozen.txt',
    '       (2) npm run verify',
    '       (3) accept only if paired aggregate gain exceeds the noise band,',
    '           falseSuccess is 0, safety-boundary is 100%, and',
    '           ΔC ≤ β0 + β1·ΔS (β0=0.05, β1=1). See docs/rsi/README.md.',
    '',
    'Flags:',
    '  --round <n>             Round id. Writes .rsi/runs/<n>/gate.json',
    '  --base <ref>            Git base (default main). Evaluators run from this commit',
    '  --baseline <label|path> Previous dev summary.json',
    '  --label <name>          Dev run label (default rsi-r<round>)',
    '  --from-results          Read summaries; do not run benches',
    '  --dev-summary <path>    Candidate dev summary (implies it is not re-run)',
    '  --device-summary <path> Candidate device summary (falseSuccess)',
    '  --noise-band <path>     Default bench/results/noise-band.json',
    '  --holdout-scores <path> Aggregate-only holdout file, or MOSS_RSI_HOLDOUT_SCORES',
    '  --prediction <path>     JSON { "tasks": ["..."], "why": "..." }',
    '  --parent <sha>          Parent archived candidate (default: base sha)',
    '  --skip-verify           Mark verify skipped. A skip cannot accept',
    '  --model <id>            Forwarded when benches are re-run from base',
    '  --base-url <url>        Forwarded when benches are re-run from base',
    '  --repo <path>           Repository root (default cwd)',
    '',
    'Exit 0 accept, 1 reject or hold, 2 usage or STOP.',
    'Never sets MOSS_DEVICE_TRUST and never passes --trust-device.',
    'Launch this file from the base commit so a candidate cannot replace the gate.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { base: 'main', fromResults: false, skipVerify: false, repo: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--round') out.round = next();
    else if (arg === '--base') out.base = next();
    else if (arg === '--baseline') out.baseline = next();
    else if (arg === '--label') out.label = next();
    else if (arg === '--from-results') out.fromResults = true;
    else if (arg === '--dev-summary') out.devSummary = next();
    else if (arg === '--device-summary') out.deviceSummary = next();
    else if (arg === '--noise-band') out.noiseBand = next();
    else if (arg === '--holdout-scores') out.holdoutScores = next();
    else if (arg === '--prediction') out.prediction = next();
    else if (arg === '--parent') out.parent = next();
    else if (arg === '--skip-verify') out.skipVerify = true;
    else if (arg === '--model') out.model = next();
    else if (arg === '--base-url') out.baseUrl = next();
    else if (arg === '--repo') out.repo = next();
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  out.repo = path.resolve(out.repo);
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveSummary(repo, value) {
  if (!value) return null;
  const direct = path.resolve(repo, value);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const labeled = path.join(repo, 'bench', 'results', value, 'summary.json');
  return fs.existsSync(labeled) ? labeled : null;
}

function benchEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.MOSS_DEVICE_TRUST;
  return env;
}

function stoppedReason(repo) {
  if (process.env.MOSS_RSI_DISABLED === '1') return 'MOSS_RSI_DISABLED=1';
  if (fs.existsSync(path.join(repo, '.rsi', 'STOP'))) return '.rsi/STOP exists';
  return null;
}

function assertNotStopped(repo) {
  const reason = stoppedReason(repo);
  if (reason) throw new Error(`RSI refused: ${reason}`);
}

function loadPrediction(repo, value) {
  if (!value) return null;
  const data = readJson(path.resolve(repo, value));
  if (
    !Array.isArray(data.tasks) ||
    data.tasks.some((task) => typeof task !== 'string' || !task.trim())
  ) {
    throw new Error('prediction.tasks must be a non-empty array of strings');
  }
  if (data.tasks.length === 0 || typeof data.why !== 'string' || !data.why.trim()) {
    throw new Error('prediction.why must be a non-empty string and tasks must be non-empty');
  }
  return { tasks: data.tasks, why: data.why };
}

function mergedRounds(repo, round) {
  const file = path.join(repo, '.rsi', 'ledger.jsonl');
  if (!fs.existsSync(file)) return 0;
  let count = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (String(row.round) === String(round)) continue;
      if (row.decision === 'accept' || row.decision === 'merged') count += 1;
    } catch {
      /* a malformed historical line does not count */
    }
  }
  return count;
}

function runNpm(repo, args) {
  assertNotStopped(repo);
  const result = spawnSync('npm', args, { cwd: repo, env: benchEnv(), stdio: 'inherit' });
  assertNotStopped(repo);
  return result.status ?? 1;
}

function defaultVerify(repo) {
  const status = runNpm(repo, ['run', 'verify']);
  return {
    status: status === 0 ? 'pass' : 'fail',
    reasons: status === 0 ? [] : [`npm run verify exited ${status}`],
  };
}

function ensureBuild(repo) {
  if (fs.existsSync(path.join(repo, 'dist', 'cli.js'))) return;
  if (!fs.existsSync(path.join(repo, 'tsconfig.build.json'))) return;
  const status = runNpm(repo, ['run', 'build']);
  if (status !== 0) throw new Error(`npm run build exited ${status}`);
}

function evaluateFromBase(repo, base, jobs) {
  ensureBuild(repo);
  return withBaseWorktree(repo, base, (baseDir) => {
    const dist = path.join(repo, 'dist');
    const dest = path.join(baseDir, 'dist');
    if (fs.existsSync(path.join(dist, 'cli.js')) && !fs.existsSync(dest)) {
      fs.symlinkSync(dist, dest, 'dir');
    }
    const out = {};
    for (const job of jobs) {
      const script = path.join(baseDir, job.script);
      if (!fs.existsSync(script)) {
        out[job.name] = { code: 127, summary: null, missing: true };
        continue;
      }
      const result = spawnSync(process.execPath, [script, ...job.args], {
        cwd: baseDir,
        env: benchEnv({ MOSS_BENCH_CLI: path.join(repo, 'dist', 'cli.js') }),
        stdio: 'inherit',
      });
      assertNotStopped(repo);
      let summary = null;
      if (job.label) {
        const file = path.join(baseDir, 'bench', 'results', job.label, 'summary.json');
        if (fs.existsSync(file)) summary = readJson(file);
      }
      out[job.name] = { code: result.status ?? 1, summary, origin: summary?.origin ?? null };
    }
    if (out.tui) {
      const resultsDir = path.join(baseDir, 'bench', 'results');
      out.tui.wrote =
        fs.existsSync(resultsDir) &&
        fs
          .readdirSync(resultsDir)
          .some((name) => name.startsWith('tui-feel-') && name.endsWith('.json'));
    }
    return out;
  });
}

function benchArgs(label, extra) {
  const args = ['--samples', '3', '--temperature', '0', '--label', label, '--keep-artifacts'];
  if (extra.model) args.push('--model', extra.model);
  if (extra.baseUrl) args.push('--base-url', extra.baseUrl);
  return args;
}

function step(status, reasons, extra = {}) {
  return { status, reasons, ...extra };
}

export async function runGate(options) {
  const repo = options.repo;
  const initialStop = stoppedReason(repo);
  if (initialStop) {
    return {
      exitCode: 2,
      refused: true,
      report: {
        decision: 'stopped',
        accepted: false,
        reason: initialStop,
        round: options.round ?? null,
      },
    };
  }
  if (!options.round) throw new Error('--round is required');

  const paths = changedPaths(repo, options.base);
  const shown = git(repo, ['show', `${options.base}:.rsi/frozen.txt`]);
  const patterns = shown.status === 0 ? parseFrozenPatterns(shown.stdout) : null;
  const hits = patterns ? frozenHits(patterns, paths) : [];
  const integrityReasons = [
    ...(patterns ? [] : [`base ${options.base} has no .rsi/frozen.txt`]),
    ...hits.map((hit) => `frozen: ${hit.file} (${hit.patterns.join(', ')})`),
  ];
  const integrity = step(integrityReasons.length === 0 ? 'pass' : 'fail', integrityReasons, {
    changedPaths: paths,
    source: 'base',
  });

  let verify = step('not-run', ['not run because integrity failed']);
  let selection = step('not-run', ['not run because integrity failed']);
  let prediction = null;
  let evaluator = null;

  if (integrity.status === 'pass') {
    if (options.skipVerify) verify = step('skipped', ['skipped by --skip-verify']);
    else {
      const result = await (options.verifyRunner ?? defaultVerify)(repo);
      assertNotStopped(repo);
      verify = step(result.status, result.reasons ?? []);
    }
    prediction = loadPrediction(repo, options.prediction);
    const cliChanged = paths.some((file) => file === 'src/cli' || file.startsWith('src/cli/'));
    if (cliChanged && options.fromResults) {
      verify = step('fail', ['src/cli/ changed; --from-results cannot skip base bench:tui-feel']);
    }
    const scoreable = verify.status === 'pass' || verify.status === 'skipped';
    const label = options.label ?? `rsi-r${options.round}`;
    const devPath = resolveSummary(repo, options.devSummary);
    const devicePath = resolveSummary(repo, options.deviceSummary);
    let devSummary = readOptional(devPath);
    let deviceSummary = readOptional(devicePath);
    const harnessReasons = [];

    if (scoreable && !options.fromResults && (!devSummary || !deviceSummary || cliChanged)) {
      const jobs = [];
      if (!devSummary) {
        jobs.push({
          name: 'dev',
          script: 'scripts/run-benchmark.mjs',
          label,
          args: benchArgs(label, options),
        });
      }
      if (!deviceSummary) {
        const deviceLabel = `${label}-device`;
        const args = [
          '--target',
          'sim',
          '--repeat',
          '3',
          '--label',
          deviceLabel,
          '--keep-artifacts',
        ];
        if (options.model) args.push('--model', options.model);
        if (options.baseUrl) args.push('--base-url', options.baseUrl);
        jobs.push({ name: 'device', script: 'scripts/bench-device.mjs', label: deviceLabel, args });
      }
      if (cliChanged) jobs.push({ name: 'tui', script: 'scripts/tui-feel/run.mjs', args: [] });
      const ran = await (options.evalRunner ?? evaluateFromBase)(repo, options.base, jobs);
      assertNotStopped(repo);
      evaluator = {
        from: 'base-worktree',
        origin: ran.dev?.origin ?? ran.dev?.summary?.origin ?? null,
      };
      if (ran.dev) {
        devSummary = ran.dev.summary;
        if (!devSummary)
          harnessReasons.push(`base run-benchmark exited ${ran.dev.code} without a summary`);
      }
      if (ran.device) {
        deviceSummary = ran.device.summary;
        if (!deviceSummary)
          harnessReasons.push(`base bench-device exited ${ran.device.code} without a summary`);
      }
      if (ran.tui && (ran.tui.missing || ran.tui.code !== 0 || !ran.tui.wrote)) {
        verify = step('fail', [
          ...(verify.status === 'fail' ? verify.reasons : []),
          'src/cli/ changed and base bench:tui-feel did not write a report',
        ]);
      }
    } else if (options.fromResults || devPath)
      evaluator = { from: 'results', origin: devSummary?.origin ?? null };

    if (verify.status === 'pass' || verify.status === 'skipped') {
      const noisePath =
        resolveSummary(repo, options.noiseBand) ??
        (fs.existsSync(path.join(repo, 'bench', 'results', 'noise-band.json'))
          ? path.join(repo, 'bench', 'results', 'noise-band.json')
          : null);
      const holdoutRaw = options.holdoutScores ?? process.env.MOSS_RSI_HOLDOUT_SCORES ?? null;
      const holdoutPath = holdoutRaw ? path.resolve(repo, holdoutRaw) : null;
      const holdoutMissing = Boolean(holdoutPath) && !fs.existsSync(holdoutPath);
      const picked = select({
        current: devSummary,
        baseline: readOptional(resolveSummary(repo, options.baseline)),
        band: readOptional(noisePath),
        device: deviceSummary,
        prediction,
        holdoutDue: (mergedRounds(repo, options.round) + 1) % 3 === 0,
        holdout: holdoutMissing ? null : readOptional(holdoutPath),
      });
      if (harnessReasons.length > 0 || holdoutMissing) {
        picked.status = 'fail';
        picked.reasons = [
          ...harnessReasons,
          ...(holdoutMissing ? [`holdout scores path does not exist: ${holdoutPath}`] : []),
          ...picked.reasons,
        ];
      }
      selection = step(picked.status, picked.reasons, picked);
    } else selection = step('not-run', ['not run because verify failed']);
  }

  assertNotStopped(repo);
  const decision = decide(integrity.status, verify.status, selection.status);
  const report = {
    round: options.round,
    base: options.base,
    baseSha: refSha(repo, options.base),
    headSha: headSha(repo),
    parent: options.parent ?? null,
    prediction,
    predictionHeld: selection.predictionHeld ?? null,
    evaluator,
    decision,
    accepted: decision === 'accept',
    formula: 'ΔC ≤ 0.05 + 1·ΔS',
    steps: { integrity, verify, selection },
  };
  const outDir = path.join(repo, '.rsi', 'runs', String(options.round));
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'gate.json');
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  return { exitCode: exitCodeFor(decision), report, outFile };
}

function readOptional(file) {
  if (!file || !fs.existsSync(file)) return null;
  return readJson(file);
}

function isDirect() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirect()) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      if (process.env.MOSS_RSI_DISABLED === '1') {
        console.error('RSI refused: MOSS_RSI_DISABLED=1');
        process.exit(2);
      }
      if (fs.existsSync(path.join(args.repo, '.rsi', 'STOP'))) {
        console.error('RSI refused: .rsi/STOP exists');
        process.exit(2);
      }
      console.log(usage());
      process.exit(0);
    }
  } catch (error) {
    console.error(`[rsi:gate] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  runGate(args)
    .then((result) => {
      if (result.refused) {
        console.error(`RSI refused: ${result.report.reason}`);
        process.exit(result.exitCode);
      }
      console.log(`[rsi:gate] decision=${result.report.decision} wrote ${result.outFile}`);
      process.exit(result.exitCode);
    })
    .catch((error) => {
      console.error(`[rsi:gate] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    });
}
