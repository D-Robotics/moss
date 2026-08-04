import type { SkillComposerPlanProvider } from '../skills/composer-types.js';

export type SkillCompositionSegment =
  | 'provider'
  | 'language'
  | 'deploymentMode'
  | 'skillSource'
  | 'taskClass'
  | 'environment';

export interface SkillCompositionEvalSample {
  id: string;
  provider: SkillComposerPlanProvider;
  expectedSkillIds: string[];
  composedSkillIds: string[];
  candidateSkillIds: string[];
  /** Explicit load_skill calls are reported, but never counted as composer hits. */
  explicitLoadSkillIds?: string[];
  dependencyViolations?: number;
  latencyMs?: number;
  fallback?: boolean;
  injectedChars?: number;
  downstreamPassed?: boolean;
  language?: string;
  deploymentMode?: string;
  skillSource?: string;
  taskClass?: 'single' | 'multi' | 'none';
  environment?: 'host' | 'board' | 'host-controls-board';
}

export interface SkillCompositionMetrics {
  sampleCount: number;
  setF1: number;
  setExactMatch: number;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
  cardinalityError: number;
  dependencyViolationRate: number;
  rejectionAccuracy: number;
  averageLatencyMs: number;
  fallbackRate: number;
  injectedTokenEstimate: number;
  downstreamPassRate: number;
  manualLoadCount: number;
}

export interface SkillCompositionEvalReport {
  overall: SkillCompositionMetrics;
  segments: Partial<Record<SkillCompositionSegment, Record<string, SkillCompositionMetrics>>>;
}

export interface SkillCompositionPromotionGates {
  minimumSetF1?: number;
  minimumRejectionAccuracy?: number;
  minimumDownstreamPassRate?: number;
  maximumAverageLatencyMs?: number;
  maximumDependencyViolationRate?: number;
}

export interface SkillCompositionPromotionReview {
  eligibleForReview: boolean;
  requiresExplicitApproval: true;
  failures: string[];
}

export interface SkillCompositionShadowComparison {
  active: SkillCompositionMetrics;
  shadow: SkillCompositionMetrics;
  /** Positive means the shadow value is higher than the active value. */
  delta: Omit<SkillCompositionMetrics, 'sampleCount'>;
}

export interface SkillCompositionCollectedToolCall {
  id?: string;
  name: string;
  input?: Record<string, unknown>;
}

export interface SkillCompositionEvalRun {
  /** Parsed stream-json records emitted by Moss. */
  events?: unknown[];
  /** Collector-normalized calls, when the harness already extracted them. */
  toolCalls?: SkillCompositionCollectedToolCall[];
  downstreamPassed?: boolean;
}

