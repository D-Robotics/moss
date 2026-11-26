#!/usr/bin/env node
// Pair two bench result directories by (task, sample) and print the comparison.
//
//   node scripts/compare-bench-results.mjs bench/results/<control> bench/results/<head>
//
// A result directory is what `npm run bench -- --label <name>` writes. Rows are paired by
// task and sample, and only pairs where both rows pass feed the metric table. Every random
// draw goes through one seeded generator, so two runs of this script print the same numbers.
import fs from 'node:fs';
import path from 'node:path';

const [controlDir, headDir] = process.argv.slice(2);
if (!controlDir || !headDir) {
  console.error('usage: node scripts/compare-bench-results.mjs <controlDir> <headDir>');
  process.exit(2);
}

const load = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
const control = load(controlDir);
const head = load(headDir);

const key = (row) => `${row.task}#${row.sample}`;

// A repeated key would pair one control row with several head rows and skew every total,
// so refuse instead. One-sample runs merged by hand hit this when every row keeps sample 1.
function indexRows(rows, label) {
  const map = new Map();
  for (const row of rows) {
    const id = key(row);
    if (map.has(id)) {
      console.error(`${label}: duplicate (task, sample) key ${id}; rows cannot be paired`);
      process.exit(2);
    }
    map.set(id, row);
  }
  return map;
}
indexRows(head.rows, 'head');
const controlRows = indexRows(control.rows, 'control');
const pairs = head.rows
  .map((h) => ({ task: h.task, sample: h.sample, c: controlRows.get(key(h)), h }))
  .filter((pair) => pair.c);

const METRICS = [
  ['numTurns', 'turns'],
  ['toolCalls', 'tool calls'],
  ['tokensIn', 'input tokens'],
  ['cacheRead', 'cache read'],
  ['tokensOut', 'output tokens'],
  ['wallMs', 'wall seconds'],
];
const isMillis = (field) => field === 'wallMs' || field === 'durationMs';
const fmt = (field, value) => (isMillis(field) ? (value / 1000).toFixed(1) : String(value));

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : Number.NaN);
const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rankWithTies(values) {
  const order = values.map((value, index) => [value, index]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = rank;
    i = j + 1;
  }
  return ranks;
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}
const normalCdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

// Two-sided Wilcoxon signed-rank test on paired differences, normal approximation with a
// tie correction. Looks at the direction of most pairs.
function wilcoxon(differences) {
  const d = differences.filter((x) => x !== 0);
  const n = d.length;
  if (n === 0) return { n: 0, p: 1 };
  const ranks = rankWithTies(d.map(Math.abs));
  const wPlus = sum(d.map((x, i) => (x > 0 ? ranks[i] : 0)));
  const absCounts = new Map();
  for (const x of d.map(Math.abs)) absCounts.set(x, (absCounts.get(x) ?? 0) + 1);
  let tieTerm = 0;
  for (const count of absCounts.values()) tieTerm += count ** 3 - count;
  const mu = (n * (n + 1)) / 4;
  const sigma = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48);
  return { n, p: 2 * (1 - normalCdf(Math.abs((wPlus - mu) / sigma))) };
}

// Two-sided sign-flip permutation test on the mean paired difference. Looks at the mean, so a
// few large samples can keep it from reaching significance.
function signFlip(differences, draws, rand) {
  const observed = Math.abs(mean(differences));
  let hits = 0;
  for (let k = 0; k < draws; k++) {
    let total = 0;
    for (const d of differences) total += rand() < 0.5 ? d : -d;
    if (Math.abs(total / differences.length) >= observed) hits++;
  }
  return (hits + 1) / (draws + 1);
}

// Percentile bootstrap of the ratio of means (head / control) over pairs.
function ratioInterval(controlValues, headValues, draws, rand) {
  const n = controlValues.length;
  const ratios = [];
  for (let k = 0; k < draws; k++) {
    let c = 0;
    let h = 0;
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rand() * n);
      c += controlValues[j];
      h += headValues[j];
    }
    ratios.push(h / c);
  }
  ratios.sort((a, b) => a - b);
  return [ratios[Math.floor(0.025 * draws)], ratios[Math.floor(0.975 * draws) - 1]];
}

function binomialCdf(k, n, p) {
  let cdf = 0;
  for (let i = 0; i <= k; i++) {
    let choose = 1;
    for (let t = 0; t < i; t++) choose = (choose * (n - t)) / (t + 1);
    cdf += choose * p ** i * (1 - p) ** (n - i);
  }
  return cdf;
}

const rand = mulberry32(20261126);
const passControl = pairs.filter((pair) => pair.c.pass).length;
const passHead = pairs.filter((pair) => pair.h.pass).length;
const onlyControl = pairs.filter((pair) => pair.c.pass && !pair.h.pass).map((pair) => key(pair.c));
const onlyHead = pairs.filter((pair) => !pair.c.pass && pair.h.pass).map((pair) => key(pair.h));
const discordant = onlyControl.length + onlyHead.length;
const passP =
  discordant === 0
    ? 1
    : Math.min(
        binomialCdf(onlyHead.length, discordant, 0.5),
        binomialCdf(onlyControl.length, discordant, 0.5)
      );

