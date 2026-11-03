#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runProcess } from '../dist/utils/run-process.js';

const here = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(here), '..');
const arms = ['baseline', 'superagent'];

// Thresholds are frozen before the first real request; low cost from failure is not a gain.
export function judgeBenefit(rounds) {
  if (rounds.length !== 3 || rounds.some((r) => !r.valid))
    return { verdict: 'incomplete', businessGain: false, requestEfficiencyGain: false };
  const totals = Object.fromEntries(
    arms.map((arm) => [
      arm,
      {
        acceptedCases: rounds.reduce((n, r) => n + r[arm].acceptedCases, 0),
        integrations: rounds.filter((r) => r[arm].integration).length,
        requests: rounds.reduce((n, r) => n + r[arm].requests, 0),
        usageMissing: rounds.reduce((n, r) => n + r[arm].usageMissing, 0),
        knownInputTokens: rounds.reduce((n, r) => n + r[arm].knownInputTokens, 0),
        knownOutputTokens: rounds.reduce((n, r) => n + r[arm].knownOutputTokens, 0),
      },
    ])
  );
  const wins = rounds.filter((r) => r.superagent.acceptedCases > r.baseline.acceptedCases).length;
  const businessGain = totals.superagent.acceptedCases > totals.baseline.acceptedCases && wins >= 2;
  const complete = arms.every(
    (arm) => totals[arm].acceptedCases === 9 && totals[arm].integrations === 3
  );
  const efficientPairs = rounds.filter(
    (r) => r.superagent.requests <= r.baseline.requests * 0.8
  ).length;
  const requestEfficiencyGain =
    complete &&
    totals.baseline.requests > 0 &&
    totals.superagent.requests <= totals.baseline.requests * 0.8 &&
    efficientPairs >= 2;
  return {
    verdict:
      businessGain || requestEfficiencyGain
        ? 'benefit observed on this task'
        : 'benefit not demonstrated',
    businessGain,
    requestEfficiencyGain,
    businessWinningPairs: wins,
    totals,
    completeTokenUsage: arms.every((arm) => totals[arm].usageMissing === 0),
    limitation:
      'Three repeats of one business family; no statistical or general capability claim. No human time saving measured.',
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args[args.indexOf(name) + 1];
  if (args.includes('--help')) {
    console.log(
      'Usage: node scripts/bench-superagent-benefit.mjs --env-file <private.env> [--output DIR]\nExactly 3 fresh paired rounds; each arm at most 30 requests, total at most 180.'
    );
    return;
  }
  if (!args.includes('--env-file') || !flag('--env-file'))
    throw new Error('Private --env-file required');
  const envFile = path.resolve(flag('--env-file'));
  const output = path.resolve(
    args.includes('--output')
      ? flag('--output')
      : path.join(repo, 'bench/results', `superagent-benefit-${Date.now()}`)
  );
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output, { mode: 0o700 }); // Refuse accidental replay into a previous ledger.
  const hashes = {};
  for (const file of [
    'scripts/bench-superagent-benefit.mjs',
    'scripts/bench-superagent.mjs',
    'scripts/lib/superagent-eval-oracle.mjs',
    'docs/specs/superagent-benefit-check.md',
    'bench/scenarios/superagent-operations/TASKS.md',
    'dist/cli/superagent-worker.js',
  ])
    hashes[file] = createHash('sha256')
      .update(await fs.readFile(path.join(repo, file)))
      .digest('hex');
  await fs.writeFile(
    path.join(output, 'protocol.json'),
    JSON.stringify(
      {
        hashes,
        maxRequests: 180,
        perArmPerPair: 30,
        order: ['baseline', 'superagent', 'baseline'],
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  const rows = [];
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let reserved = 0;
  let workerHash;
  let frozenHashes;
  try {
    for (const [index, first] of ['baseline', 'superagent', 'baseline'].entries()) {
      if (controller.signal.aborted) break;
      reserved += 60; // Reserve a full pair before launch; never refund or replace an interrupted pair.
      const roundDir = path.join(output, `pair-${index + 1}`);
      console.log(`[benefit] pair ${index + 1}/3, first=${first}, reserved=${reserved}/180`);
      const executed = await runProcess(process.execPath, {
        args: [
          path.join(repo, 'scripts/bench-superagent.mjs'),
          '--env-file',
          envFile,
          '--fair-coding',
          '--max-requests',
          '60',
          '--global-request-limit',
          '60',
          '--first-arm',
          first,
          '--output',
          roundDir,
        ],
        cwd: repo,
        timeout: 2100000,
        maxBuffer: 1000000,
        signal: controller.signal,
      }).catch((error) => error);
      await fs.writeFile(
        path.join(output, `pair-${index + 1}.log`),
        (executed.stdout ?? '') + (executed.stderr ?? ''),
        { mode: 0o600 }
      );
      const result = JSON.parse(await fs.readFile(path.join(roundDir, 'summary.json'), 'utf8'));
      const records = (await fs.readFile(path.join(roundDir, 'model-usage.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
      workerHash ??= result.nativeWorkerSha256;
      frozenHashes ??= JSON.stringify(result.frozenHashes);
      const valid =
        !result.error &&
        !result.interrupted &&
        !executed.timedOut &&
        result.fairCoding &&
        result.oracleUnchanged &&
        result.nativeWorkerSha256 === workerHash &&
        JSON.stringify(result.frozenHashes) === frozenHashes &&
        result.seedTrees.baseline === result.seedTrees.superagent &&
        result.credentialsAbsent &&
        records.every((r) => r.phase === 'coding' && arms.includes(r.arm)) &&
        records.length <= 60 &&
        arms.every(
          (arm) =>
            result.limits.groupLimits[`${arm}:coding`] === 30 &&
            records.filter((r) => r.arm === arm).length <= 30 &&
            result.arms[arm]?.results.length === 3 &&
            result.arms[arm].parentClean
        );
      const row = { pair: index + 1, first, valid, source: path.join(roundDir, 'summary.json') };
      for (const arm of arms)
        row[arm] = {
          acceptedCases: result.arms[arm]?.results.filter((r) => r.passed).length ?? 0,
          integration: result.arms[arm]?.integration.passed === true,
          wallMs: result.arms[arm]?.wallMs,
          operatorCodeRepairs: 0,
          ...result.arms[arm]?.usage,
        };
      rows.push(row);
      await fs.writeFile(
        path.join(output, 'comparison.json'),
        JSON.stringify(
          { reserved, maxRequests: 180, rounds: rows, judgement: judgeBenefit(rows) },
          null,
          2
        ),
        { mode: 0o600 }
      );
      console.log(JSON.stringify(row));
      if (!valid)
        throw new Error(
          'Invalid pair; preserve evidence and stop rather than spending on a replacement'
        );
    }
    const judgement = judgeBenefit(rows);
    for (const [file, expected] of Object.entries(hashes))
      if (
        createHash('sha256')
          .update(await fs.readFile(path.join(repo, file)))
          .digest('hex') !== expected
      )
        throw new Error('Frozen protocol changed during execution');
    console.log(JSON.stringify({ output, reserved, ...judgement }, null, 2));
    process.exitCode = judgement.verdict === 'incomplete' ? 1 : 0;
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === here) await main();
