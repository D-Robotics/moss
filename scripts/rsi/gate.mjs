#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { changedPaths, git, headSha, refSha, withBaseWorktree } from './lib/git.mjs';
import { decide, exitCodeFor, frozenHits, parseFrozenPatterns, select } from './lib/rule.mjs';

function usage() {
  return 'Usage: npm run rsi:gate -- --round N --baseline BASE_PATH --noise-band BASE_PATH --prediction FILE [--base REF] [--model ID] [--base-url URL] [--holdout-scores FILE]';
}

function parseArgs(argv) {
  const out = { base: 'main', skipVerify: false, repo: process.cwd() };
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

function readBaseJson(repo, sha, file) {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return null;
  const shown = git(repo, ['show', `${sha}:${file.replaceAll('\\', '/')}`]);
  return shown.status === 0 ? JSON.parse(shown.stdout) : null;
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

function mergedRounds(text, round) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (String(row.round) === String(round)) throw new Error(`round ${round} already exists`);
    if (row.decision === 'merged') count += 1;
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

function assertCandidateDist(repo) {
  const root = path.join(repo, 'dist');
  const cli = path.join(root, 'cli.js');
  if (!fs.statSync(cli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('npm run verify did not produce dist/cli.js');
  }
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`candidate dist contains a symlink: ${file}`);
      if (entry.isDirectory()) stack.push(file);
    }
  }
}

function evaluateFromBase(repo, baseSha, jobs) {
  assertCandidateDist(repo);
  return withBaseWorktree(repo, baseSha, (baseDir) => {
    const dist = path.join(repo, 'dist');
    const dest = path.join(baseDir, 'dist');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(dist, dest, { recursive: true });
    const out = {};
    for (const job of jobs) {
      const script = path.join(baseDir, job.script);
      if (!fs.existsSync(script)) {
        out[job.name] = { code: 127, summary: null, missing: true };
        continue;
      }
      const result = spawnSync(process.execPath, [script, ...job.args], {
        cwd: baseDir,
        env: benchEnv({ MOSS_BENCH_CLI: path.join(dest, 'cli.js') }),
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

const step = (status, reasons, extra = {}) => ({ status, reasons, ...extra });

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

  const baseSha = refSha(repo, options.base);
  const candidateSha = headSha(repo);
  if (baseSha === candidateSha) throw new Error('base must differ from candidate HEAD');
  if (git(repo, ['merge-base', '--is-ancestor', baseSha, candidateSha]).status !== 0) {
    throw new Error(`base ${options.base} is not an ancestor of HEAD`);
  }
  const paths = changedPaths(repo, baseSha, candidateSha);
  const shown = git(repo, ['show', `${baseSha}:.rsi/frozen.txt`]);
  const patterns = shown.status === 0 ? parseFrozenPatterns(shown.stdout) : null;
  const hits = patterns ? frozenHits(patterns, paths) : [];
  const integrityReasons = [
    ...(patterns ? [] : [`base ${baseSha} has no .rsi/frozen.txt`]),
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
    prediction = loadPrediction(repo, options.prediction);
    const baseline = readBaseJson(repo, baseSha, options.baseline);
    const band = readBaseJson(repo, baseSha, options.noiseBand ?? '.rsi/noise-band.json');
    const holdoutRaw = options.holdoutScores ?? process.env.MOSS_RSI_HOLDOUT_SCORES ?? null;
    const holdoutPath = holdoutRaw ? path.resolve(repo, holdoutRaw) : null;
    const holdout = holdoutPath && fs.existsSync(holdoutPath) ? readJson(holdoutPath) : null;
    const ledger = git(repo, ['show', `${baseSha}:.rsi/ledger.jsonl`]);
    const holdoutDue =
      (mergedRounds(ledger.status === 0 ? ledger.stdout : '', options.round) + 1) % 3 === 0;

    if (options.skipVerify) verify = step('skipped', ['skipped by --skip-verify']);
    else {
      const result = await (options.verifyRunner ?? defaultVerify)(repo);
      assertNotStopped(repo);
      verify = step(result.status, result.reasons ?? []);
    }
    const cliChanged = paths.some((file) => file === 'src/cli' || file.startsWith('src/cli/'));
    const label = options.label ?? `rsi-r${options.round}`;
    let devSummary = null;
    let deviceSummary = null;
    const harnessReasons = [];

    if (verify.status === 'pass') {
      const deviceLabel = `${label}-device`;
      const deviceArgs = [
        '--target',
        'sim',
        '--repeat',
        '3',
        '--label',
        deviceLabel,
        '--keep-artifacts',
      ];
      if (options.model) deviceArgs.push('--model', options.model);
      if (options.baseUrl) deviceArgs.push('--base-url', options.baseUrl);
      const jobs = [
        {
          name: 'dev',
          script: 'scripts/run-benchmark.mjs',
          label,
          args: benchArgs(label, options),
        },
        {
          name: 'device',
          script: 'scripts/bench-device.mjs',
          label: deviceLabel,
          args: deviceArgs,
        },
      ];
      if (cliChanged) jobs.push({ name: 'tui', script: 'scripts/tui-feel/run.mjs', args: [] });
      const ran = await (options.evalRunner ?? evaluateFromBase)(repo, baseSha, jobs);
      assertNotStopped(repo);
      evaluator = {
        from: 'base-worktree',
        origin: ran.dev?.origin ?? ran.dev?.summary?.origin ?? null,
      };
      if (ran.dev) {
        devSummary = ran.dev.summary;
        if (ran.dev.code !== 0) harnessReasons.push(`base run-benchmark exited ${ran.dev.code}`);
        if (!devSummary)
          harnessReasons.push(`base run-benchmark exited ${ran.dev.code} without a summary`);
      }
      if (ran.device) {
        deviceSummary = ran.device.summary;
        if (ran.device.code !== 0)
          harnessReasons.push(`base bench-device exited ${ran.device.code}`);
        if (!deviceSummary)
          harnessReasons.push(`base bench-device exited ${ran.device.code} without a summary`);
      }
      if (ran.tui && (ran.tui.missing || ran.tui.code !== 0 || !ran.tui.wrote)) {
        verify = step('fail', [
          ...(verify.status === 'fail' ? verify.reasons : []),
          'src/cli/ changed and base bench:tui-feel did not write a report',
        ]);
      }

      const picked = select({
        current: devSummary,
        baseline,
        band,
        device: deviceSummary,
        prediction,
        holdoutDue,
        holdout,
        baseSha,
      });
      if (harnessReasons.length > 0 || (holdoutPath && !holdout)) {
        picked.status = 'fail';
        picked.reasons = [
          ...harnessReasons,
          ...(holdoutPath && !holdout
            ? [`holdout scores path does not exist: ${holdoutPath}`]
            : []),
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
    baseSha,
    headSha: candidateSha,
    parent: options.parent ?? baseSha,
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
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