console.log(`control ${controlDir} (${control.rows.length} rows)`);
console.log(`head    ${headDir} (${head.rows.length} rows)`);
console.log(`paired  ${pairs.length}`);
console.log(`pass    control ${passControl}/${pairs.length}  head ${passHead}/${pairs.length}`);
console.log(`only control passes: ${onlyControl.join(', ') || 'none'}`);
console.log(`only head passes:    ${onlyHead.join(', ') || 'none'}`);
console.log(`pass, two-sided exact over discordant pairs: p=${passP.toFixed(4)}`);

const both = pairs.filter((pair) => pair.c.pass && pair.h.pass);
console.log(`\nboth pass: ${both.length} pairs`);
console.log(
  'metric | control | head | head/control | ratio 95% interval | wilcoxon p | sign-flip p | fewer/equal/more'
);
for (const [field, label] of METRICS) {
  const c = both.map((pair) => pair.c[field]);
  const h = both.map((pair) => pair.h[field]);
  const differences = h.map((value, i) => value - c[i]);
  const [low, high] = ratioInterval(c, h, 20000, rand);
  let fewer = 0;
  let equal = 0;
  let more = 0;
  for (const d of differences) {
    if (d < 0) fewer++;
    else if (d > 0) more++;
    else equal++;
  }
  const w = wilcoxon(differences);
  console.log(
    `${label} | ${fmt(field, sum(c))} | ${fmt(field, sum(h))} | ${(sum(h) / sum(c)).toFixed(4)} | ` +
      `[${low.toFixed(3)}, ${high.toFixed(3)}] | ${w.p.toFixed(4)} (n=${w.n}) | ${signFlip(differences, 50000, rand).toFixed(4)} | ` +
      `${fewer}/${equal}/${more}`
  );
}

const perTurn = (label, set) => {
  const turns = [sum(set.map((pair) => pair.c.numTurns)), sum(set.map((pair) => pair.h.numTurns))];
  const wall = [sum(set.map((pair) => pair.c.wallMs)), sum(set.map((pair) => pair.h.wallMs))];
  const out = [sum(set.map((pair) => pair.c.tokensOut)), sum(set.map((pair) => pair.h.tokensOut))];
  console.log(
    `${label} (${set.length} pairs): wall per turn ${(wall[0] / turns[0] / 1000).toFixed(2)} -> ` +
      `${(wall[1] / turns[1] / 1000).toFixed(2)} s, output per turn ${(out[0] / turns[0]).toFixed(0)} -> ` +
      `${(out[1] / turns[1]).toFixed(0)} tokens`
  );
};
perTurn('all', both);
const largest = both.reduce((a, pair) => (pair.h.wallMs > a.h.wallMs ? pair : a), both[0]);
if (both.length > 1) {
  perTurn(
    `without ${key(largest.h)}`,
    both.filter((pair) => pair !== largest)
  );
}
const perSampleRatio = both.map(
  (pair) => pair.h.wallMs / pair.h.numTurns / (pair.c.wallMs / pair.c.numTurns)
);
console.log(
  `median per-sample ratio of wall per turn (head/control): ${median(perSampleRatio).toFixed(3)}`
);

console.log(
  '\nper task: pass | turns | input | output | tool calls | wall seconds  (control -> head, means over samples)'
);
for (const task of [...new Set(pairs.map((pair) => pair.task))].sort()) {
  const set = pairs.filter((pair) => pair.task === task);
  const passC = set.filter((pair) => pair.c.pass).length;
  const passH = set.filter((pair) => pair.h.pass).length;
  const text = (field, value) => {
    if (isMillis(field)) return (value / 1000).toFixed(1);
    if (field === 'numTurns' || field === 'toolCalls') return value.toFixed(1);
    return String(Math.round(value));
  };
  const col = (field) =>
    `${text(field, mean(set.map((pair) => pair.c[field])))} -> ${text(field, mean(set.map((pair) => pair.h[field])))}`;
  console.log(
    `${task} | ${passC}/${set.length} -> ${passH}/${set.length} | ${col('numTurns')} | ${col('tokensIn')} | ` +
      `${col('tokensOut')} | ${col('toolCalls')} | ${col('wallMs')}`
  );
}

const timedOut = (side) =>
  pairs.filter((pair) => pair[side].timedOut).map((pair) => key(pair[side]));
console.log(
  `\ntimed out: control [${timedOut('c').join(', ')}]  head [${timedOut('h').join(', ')}]`
);
console.log(`control harness flakes: ${JSON.stringify(control.harnessFlakes)}`);
console.log(`head harness flakes: ${JSON.stringify(head.harnessFlakes)}`);
