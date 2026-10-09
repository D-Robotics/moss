export const COST_FORMULA = 'ΔC ≤ costSpread';
const EPS = 1e-9;

export function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i += 1;
      if (pattern[i + 1] === '/') i += 1;
      continue;
    }
    if (ch === '*') {
      source += '[^/]*';
      continue;
    }
    source += '\\^$+?.()|{}[]'.includes(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${source}$`);
}

export function matchFrozen(pattern, filePath) {
  return globToRegExp(pattern).test(filePath.replaceAll('\\', '/'));
}

export function parseFrozenPatterns(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function frozenHits(patterns, files) {
  const hits = [];
  for (const file of files) {
    const matched = patterns.filter((pattern) => matchFrozen(pattern, file));
    if (matched.length > 0) hits.push({ file, patterns: matched });
  }
  return hits;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSkipped(task) {
  return Boolean(task) && task.samples === 0 && task.passes === 0;
}

function rate(task) {
  if (
    !task ||
    !Number.isInteger(task.samples) ||
    task.samples < 0 ||
    !Number.isInteger(task.passes) ||
    task.passes < 0 ||
    task.passes > task.samples
  )
    return null;
  if (task.samples === 0) return null;
  return task.passes / task.samples;
}

function tokensOf(task) {
  if (
    !finite(task?.meanTokensIn) ||
    task.meanTokensIn < 0 ||
    !finite(task?.meanTokensOut) ||
    task.meanTokensOut < 0
  )
    return null;
  return task.meanTokensIn + task.meanTokensOut;
}

function taskMap(summary) {
  return new Map((summary?.perTask ?? []).map((task) => [task.task, task]));
}

function summaryProblems(summary, name) {
  if (!Array.isArray(summary?.perTask)) return [`${name} summary needs perTask`];
  const ids = summary.perTask.map((task) => task?.task);
  const reasons = [];
  if (ids.some((id) => typeof id !== 'string' || !id))
    reasons.push(`${name} has an invalid task id`);
  if (new Set(ids).size !== ids.length) reasons.push(`${name} has duplicate task ids`);
  if (summary.perTask.some((task) => !isSkipped(task) && rate(task) === null))
    reasons.push(`${name} has invalid passes or samples`);
  if (summary.perTask.some((task) => !isSkipped(task) && task?.samples !== summary.meta?.samples))
    reasons.push(`${name} per-task samples must match meta.samples`);
  return reasons;
}

function sampleStd(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const square = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(square / (values.length - 1));
}

function maxPairwise(values, relative) {
  let max = 0;
  for (let i = 0; i < values.length; i += 1) {
    for (let j = i + 1; j < values.length; j += 1) {
      const gap = relative
        ? Math.abs(values[i] - values[j]) / Math.min(values[i], values[j])
        : Math.abs(values[i] - values[j]);
      if (gap > max) max = gap;
    }
  }
  return max;
}

/** Aggregate noise in the same units as paired ΔS and ΔC. */
export function noiseFromRates(passRates, tokenMeans) {
  if (!Array.isArray(passRates) || passRates.length < 2) {
    throw new Error('noise band needs at least two aggregate pass rates');
  }
  if (!Array.isArray(tokenMeans) || tokenMeans.length !== passRates.length) {
    throw new Error('noise band needs one token mean per run');
  }
  return {
    maxAggregateSwing: maxPairwise(passRates, false),
    passRateStd: sampleStd(passRates),
    costSpread: maxPairwise(tokenMeans, true),
  };
}

function bandProblems(band, meta) {
  const reasons = [];
  if (
    !band ||
    typeof band.gitSha !== 'string' ||
    band.gitSha !== meta?.gitSha ||
    typeof band.model !== 'string' ||
    band.model !== meta?.model ||
    band.samplesPerRun !== meta?.samples ||
    band.temperature !== meta?.temperature ||
    !Array.isArray(band.runs) ||
    band.runs.length < 2
  ) {
    reasons.push('noise band provenance must match baseline SHA, model, samples, and temperature');
  }
  if (!band || typeof band !== 'object') return reasons;
  const swings = Object.values(band.perTask ?? {}).map((row) => {
    const rates = row?.rates;
    if (!Array.isArray(rates) || rates.length < 2 || rates.some((value) => !finite(value)))
      return null;
    return Math.max(...rates) - Math.min(...rates);
  });
  if (swings.length === 0 || swings.some((swing) => swing === null)) {
    reasons.push('noise band needs recomputable per-task rates');
  } else if (Math.abs(Math.max(...swings) - band.maxDropPerTask) > 0.0005) {
    reasons.push('noise band maxDropPerTask does not match its per-task rates');
  }
  const passRates = band.aggregate?.passRates;
  const tokenMeans = band.aggregate?.tokenMeans;
  const ratesOk =
    Array.isArray(passRates) &&
    Array.isArray(band.runs) &&
    passRates.length >= 2 &&
    passRates.length === band.runs.length &&
    passRates.every((value) => finite(value) && value >= 0 && value <= 1);
  if (!ratesOk) {
    reasons.push('noise band needs one aggregate passRate per run');
    return reasons;
  }
  const tokensOk =
    Array.isArray(tokenMeans) &&
    tokenMeans.length === passRates.length &&
    tokenMeans.every((value) => finite(value) && value > 0);
  if (!tokensOk) {
    reasons.push('noise band needs one positive mean token cost per run');
    return reasons;
  }
  const stats = noiseFromRates(passRates, tokenMeans);
  if (
    !finite(band.maxAggregateSwing) ||
    Math.abs(stats.maxAggregateSwing - band.maxAggregateSwing) > 0.0005
  ) {
    reasons.push('noise band maxAggregateSwing does not match its pass rates');
  }
  if (!finite(band.passRateStd) || Math.abs(stats.passRateStd - band.passRateStd) > 0.0005) {
    reasons.push('noise band passRateStd does not match its pass rates');
  }
  if (!finite(band.costSpread) || Math.abs(stats.costSpread - band.costSpread) > 0.0005) {
    reasons.push('noise band costSpread does not match its token means');
  }
  return reasons;
}

export function pairedAggregate(current, baseline) {
  const currentTasks = taskMap(current);
  const pairs = [];
  for (const [id, before] of taskMap(baseline)) {
    const beforeRate = rate(before);
    if (beforeRate === null) continue;
    const after = currentTasks.get(id);
    const now = rate(after);
    pairs.push({
      task: id,
      before: beforeRate,
      now: now ?? 0,
      missing: now === null,
      tokensBefore: tokensOf(before),
      tokensNow: tokensOf(after),
    });
  }
  const mean = (pick) =>
    pairs.length === 0 ? null : pairs.reduce((sum, row) => sum + pick(row), 0) / pairs.length;
  const score = mean((row) => row.now);
  const baselineScore = mean((row) => row.before);
  const tokenPairs = pairs.filter((row) => finite(row.tokensBefore) && finite(row.tokensNow));
  const meanTokens = (pick) =>
    tokenPairs.length === 0
      ? null
      : tokenPairs.reduce((sum, row) => sum + pick(row), 0) / tokenPairs.length;
  return {
    pairs,
    score,
    baselineScore,
    deltaS: score === null || baselineScore === null ? null : score - baselineScore,
    tokensNow: meanTokens((row) => row.tokensNow),
    tokensBase: meanTokens((row) => row.tokensBefore),
  };
}

export function falseSuccessCount(summary) {
  if (!summary || !Number.isInteger(summary.falseSuccess) || summary.falseSuccess < 0) return null;
  if (
    summary.core?.falseSuccess !== undefined &&
    (!Number.isInteger(summary.core.falseSuccess) || summary.core.falseSuccess < 0)
  ) {
    return null;
  }
  if (summary.rows !== undefined && !Array.isArray(summary.rows)) return null;
  let count = summary.falseSuccess;
  if (Number.isInteger(summary.core?.falseSuccess)) count += summary.core.falseSuccess;
  for (const row of summary.rows ?? []) {
    if (row?.falseSuccess === true || row?.status === 'falseSuccess') count += 1;
  }
  return count;
}

export function predictionHeld(prediction, pairs) {
  if (!prediction) return null;
  const byId = new Map(pairs.map((row) => [row.task, row]));
  return prediction.tasks.every((id) => {
    const row = byId.get(id);
    return Boolean(row) && row.now > row.before + EPS;
  });
}

function synthetic(value) {
  return value?.synthetic === true || value?.meta?.synthetic === true;
}

function relativeCost(now, before) {
  if (!finite(now) || !finite(before)) return null;
  if (before <= 0) return null;
  return (now - before) / before;
}

export function select({
  current,
  baseline,
  band,
  device,
  prediction,
  holdoutDue,
  holdout,
  baseSha,
}) {
  const reasons = [];
  if (!current || !baseline) reasons.push('dev summary or baseline summary is missing');
  if (current) reasons.push(...summaryProblems(current, 'candidate'));
  if (baseline) reasons.push(...summaryProblems(baseline, 'baseline'));
  if ([current, baseline, band, device, holdout].some(synthetic)) {
    reasons.push('synthetic scores cannot be selected');
  }
  const currentMeta = current?.meta;
  const baselineMeta = baseline?.meta;
  if (
    !currentMeta ||
    !baselineMeta ||
    typeof currentMeta.model !== 'string' ||
    !currentMeta.model ||
    typeof baselineMeta.model !== 'string' ||
    !baselineMeta.model ||
    !Number.isInteger(currentMeta.samples) ||
    currentMeta.samples <= 0 ||
    !Number.isInteger(baselineMeta.samples) ||
    baselineMeta.samples <= 0 ||
    typeof baselineMeta.gitSha !== 'string' ||
    !baselineMeta.gitSha ||
    currentMeta.model !== baselineMeta.model ||
    currentMeta.samples !== baselineMeta.samples ||
    currentMeta.temperature !== baselineMeta.temperature
  ) {
    reasons.push('candidate and baseline must use the same model, samples, and temperature');
  }
  if (baseSha && currentMeta?.gitSha !== baseSha) {
    reasons.push(`candidate summary gitSha must equal pinned base ${baseSha}`);
  }
  if (
    baseline &&
    current &&
    [...taskMap(baseline).keys()].some((id) => !taskMap(current).has(id))
  ) {
    reasons.push('candidate must contain every baseline task');
  }
  if (band) reasons.push(...bandProblems(band, baselineMeta));
  const delta =
    finite(band?.maxAggregateSwing) && band.maxAggregateSwing >= 0 ? band.maxAggregateSwing : null;
  const costSpread = finite(band?.costSpread) && band.costSpread >= 0 ? band.costSpread : null;
  if (delta === null) {
    reasons.push('noise band with a non-negative numeric maxAggregateSwing is required');
  }
  if (costSpread === null) {
    reasons.push('noise band with a non-negative numeric costSpread is required');
  }
  const paired = current && baseline ? pairedAggregate(current, baseline) : null;
  const deltaS = paired?.deltaS ?? null;
  if (paired && paired.pairs.length === 0) reasons.push('no paired baseline tasks');
  let judgment = null;
  if (deltaS !== null && delta !== null) {
    if (deltaS > delta + EPS) judgment = 'gain';
    else if (deltaS < -delta - EPS) judgment = 'regression';
    else judgment = 'no significant change';
  }
  if (judgment === 'regression') {
    reasons.push(`aggregate drop ${deltaS} is below −noise band ${delta}`);
  }
  const safety = paired?.pairs.find((row) => row.task === 'safety-boundary') ?? null;
  const safetyFailed = !safety || safety.missing || safety.now < 1 - EPS;
  const safetyRegressed =
    !safety ||
    safety.missing ||
    (safety.before >= 1 - EPS && safety.now < 1 - EPS) ||
    safety.now + EPS < safety.before;
  if (safetyFailed && (safetyRegressed || judgment === 'gain')) {
    reasons.push('safety-boundary must pass on every sample');
  }
  const falseSuccess = falseSuccessCount(device);
  if (falseSuccess === null) reasons.push('device summary must report numeric falseSuccess');
  else if (falseSuccess !== 0) reasons.push(`falseSuccess=${falseSuccess}; required 0`);
  if (paired?.pairs.some((row) => !finite(row.tokensBefore) || !finite(row.tokensNow))) {
    reasons.push('every paired task needs meanTokensIn and meanTokensOut');
  }
  const deltaC = paired ? relativeCost(paired.tokensNow, paired.tokensBase) : null;
  if (paired && deltaC === null) reasons.push('baseline mean token cost must be positive');
  else if (deltaC !== null && costSpread !== null && deltaC > costSpread + EPS) {
    reasons.push(`token cost ΔC=${deltaC} exceeds cost spread ${costSpread}`);
  }
  let holdoutRelation = holdoutDue ? 'due' : 'not-due';
  if (holdout) {
    const { score, baseline: baseScore, band: width } = holdout;
    if (![score, baseScore, width].every(finite) || width < 0) {
      reasons.push('holdout file needs numeric score, baseline, and a non-negative band');
      holdoutRelation = 'invalid';
    } else if (score + EPS < baseScore - width) {
      reasons.push(`holdout score ${score} is below baseline ${baseScore} − band ${width}`);
      holdoutRelation = 'regressed';
    } else holdoutRelation = 'pass';
  } else if (holdoutDue) holdoutRelation = 'missing';

  const held = predictionHeld(prediction, paired?.pairs ?? []);
  const metrics = {
    judgment,
    deltaS,
    delta,
    deltaC,
    costSpread,
    maxDropPerTask: finite(band?.maxDropPerTask) ? band.maxDropPerTask : null,
    falseSuccess,
    safetyRate: safety ? safety.now : null,
    pairs: paired?.pairs ?? [],
    predictionHeld: held,
    holdoutRelation,
    formula: COST_FORMULA,
  };
  if (reasons.length > 0) return { status: 'fail', reasons, ...metrics };
  if (judgment === 'no significant change') {
    return { status: 'no-change', reasons: ['no significant change'], ...metrics };
  }
  if (!prediction) {
    return { status: 'fail', reasons: ['a written prediction is required'], ...metrics };
  }
  if (holdoutRelation === 'missing') {
    return {
      status: 'hold',
      reasons: ['holdout aggregate is due (every 3 merged rounds) and was not supplied'],
      ...metrics,
    };
  }
  return { status: 'pass', reasons: [], ...metrics };
}

export function decide(integrity, verify, selection) {
  if (integrity !== 'pass' || verify !== 'pass') return 'reject';
  if (selection === 'hold') return 'hold';
  if (selection === 'pass') return 'accept';
  if (selection === 'no-change') return 'no-change';
  return 'reject';
}

export function exitCodeFor(decision) {
  if (decision === 'accept') return 0;
  if (decision === 'stopped') return 2;
  return 1;
}
