#!/usr/bin/env node
/**
 * RSI round gate. Chains G0–G6 and writes `.rsi/runs/<round>/gate.json`.
 * Exit 0 only when the decision is accept or neutral (both are acceptances).
 * `.rsi/STOP` and `MOSS_RSI_DISABLED=1` refuse the run before any gate.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decide, exitCodeFor } from './lib/decide.mjs';
import { changedPaths, headSha, netLineChange } from './lib/git.mjs';
import { frozenHits, loadFrozenPatterns, testCountReport } from './lib/frozen.mjs';
import {
  evaluateCost,
  evaluateDevRegression,
  evaluateDevice,
  evaluateHoldout,
  evaluateOverfit,
  evaluateTui,
  hardScore,
} from './lib/scores.mjs';

function usage() {
  return [
    'Usage: npm run rsi:gate -- --round <n> [flags]',
    '',
    'Flags:',
    '  --round <n>              Round id. Results go to .rsi/runs/<n>/gate.json',
    '  --split dev|holdout|all  dev = G0–G5 (default all also scores G6 when a file is present)',
    '  --base <ref>             Git base ref (default main)',
    '  --baseline <label|path>  Previous accepted dev summary (label under bench/results or a summary.json path)',
    '  --label <name>           Current dev run label (default rsi-r<round>)',
    '  --from-results           Read summary.json files instead of re-running benches',
    '  --dev-summary <path>     Current dev summary.json (overrides --label)',
    '  --device-summary <path>  Current device summary.json',
    '  --device-baseline <label|path>',
    '  --noise-band <path>      Default bench/results/noise-band.json',
    '  --holdout-scores <path>  Aggregate-only holdout file (or MOSS_RSI_HOLDOUT_SCORES)',
    '  --tui-summary <path>     Current tui-feel JSON',
    '  --tui-baseline <path>    Previous tui-feel JSON',
    '  --skip-verify            Do not run npm run verify. G1 is skipped, not passed',
    '  --model <id>             Forwarded to dev and device benches when they are re-run',
    '  --base-url <url>         Forwarded to dev and device benches when they are re-run',
    '  --repo <path>            Repository root (default cwd)',
    '  --help',
    '',
    'Exit 0 only for decision accept or neutral. pending-holdout and reject exit 1.',
    'A missing holdout file marks G6 skipped and the decision is at most pending-holdout.',
    'This command never sets MOSS_DEVICE_TRUST and never passes --trust-device.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = {
    split: 'all',
    base: 'main',
    fromResults: false,
    skipVerify: false,
    repo: process.cwd(),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--round') out.round = next();
    else if (arg === '--split') out.split = next();
    else if (arg === '--base') out.base = next();
    else if (arg === '--baseline') out.baseline = next();
    else if (arg === '--label') out.label = next();
    else if (arg === '--from-results') out.fromResults = true;
    else if (arg === '--dev-summary') out.devSummary = next();
    else if (arg === '--device-summary') out.deviceSummary = next();
    else if (arg === '--device-baseline') out.deviceBaseline = next();
    else if (arg === '--noise-band') out.noiseBand = next();
    else if (arg === '--holdout-scores') out.holdoutScores = next();
    else if (arg === '--tui-summary') out.tuiSummary = next();
    else if (arg === '--tui-baseline') out.tuiBaseline = next();
    else if (arg === '--skip-verify') out.skipVerify = true;
    else if (arg === '--model') out.model = next();
    else if (arg === '--base-url') out.baseUrl = next();
    else if (arg === '--repo') out.repo = next();
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!['dev', 'holdout', 'all'].includes(out.split)) {
    throw new Error('--split must be dev, holdout, or all');
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
  if (fs.existsSync(labeled)) return labeled;
  return null;
}

function benchEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.MOSS_DEVICE_TRUST;
  return env;
}

function runCommand(repo, command, args) {
  const result = spawnSync(command, args, {
    cwd: repo,
    env: benchEnv(),
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

function defaultVerify(repo) {
  const status = runCommand(repo, 'npm', ['run', 'verify']);
  return {
    status: status === 0 ? 'pass' : 'fail',
    reasons: status === 0 ? [] : [`npm run verify exited ${status}`],
  };
}

function runDevBench(repo, { label, baseline, model, baseUrl }) {
  const args = [
    'scripts/run-benchmark.mjs',
    '--samples',
    '3',
    '--temperature',
    '0',
    '--label',
    label,
    '--keep-artifacts',
  ];
  if (baseline) args.push('--baseline', baseline);
  if (model) args.push('--model', model);
  if (baseUrl) args.push('--base-url', baseUrl);
  return runCommand(repo, process.execPath, args);
}

function runDeviceBench(repo, { label, model, baseUrl }) {
  const args = [
    'scripts/bench-device.mjs',
    '--target',
    'sim',
    '--repeat',
    '3',
    '--label',
    label,
    '--keep-artifacts',
  ];
  if (model) args.push('--model', model);
  if (baseUrl) args.push('--base-url', baseUrl);
  return runCommand(repo, process.execPath, args);
}

function runTui(repo) {
  return runCommand(repo, process.execPath, ['scripts/tui-feel/run.mjs']);
}

function loadOptional(file) {
  if (!file) return null;
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function previousOverfitSignal(repo, round) {
  const file = path.join(repo, '.rsi', 'ledger.jsonl');
  if (!fs.existsSync(file)) return false;
  const roundNumber = Number(round);
  let best = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry.round !== 'number') continue;
    if (Number.isFinite(roundNumber) && entry.round >= roundNumber) continue;
    if (best && entry.round < best.round) continue;
    best = entry;
  }
  return Boolean(best?.gates?.G7?.overfitSignal || best?.gates?.G7?.alarm);
}

function readPriorGate(repo, round) {
  const file = path.join(repo, '.rsi', 'runs', String(round), 'gate.json');
  if (!fs.existsSync(file)) return null;
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

function gateShell(status, reasons, extra = {}) {
  return { status, reasons, ...extra };
}

function newestTuiReport(repo, notBeforeMs) {
  const dir = path.join(repo, 'bench', 'results');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith('tui-feel-') && name.endsWith('.json'))
    .map((name) => {
      const full = path.join(dir, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .filter((item) => item.mtime >= notBeforeMs)
    .sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full ?? null;
}

export async function runGate(options) {
  const repo = options.repo;
  if (process.env.MOSS_RSI_DISABLED === '1') {
    return {
      exitCode: 2,
      refused: true,
      report: { decision: 'stopped', accepted: false, reason: 'MOSS_RSI_DISABLED=1' },
    };
  }
  const stopFile = path.join(repo, '.rsi', 'STOP');
  if (fs.existsSync(stopFile)) {
    return {
      exitCode: 2,
      refused: true,
      report: {
        decision: 'stopped',
        accepted: false,
        reason: '.rsi/STOP exists',
        round: options.round ?? null,
      },
    };
  }
  if (!options.round) throw new Error('--round is required');

  const split = options.split ?? 'all';
  const runDev = split === 'dev' || split === 'all';
  const runHoldout = split === 'holdout' || split === 'all';
  const prior = readPriorGate(repo, options.round);
  const label = options.label ?? `rsi-r${options.round}`;
  const deviceLabel = `${label}-device`;
  const paths = changedPaths(repo, options.base);
  const frozenFile = path.join(repo, '.rsi', 'frozen.txt');
  if (!fs.existsSync(frozenFile)) throw new Error(`missing ${frozenFile}`);
  const patterns = loadFrozenPatterns(frozenFile);

  const gates = {};
  const reuse = (name) => {
    const previous = prior?.gates?.[name];
    if (previous && (previous.status === 'pass' || previous.status === 'not-applicable')) {
      gates[name] = { ...previous, reused: true };
      return true;
    }
    return false;
  };

  if (runDev || runHoldout) {
    const hits = frozenHits(patterns, paths);
    const tests = testCountReport(repo, options.base);
    const reasons = [
      ...hits.map((hit) => `frozen: ${hit.file} (${hit.patterns.join(', ')})`),
      ...tests.reasons,
    ];
    gates.G0 = gateShell(reasons.length === 0 ? 'pass' : 'fail', reasons, {
      changedPaths: paths,
      testCount: {
        beforeFiles: tests.beforeFiles,
        afterFiles: tests.afterFiles,
        beforeCases: tests.beforeCases,
        afterCases: tests.afterCases,
      },
    });
  }

  if (runDev && gates.G0.status !== 'pass') {
    gates.G1 = gateShell('not-run', ['not run because G0 failed']);
  } else if (runDev) {
    if (options.skipVerify) {
      gates.G1 = gateShell('skipped', ['skipped by --skip-verify']);
    } else {
      const verify = await (options.verifyRunner ?? defaultVerify)(repo);
      gates.G1 = gateShell(verify.status, verify.reasons ?? []);
    }
  } else if (!reuse('G1')) {
    gates.G1 = gateShell('missing', ['no prior dev gate for this round']);
  }

  const devSummaryPath =
    resolveSummary(repo, options.devSummary) ??
    (options.fromResults ? resolveSummary(repo, label) : null);
  const baselinePath = resolveSummary(repo, options.baseline);
  let devSummary = loadOptional(devSummaryPath);
  let baselineSummary = loadOptional(baselinePath);

  if (runDev && !options.fromResults && gates.G0.status === 'pass') {
    const code = await (options.benchRunner ?? runDevBench)(repo, {
      label,
      baseline: options.baseline,
      model: options.model,
      baseUrl: options.baseUrl,
    });
    devSummary = loadOptional(path.join(repo, 'bench', 'results', label, 'summary.json'));
    if (!baselineSummary) baselineSummary = loadOptional(baselinePath);
    if (code !== 0 && !devSummary) {
      gates.G2 = gateShell('fail', [`run-benchmark exited ${code} without a summary`]);
    }
  }

  const noisePath =
    resolveSummary(repo, options.noiseBand) ??
    (fs.existsSync(path.join(repo, 'bench', 'results', 'noise-band.json'))
      ? path.join(repo, 'bench', 'results', 'noise-band.json')
      : null);
  const band = loadOptional(noisePath);

  if (runDev && !gates.G2) {
    const result = evaluateDevRegression(devSummary, baselineSummary, band);
    gates.G2 = gateShell(result.status, result.reasons, {
      regressions: result.regressions ?? [],
      safetyRate: result.safetyRate ?? null,
      bandNote: result.bandNote ?? null,
      summary: devSummaryPath ?? path.join(repo, 'bench', 'results', label, 'summary.json'),
      baseline: baselinePath,
    });
  } else if (!runDev && !gates.G2 && !reuse('G2')) {
    gates.G2 = gateShell('missing', ['no prior dev gate for this round']);
  }

  const deviceSummaryPath = resolveSummary(repo, options.deviceSummary);
  const deviceBaselinePath = resolveSummary(repo, options.deviceBaseline);
  let deviceSummary = loadOptional(deviceSummaryPath);
  let deviceBaseline = loadOptional(deviceBaselinePath);
  if (runDev && !options.fromResults && gates.G0.status === 'pass' && !deviceSummary) {
    const code = await (options.deviceRunner ?? runDeviceBench)(repo, {
      label: deviceLabel,
      model: options.model,
      baseUrl: options.baseUrl,
    });
    deviceSummary = loadOptional(path.join(repo, 'bench', 'results', deviceLabel, 'summary.json'));
    if (code !== 0 && !deviceSummary) {
      gates.G3 = gateShell('fail', [`bench-device exited ${code} without a summary`]);
    }
  }
  if (runDev && !gates.G3) {
    const result = evaluateDevice(deviceSummary, deviceBaseline);
    gates.G3 = gateShell(result.status, result.reasons, {
      coreNow: result.now ?? null,
      coreBaseline: result.before ?? null,
      spread: result.spread ?? null,
      falseSuccess: result.falseSuccess ?? null,
    });
  } else if (!runDev && !reuse('G3')) {
    gates.G3 = gateShell('missing', ['no prior dev gate for this round']);
  }

  let costDropPct;
  if (runDev) {
    const cost = evaluateCost(devSummary, baselineSummary);
    costDropPct = cost.costDropPct;
    gates.G4 = gateShell(cost.status, cost.reasons, {
      tokensNow: cost.tokensNow,
      tokensBase: cost.tokensBase,
      wallNow: cost.wallNow,
      wallBase: cost.wallBase,
      costDropPct: cost.costDropPct,
    });
  } else if (!reuse('G4')) {
    gates.G4 = gateShell('missing', ['no prior dev gate for this round']);
    costDropPct = prior?.costDropPct ?? null;
  } else {
    costDropPct = gates.G4.costDropPct ?? prior?.costDropPct ?? null;
  }

  const cliChanged = paths.some((file) => file === 'src/cli' || file.startsWith('src/cli/'));
  if (runDev) {
    let tuiSummary = loadOptional(resolveSummary(repo, options.tuiSummary));
    const tuiBaseline = loadOptional(resolveSummary(repo, options.tuiBaseline));
    if (cliChanged && !options.fromResults && gates.G0.status === 'pass' && !tuiSummary) {
      const started = Date.now();
      const code = await (options.tuiRunner ?? runTui)(repo);
      const produced = newestTuiReport(repo, started);
      tuiSummary = loadOptional(produced);
      if (code !== 0 && !tuiSummary) {
        gates.G5 = gateShell('fail', [`bench:tui-feel exited ${code}`]);
      }
    }
    if (!gates.G5) {
      const result = evaluateTui({ cliChanged, current: tuiSummary, baseline: tuiBaseline });
      gates.G5 = gateShell(result.status, result.reasons);
    }
  } else if (!reuse('G5')) {
    gates.G5 = gateShell('missing', ['no prior dev gate for this round']);
  }

  const holdoutRaw = options.holdoutScores ?? process.env.MOSS_RSI_HOLDOUT_SCORES ?? null;
  const holdoutPath = holdoutRaw ? path.resolve(repo, holdoutRaw) : null;
  if (runHoldout || holdoutPath) {
    const file = holdoutPath && fs.existsSync(holdoutPath) ? readJson(holdoutPath) : null;
    const result = evaluateHoldout(holdoutPath ? file : null);
    if (holdoutPath && !file) {
      gates.G6 = gateShell('fail', [`holdout scores path does not exist: ${holdoutPath}`], {
        relation: 'fail',
      });
    } else {
      gates.G6 = gateShell(result.status, result.reasons, {
        relation: result.relation,
        score: result.score ?? null,
        baseline: result.baseline ?? null,
        band: result.band ?? null,
      });
    }
  } else {
    gates.G6 = gateShell('skipped', ['holdout aggregate file was not supplied'], {
      relation: 'skipped',
    });
  }

  const lines = netLineChange(repo, options.base);
  const currentHard = hardScore(devSummary);
  const baselineHard = hardScore(baselineSummary);
  const hardDelta =
    typeof currentHard === 'number' && typeof baselineHard === 'number'
      ? currentHard - baselineHard
      : null;
  const overfit = evaluateOverfit({
    hardDelta,
    maxDropPerTask: band?.maxDropPerTask,
    holdoutRelation: gates.G6.relation,
    previousSignal: previousOverfitSignal(repo, options.round),
  });
  gates.G7 = gateShell(overfit.status, overfit.reasons, {
    alarm: overfit.alarm,
    overfitSignal: overfit.overfitSignal,
  });

  if (gates.G0.status === 'fail') {
    for (const name of ['G1', 'G2', 'G3', 'G4', 'G5']) {
      gates[name] = gateShell('not-run', ['not run because G0 failed']);
    }
    gates.G6 = gateShell('not-run', ['not run because G0 failed'], { relation: 'skipped' });
    gates.G7 = gateShell('not-applicable', ['not run because G0 failed'], {
      alarm: false,
      overfitSignal: false,
    });
    costDropPct = null;
  }

  const verdict = decide(gates, { costDropPct, netDeletion: lines.net < 0 });
  let sha;
  try {
    sha = headSha(repo);
  } catch {
    sha = null;
  }
  const report = {
    round: options.round,
    split,
    base: options.base,
    headSha: sha,
    fromResults: Boolean(options.fromResults),
    decision: verdict.decision,
    accepted: verdict.accepted,
    costDropPct,
    netLineChange: lines,
    gates,
  };
  const outDir = path.join(repo, '.rsi', 'runs', String(options.round));
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'gate.json');
  fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  return { exitCode: exitCodeFor(verdict.decision), report, outFile };
}

function isDirect() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirect()) {
  let args;
  try {
    if (process.env.MOSS_RSI_DISABLED === '1') {
      console.error('RSI refused: MOSS_RSI_DISABLED=1');
      process.exit(2);
    }
    args = parseArgs(process.argv.slice(2));
    if (fs.existsSync(path.join(args.repo, '.rsi', 'STOP'))) {
      console.error('RSI refused: .rsi/STOP exists');
      process.exit(2);
    }
    if (args.help) {
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
