import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_PATCH_EXPERIMENT_THRESHOLDS,
  type PatchExperimentThresholds,
} from './trusted-skill-experiment-coordinator.js';

export interface EvolutionConfigResult {
  path: string;
  source: 'default' | 'workspace';
  thresholds: PatchExperimentThresholds;
  diagnostics: string[];
}

const BOUNDS: Record<keyof PatchExperimentThresholds, readonly [number, number]> = {
  minSamplesPerArm: [2, 10_000],
  wilsonZ: [1, 4],
  maxCostRatio: [1, 10],
  maxRetryIncrease: [0, 10],
};

export async function loadEvolutionConfig(workspaceDir: string): Promise<EvolutionConfigResult> {
  const configPath = path.join(workspaceDir, '.moss', 'evolution.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: configPath, source: 'default', thresholds: { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS }, diagnostics: [] };
    }
    return {
      path: configPath,
      source: 'default',
      thresholds: { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS },
      diagnostics: [`invalid_json:${error instanceof Error ? error.message : String(error)}`],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      path: configPath,
      source: 'workspace',
      thresholds: { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS },
      diagnostics: ['config_must_be_object'],
    };
  }
  const root = parsed as Record<string, unknown>;
  const raw = root.experiment && typeof root.experiment === 'object' && !Array.isArray(root.experiment)
    ? root.experiment as Record<string, unknown>
    : root;
  const diagnostics: string[] = [];
  const thresholds = { ...DEFAULT_PATCH_EXPERIMENT_THRESHOLDS };
  for (const key of Object.keys(raw)) {
    if (!(key in BOUNDS)) diagnostics.push(`unknown_field:${key}`);
  }
  for (const key of Object.keys(BOUNDS) as Array<keyof PatchExperimentThresholds>) {
    if (!(key in raw)) continue;
    const value = raw[key];
    const [min, max] = BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
      || (key === 'minSamplesPerArm' && !Number.isInteger(value))) {
      diagnostics.push(`invalid_field:${key}`);
      continue;
    }
    thresholds[key] = value;
  }
  return { path: configPath, source: 'workspace', thresholds, diagnostics };
}

export function formatEvolutionConfig(config: EvolutionConfigResult): string {
  const t = config.thresholds;
  return [
    `Self-evolution configuration (${config.source})`,
    '  path: .moss/evolution.json',
    `  minSamplesPerArm: ${t.minSamplesPerArm}`,
    `  wilsonZ: ${t.wilsonZ}`,
    `  maxCostRatio: ${t.maxCostRatio}`,
    `  maxRetryIncrease: ${t.maxRetryIncrease}`,
    ...(config.diagnostics.length ? [`  diagnostics: ${config.diagnostics.join(', ')}`] : []),
  ].join('\n');
}