export interface SkillCompositionEvalExpectation {
  id: string;
  expectedSkillIds?: string[];
  /** Existing moss-eval task definitions use skill names rather than stable IDs. */
  expectedSkillNames?: string[];
  language?: string;
  deploymentMode?: string;
  skillSource?: string;
  taskClass?: 'single' | 'multi' | 'none';
  environment?: 'host' | 'board' | 'host-controls-board';
  dependencyViolations?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function collectToolCallsFromEvents(events: unknown[]): SkillCompositionCollectedToolCall[] {
  const calls: SkillCompositionCollectedToolCall[] = [];
  for (const eventValue of events) {
    const event = asRecord(eventValue);
    if (event?.type !== 'assistant') continue;
    const message = asRecord(event.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const blockValue of content) {
      const block = asRecord(blockValue);
      if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
      calls.push({
        ...(typeof block.id === 'string' ? { id: block.id } : {}),
        name: block.name,
        ...(asRecord(block.input) ? { input: asRecord(block.input) } : {}),
      });
    }
  }
  return calls;
}

/**
 * Convert an actual Moss run into a composition sample. The active injected
 * plan is the primary signal; explicit load_skill calls are deliberately kept
 * separate so they cannot turn a missed automatic composition into a hit.
 */
export function collectSkillCompositionEvalSample(
  run: SkillCompositionEvalRun,
  expectation: SkillCompositionEvalExpectation,
): SkillCompositionEvalSample {
  const events = run.events ?? [];
  const activeEvent = [...events].reverse().find((value) => {
    const event = asRecord(value);
    return event?.type === 'skill_composition' && event.subtype === 'active';
  });
  const active = asRecord(activeEvent);
  const trace = asRecord(active?.trace);
  if (!trace) {
    throw new Error(`No active skill_composition event found for eval case "${expectation.id}"`);
  }
  if (!expectation.expectedSkillIds && !expectation.expectedSkillNames) {
    throw new Error(`Eval case "${expectation.id}" must declare expected skill IDs or names`);
  }
  const useNames = expectation.expectedSkillNames !== undefined;
  const candidateScores = Array.isArray(trace.candidateScores) ? trace.candidateScores : [];
  const toolCalls = run.toolCalls ?? collectToolCallsFromEvents(events);
  const explicitLoadSkillIds = toolCalls
    .filter((call) => call.name === 'load_skill')
    .map((call) => call.input?.name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  const provider = typeof trace.provider === 'string'
    ? trace.provider as SkillComposerPlanProvider
    : 'fallback';
  return {
    id: expectation.id,
    provider,
    expectedSkillIds: [...(expectation.expectedSkillNames ?? expectation.expectedSkillIds ?? [])],
    composedSkillIds: stringArray(useNames ? trace.finalNames : trace.finalOrder),
    candidateSkillIds: candidateScores
      .map((candidate) => asRecord(candidate)?.[useNames ? 'name' : 'stableId'])
      .filter((stableId): stableId is string => typeof stableId === 'string'),
    explicitLoadSkillIds,
    dependencyViolations: expectation.dependencyViolations ?? 0,
    latencyMs: typeof trace.latencyMs === 'number' ? trace.latencyMs : 0,
    fallback: provider === 'fallback' || typeof trace.fallbackReason === 'string',
    injectedChars: typeof trace.injectedChars === 'number' ? trace.injectedChars : 0,
    downstreamPassed: run.downstreamPassed,
    ...(expectation.language ? { language: expectation.language } : {}),
    ...(expectation.deploymentMode ? { deploymentMode: expectation.deploymentMode } : {}),
    ...(expectation.skillSource ? { skillSource: expectation.skillSource } : {}),
    ...(expectation.taskClass ? { taskClass: expectation.taskClass } : {}),
    ...(expectation.environment ? { environment: expectation.environment } : {}),
  };
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unique(values: string[]): Set<string> {
  return new Set(values);
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) if (right.has(value)) count++;
  return count;
}

function sampleSetF1(sample: SkillCompositionEvalSample): number {
  const expected = unique(sample.expectedSkillIds);
  const actual = unique(sample.composedSkillIds);
  if (expected.size === 0 && actual.size === 0) return 1;
  const hits = intersectionSize(expected, actual);
  return hits === 0 ? 0 : (2 * hits) / (expected.size + actual.size);
}

function sampleNdcgAt5(sample: SkillCompositionEvalSample): number {
  const expected = unique(sample.expectedSkillIds);
  if (expected.size === 0) return sample.candidateSkillIds.length === 0 ? 1 : 0;
  const ranked = sample.candidateSkillIds.slice(0, 5);
  const dcg = ranked.reduce(
    (sum, skillId, index) => sum + (expected.has(skillId) ? 1 / Math.log2(index + 2) : 0),
    0,
  );
  const idealCount = Math.min(5, expected.size);
  let ideal = 0;
  for (let index = 0; index < idealCount; index++) ideal += 1 / Math.log2(index + 2);
  return ideal === 0 ? 0 : dcg / ideal;
}

export function scoreSkillCompositionSamples(
  samples: SkillCompositionEvalSample[],
): SkillCompositionMetrics {
  if (samples.length === 0) {
    return {
      sampleCount: 0,
      setF1: 0,
      setExactMatch: 0,
      recallAt5: 0,
      mrr: 0,
      ndcgAt5: 0,
      cardinalityError: 0,
      dependencyViolationRate: 0,
      rejectionAccuracy: 0,
      averageLatencyMs: 0,
      fallbackRate: 0,
      injectedTokenEstimate: 0,
      downstreamPassRate: 0,
      manualLoadCount: 0,
    };
  }
  const setExact = samples.map((sample) => {
    const expected = unique(sample.expectedSkillIds);
    const actual = unique(sample.composedSkillIds);
    return expected.size === actual.size && intersectionSize(expected, actual) === expected.size ? 1 : 0;
  });
  const recallAt5 = samples.map((sample) => {
    const expected = unique(sample.expectedSkillIds);
    if (expected.size === 0) return sample.candidateSkillIds.length === 0 ? 1 : 0;
    return intersectionSize(expected, unique(sample.candidateSkillIds.slice(0, 5))) / expected.size;
  });
  const reciprocalRanks = samples.map((sample) => {
    const expected = unique(sample.expectedSkillIds);
    if (expected.size === 0) return sample.candidateSkillIds.length === 0 ? 1 : 0;
    const index = sample.candidateSkillIds.findIndex((skillId) => expected.has(skillId));
    return index < 0 ? 0 : 1 / (index + 1);
  });
  const downstream = samples.filter((sample) => sample.downstreamPassed !== undefined);
  return {
    sampleCount: samples.length,
    setF1: average(samples.map(sampleSetF1)),
    setExactMatch: average(setExact),
    recallAt5: average(recallAt5),
    mrr: average(reciprocalRanks),
    ndcgAt5: average(samples.map(sampleNdcgAt5)),
    cardinalityError: average(samples.map((sample) =>
      Math.abs(unique(sample.composedSkillIds).size - unique(sample.expectedSkillIds).size))),
    dependencyViolationRate: average(samples.map((sample) =>
      (sample.dependencyViolations ?? 0) / Math.max(1, unique(sample.composedSkillIds).size))),
    rejectionAccuracy: average(samples.map((sample) =>
      (sample.expectedSkillIds.length === 0) === (sample.composedSkillIds.length === 0) ? 1 : 0)),
    averageLatencyMs: average(samples.map((sample) => sample.latencyMs ?? 0)),
    fallbackRate: average(samples.map((sample) => sample.fallback ? 1 : 0)),
    injectedTokenEstimate: samples.reduce(
      (sum, sample) => sum + Math.ceil((sample.injectedChars ?? 0) / 4),
      0,
    ),
    downstreamPassRate: downstream.length === 0
      ? 0
      : average(downstream.map((sample) => sample.downstreamPassed ? 1 : 0)),
    manualLoadCount: samples.reduce(
      (sum, sample) => sum + (sample.explicitLoadSkillIds?.length ?? 0),
      0,
    ),
  };
}

export function buildSkillCompositionEvalReport(
  samples: SkillCompositionEvalSample[],
  segmentBy: SkillCompositionSegment[] = [],
): SkillCompositionEvalReport {
  const segments: SkillCompositionEvalReport['segments'] = {};
  for (const field of segmentBy) {
    const groups = new Map<string, SkillCompositionEvalSample[]>();
    for (const sample of samples) {
      const value = sample[field] ?? 'unknown';
      const group = groups.get(String(value)) ?? [];
      group.push(sample);
      groups.set(String(value), group);
    }
    segments[field] = Object.fromEntries(
      [...groups.entries()].map(([value, group]) => [value, scoreSkillCompositionSamples(group)]),
    );
  }
  return { overall: scoreSkillCompositionSamples(samples), segments };
}

export function buildSkillCompositionShadowComparison(
  activeSamples: SkillCompositionEvalSample[],
  shadowSamples: SkillCompositionEvalSample[],
): SkillCompositionShadowComparison {
  const activeIds = new Set(activeSamples.map((sample) => sample.id));
  const shadowIds = new Set(shadowSamples.map((sample) => sample.id));
  if (
    activeIds.size !== shadowIds.size ||
    [...activeIds].some((sampleId) => !shadowIds.has(sampleId))
  ) {
    throw new Error('active and shadow samples must contain the same case IDs');
  }
  const active = scoreSkillCompositionSamples(activeSamples);
  const shadow = scoreSkillCompositionSamples(shadowSamples);
  return {
    active,
    shadow,
    delta: {
      setF1: shadow.setF1 - active.setF1,
      setExactMatch: shadow.setExactMatch - active.setExactMatch,
      recallAt5: shadow.recallAt5 - active.recallAt5,
      mrr: shadow.mrr - active.mrr,
      ndcgAt5: shadow.ndcgAt5 - active.ndcgAt5,
      cardinalityError: shadow.cardinalityError - active.cardinalityError,
      dependencyViolationRate:
        shadow.dependencyViolationRate - active.dependencyViolationRate,
      rejectionAccuracy: shadow.rejectionAccuracy - active.rejectionAccuracy,
      averageLatencyMs: shadow.averageLatencyMs - active.averageLatencyMs,
      fallbackRate: shadow.fallbackRate - active.fallbackRate,
      injectedTokenEstimate:
        shadow.injectedTokenEstimate - active.injectedTokenEstimate,
      downstreamPassRate: shadow.downstreamPassRate - active.downstreamPassRate,
      manualLoadCount: shadow.manualLoadCount - active.manualLoadCount,
    },
  };
}

/** Gate checks only make a candidate eligible for human review; they never activate it. */
export function evaluateSkillCompositionPromotion(
  metrics: SkillCompositionMetrics,
  gates: SkillCompositionPromotionGates,
): SkillCompositionPromotionReview {
  const failures: string[] = [];
  if (gates.minimumSetF1 !== undefined && metrics.setF1 < gates.minimumSetF1) {
    failures.push(`setF1 ${metrics.setF1.toFixed(3)} < ${gates.minimumSetF1.toFixed(3)}`);
  }
  if (
    gates.minimumRejectionAccuracy !== undefined &&
    metrics.rejectionAccuracy < gates.minimumRejectionAccuracy
  ) {
    failures.push(
      `rejectionAccuracy ${metrics.rejectionAccuracy.toFixed(3)} < ${gates.minimumRejectionAccuracy.toFixed(3)}`,
    );
  }
  if (
    gates.minimumDownstreamPassRate !== undefined &&
    metrics.downstreamPassRate < gates.minimumDownstreamPassRate
  ) {
    failures.push(
      `downstreamPassRate ${metrics.downstreamPassRate.toFixed(3)} < ${gates.minimumDownstreamPassRate.toFixed(3)}`,
    );
  }
  if (
    gates.maximumAverageLatencyMs !== undefined &&
    metrics.averageLatencyMs > gates.maximumAverageLatencyMs
  ) {
    failures.push(
      `averageLatencyMs ${metrics.averageLatencyMs.toFixed(1)} > ${gates.maximumAverageLatencyMs.toFixed(1)}`,
    );
  }
  if (
    gates.maximumDependencyViolationRate !== undefined &&
    metrics.dependencyViolationRate > gates.maximumDependencyViolationRate
  ) {
    failures.push(
      `dependencyViolationRate ${metrics.dependencyViolationRate.toFixed(3)} > ${gates.maximumDependencyViolationRate.toFixed(3)}`,
    );
  }
  return { eligibleForReview: failures.length === 0, requiresExplicitApproval: true, failures };
}
