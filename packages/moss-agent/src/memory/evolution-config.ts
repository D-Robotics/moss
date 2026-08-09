import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PATCH_EXPERIMENT_THRESHOLDS,
  type PatchExperimentThresholds,
} from './trusted-skill-experiment-coordinator.js';
import type { PatchExperimentHypothesis } from './patch-experiment-log.js';
import type { PatchExperimentCostMetric } from './patch-experiment-log.js';

export interface EvolutionConfigResult {
  path: string;
  source: 'default' | 'workspace';
  thresholds: PatchExperimentThresholds;
  hypothesis: PatchExperimentHypothesis;
  costMetrics: PatchExperimentCostMetric[];
  diagnostics: string[];
}

const BOUNDS: Record<keyof PatchExperimentThresholds, readonly [number, number]> = {
  minSamplesPerArm: [2, 10_000],
  wilsonZ: [1, 4],
  maxCostRatio: [1, 10],
  maxRetryIncrease: [0, 10],
  successNoninferiorityMargin: [0, 0.5],
  minCostImprovementRatio: [0, 1],
  minCostMetricsImproved: [1, 4],
};

export async function loadEvolutionConfig(workspaceDir: string): Promise<EvolutionConfigResult> {
  const configPath = path.join(workspaceDir, '.moss', 'evolution.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        path: configPath,
        source: 'default',
        thresholds: { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS },
        hypothesis: 'success_superiority',
        costMetrics: ['retries', 'toolCalls', 'durationMs', 'tokens'],
        diagnostics: [],
      };
    }
    return {
      path: configPath,
      source: 'default',
      thresholds: { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS },
      hypothesis: 'success_superiority',
      costMetrics: ['retries', 'toolCalls', 'durationMs', 'tokens'],
      diagnostics: [`invalid_json:${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      path: configPath,
      source: 'workspace',
      thresholds: { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS },
      hypothesis: 'success_superiority',
      costMetrics: ['retries', 'toolCalls', 'durationMs', 'tokens'],
      diagnostics: ['config_must_be_object'],
    };
  }
  const root = parsed as Record<string, unknown>;
  const raw =
    root.experiment && typeof root.experiment === 'object' && !Array.isArray(root.experiment)
      ? (root.experiment as Record<string, unknown>)
      : root;
  const diagnostics: string[] = [];
  const thresholds = { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS };
  for (const key of Object.keys(raw)) {
    if (!(key in BOUNDS) && key !== 'hypothesis' && key !== 'costMetrics')
      diagnostics.push(`unknown_field:${key}`);
  }
  for (const key of Object.keys(BOUNDS) as Array<keyof PatchExperimentThresholds>) {
    if (!(key in raw)) continue;
    const value = raw[key];
    const [min, max] = BOUNDS[key];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      ((key === 'minSamplesPerArm' || key === 'minCostMetricsImproved') && !Number.isInteger(value))
    ) {
      diagnostics.push(`invalid_field:${key}`);
      continue;
    }
    thresholds[key] = value;
  }
  const hypothesis =
    raw.hypothesis === 'success_noninferiority_cost_superiority'
      ? raw.hypothesis
      : 'success_superiority';
  if (
    raw.hypothesis !== undefined &&
    raw.hypothesis !== 'success_superiority' &&
    raw.hypothesis !== 'success_noninferiority_cost_superiority'
  )
    diagnostics.push('invalid_field:hypothesis');
  const allowedCostMetrics = new Set<PatchExperimentCostMetric>([
    'retries',
    'toolCalls',
    'durationMs',
    'tokens',
  ]);
  const costMetrics = Array.isArray(raw.costMetrics)
    ? [
        ...new Set(
          raw.costMetrics.filter(
            (value): value is PatchExperimentCostMetric =>
              typeof value === 'string' &&
              allowedCostMetrics.has(value as PatchExperimentCostMetric)
          )
        ),
      ]
    : (['retries', 'toolCalls', 'durationMs', 'tokens'] as PatchExperimentCostMetric[]);
  if (
    raw.costMetrics !== undefined &&
    (!Array.isArray(raw.costMetrics) ||
      costMetrics.length === 0 ||
      costMetrics.length !== raw.costMetrics.length)
  ) {
    diagnostics.push('invalid_field:costMetrics');
  }
  return {
    path: configPath,
    source: 'workspace',
    thresholds,
    hypothesis,
    costMetrics,
    diagnostics,
  };
}

export function formatEvolutionConfig(config: EvolutionConfigResult): string {
  const t = config.thresholds;
  return [
    `Self-evolution configuration (${config.source})`,
    '  path: .moss/evolution.json',
    `  hypothesis: ${config.hypothesis}`,
    `  costMetrics: ${config.costMetrics.join(',')}`,
    `  minSamplesPerArm: ${t.minSamplesPerArm}`,
    `  wilsonZ: ${t.wilsonZ}`,
    `  maxCostRatio: ${t.maxCostRatio}`,
    `  maxRetryIncrease: ${t.maxRetryIncrease}`,
    `  successNoninferiorityMargin: ${t.successNoninferiorityMargin}`,
    `  minCostImprovementRatio: ${t.minCostImprovementRatio}`,
    `  minCostMetricsImproved: ${t.minCostMetricsImproved}`,
    ...(config.diagnostics.length ? [`  diagnostics: ${config.diagnostics.join(', ')}`] : []),
  ].join('\n');
}
