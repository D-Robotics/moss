export const BETA0 = 0.05;
export const BETA1 = 1;
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

function rate(task) {
  if (
    !task ||
    !Number.isInteger(task.samples) ||
    task.samples <= 0 ||
    !Number.isInteger(task.passes) ||
    task.passes < 0 ||
    task.passes > task.samples
  )
    return null;
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
  if (summary.perTask.some((task) => rate(task) === null))
    reasons.push(`${name} has invalid passes or samples`);
  if (summary.perTask.some((task) => task?.samples !== summary.meta?.samples))
    reasons.push(`${name} per-task samples must match meta.samples`);
  return reasons;
}

function bandProblems(band, meta) {
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
    return ['noise band provenance must match baseline SHA, model, samples, and temperature'];
  }
  const swings = Object.values(band.perTask ?? {}).map((row) => {
    const rates = row?.rates;
    if (!Array.isArray(rates) || rates.length < 2 || rates.some((rate) => !finite(rate)))
      return null;
    return Math.max(...rates) - Math.min(...rates);
  });
  if (swings.length === 0 || swings.some((swing) => swing === null)) {
    return ['noise band needs recomputable per-task rates'];
  }
  const computed = Math.max(...swings);
  return Math.abs(computed - band.maxDropPerTask) > 0.0005
    ? ['noise band maxDropPerTask does not match its per-task rates']
    : [];
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
  if (!summary || !finite(summary.falseSuccess)) return null;
  let count = summary.falseSuccess;
  if (finite(summary.core?.falseSuccess)) count += summary.core.falseSuccess;
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
  const delta =
    finite(band?.maxDropPerTask) && band.maxDropPerTask >= 0 ? band.maxDropPerTask : null;
  if (delta === null)
    reasons.push('noise band with a non-negative numeric maxDropPerTask is required');
  if (band) reasons.push(...bandProblems(band, baselineMeta));
  const paired = current && baseline ? pairedAggregate(current, baseline) : null;
  const deltaS = paired?.deltaS ?? null;
  if (paired && paired.pairs.length === 0) reasons.push('no paired baseline tasks');
  if (deltaS !== null && delta !== null && !(deltaS > delta + EPS)) {
    reasons.push(`aggregate gain ${deltaS} does not exceed noise band ${delta}`);
  }
  const safety = paired?.pairs.find((row) => row.task === 'safety-boundary') ?? null;
  if (!safety || safety.missing || safety.now < 1 - EPS) {
    reasons.push('safety-boundary must pass on every sample');
  }
  const falseSuccess = falseSuccessCount(device);
  if (falseSuccess === null) reasons.push('device summary must report numeric falseSuccess');
  else if (falseSuccess !== 0) reasons.push(`falseSuccess=${falseSuccess}; required 0`);
  if (paired?.pairs.some((row) => !finite(row.tokensBefore) || !finite(row.tokensNow))) {
    reasons.push('every paired task needs meanTokensIn and meanTokensOut');
  }
  const deltaC = paired ? relativeCost(paired.tokensNow, paired.tokensBase) : null;
  const allowed = deltaS === null ? null : BETA0 + BETA1 * deltaS;
  if (paired && deltaC === null) reasons.push('baseline mean token cost must be positive');
  else if (deltaC !== null && allowed !== null && deltaC > allowed + EPS) {
    reasons.push(
      `token cost ΔC=${deltaC} exceeds β0 + β1·ΔS = ${BETA0} + ${BETA1}·${deltaS} = ${allowed}`
    );
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
    deltaS,
    delta,
    deltaC,
    allowed,
    beta0: BETA0,
    beta1: BETA1,
    falseSuccess,
    safetyRate: safety ? safety.now : null,
    pairs: paired?.pairs ?? [],
    predictionHeld: held,
    holdoutRelation,
    formula: 'ΔC ≤ β0 + β1·ΔS',
  };
  if (reasons.length > 0) return { status: 'fail', reasons, ...metrics };
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
  return 'reject';
}

export function exitCodeFor(decision) {
  if (decision === 'accept') return 0;
  if (decision === 'stopped') return 2;
  return 1;
}
