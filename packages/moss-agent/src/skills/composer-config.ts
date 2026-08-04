import type {
  SkillComposerConfig,
  SkillComposerProviderMode,
} from './composer-types.js';

export interface SkillComposerConfigInput {
  enabled?: boolean;
  mode?: SkillComposerProviderMode | string;
  shadowMode?: boolean;
  shadowProvider?: string;
  maxSkills?: number;
  candidateLimit?: number;
  deadlineMs?: number;
  minScore?: number;
  minConfidence?: number;
  maxMemoryMb?: number;
  localModelEnabled?: boolean;
  remoteModelEnabled?: boolean;
}

const PROVIDER_MODES = new Set<SkillComposerProviderMode>([
  'legacy',
  'rules',
  'local-model',
  'remote-model',
  'auto',
]);

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function parseMode(value: unknown, fallback: SkillComposerProviderMode): SkillComposerProviderMode {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !PROVIDER_MODES.has(value as SkillComposerProviderMode)) {
    throw new Error('skills.composer.mode must be legacy, rules, local-model, remote-model, or auto');
  }
  return value as SkillComposerProviderMode;
}

export function normalizeSkillComposerConfig(
  input: SkillComposerConfigInput | undefined,
  deployment: 'host' | 'board' | 'host-controls-board' = 'host',
): SkillComposerConfig {
  const enabled = input?.enabled === true;
  const mode = parseMode(input?.mode, enabled ? 'rules' : 'legacy');
  const shadowProviderRaw = input?.shadowProvider;
  const shadowProvider = shadowProviderRaw === undefined
    ? undefined
    : parseMode(shadowProviderRaw, 'rules');
  if (shadowProvider === 'legacy' || shadowProvider === 'auto') {
    throw new Error('skills.composer.shadowProvider must be rules, local-model, or remote-model');
  }
  const localModelEnabled = input?.localModelEnabled === true;
  const remoteModelEnabled = input?.remoteModelEnabled === true;
  if (deployment === 'board' && mode === 'local-model' && !localModelEnabled) {
    throw new Error('board local-model composition requires localModelEnabled=true');
  }
  if (mode === 'remote-model' && !remoteModelEnabled) {
    throw new Error('remote-model composition requires remoteModelEnabled=true');
  }
  return {
    enabled,
    mode: enabled ? mode : 'legacy',
    shadowMode: input?.shadowMode === true,
    ...(shadowProvider ? { shadowProvider } : {}),
    maxSkills: Math.floor(boundedNumber(input?.maxSkills, 4, 1, 8, 'skills.composer.maxSkills')),
    candidateLimit: Math.floor(
      boundedNumber(input?.candidateLimit, 12, 1, 64, 'skills.composer.candidateLimit'),
    ),
    deadlineMs: Math.floor(
      boundedNumber(input?.deadlineMs, 750, 10, 30_000, 'skills.composer.deadlineMs'),
    ),
    minScore: boundedNumber(input?.minScore, 0.08, 0, 1, 'skills.composer.minScore'),
    minConfidence: boundedNumber(
      input?.minConfidence,
      0,
      0,
      1,
      'skills.composer.minConfidence',
    ),
    ...(input?.maxMemoryMb === undefined
      ? {}
      : {
          maxMemoryMb: Math.floor(
            boundedNumber(input.maxMemoryMb, 512, 64, 131_072, 'skills.composer.maxMemoryMb'),
          ),
        }),
    localModelEnabled,
    remoteModelEnabled,
  };
}
