import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AcceptSpec } from '../acceptance/types.js';
import { defaultWriteChain } from '../utils/write-chain.js';
import type { ExperienceEntry } from './experience-log.js';
import type { LearningEvent, LearningFailureClass } from './learning-event-log.js';

export type RecoveryRecipeState =
  | 'candidate'
  | 'quality_validated'
  | 'shadow_validated'
  | 'published'
  | 'rejected'
  | 'rolled_back';
export type RecoveryRecipeQualityReason =
  | 'quality_passed'
  | 'insufficient_procedural_detail'
  | 'insufficient_novelty'
  | 'subsumed_by_base_skill'
  | 'overfit_to_single_environment'
  | 'unsafe_or_unresolved_operation'
  | 'insufficient_independent_evidence'
  | 'shadow_evidence_overlap'
  | 'shadow_acceptance_failed';

export interface RecoveryRecipeOperation {
  tool: string;
  operation: string;
  arguments: Record<string, string | number | boolean>;
  expectedEvidence: AcceptSpec[];
}

export interface RecoveryRecipe {
  schemaVersion: 1;
  id: string;
  revision: number;
  state: RecoveryRecipeState;
  skill: string;
  environmentSelector: {
    fingerprint: string;
    boardFamily?: string;
  };
  failureSignature: {
    failureClass: LearningFailureClass;
    reasonCodes: string[];
  };
  preconditions: AcceptSpec[];
  steps: RecoveryRecipeOperation[];
  /** Compiler-owned batching policy; never inferred from model text. */
  executionMode?: 'single-bounded-transaction';
  terminalAccept: AcceptSpec[];
  safetyConstraints: AcceptSpec[];
  bindings: Record<string, 'path' | 'integer' | 'timestamp' | 'bytes'>;
  /** Sanitized objective values reusable only under environmentSelector. */
  verifiedBindings?: Record<string, string | number | boolean>;
  invariants: string[];
  sourceEventIds: string[];
  sourceTaskRunIds: string[];
  sourceExperienceIds: string[];
  independentRecoveryCount: number;
  qualityReason: RecoveryRecipeQualityReason;
  shadowEvidenceIds?: string[];
  timestamp: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 20);
}

export function recoveryRecipeId(
  input: Pick<LearningEvent, 'skill' | 'environmentFingerprint' | 'failureClass'>
): string {
  return `recipe_${digest(`${input.skill ?? 'unknown'}\0${input.environmentFingerprint}\0${input.failureClass ?? 'unknown'}`)}`;
}

export class RecoveryRecipeLog {
  private readonly filePath: string;
  private readonly chain = defaultWriteChain;

  constructor(opts: { baseDir: string; filename?: string }) {
    this.filePath = path.join(opts.baseDir, opts.filename ?? 'recovery-recipes.jsonl');
  }

  get path(): string {
    return this.filePath;
  }

  async append(recipe: RecoveryRecipe): Promise<boolean> {
    if (recipe.schemaVersion !== 1) throw new Error('RecoveryRecipeLog: schemaVersion must be 1');
    let appended = false;
    await this.chain.enqueue(this.filePath, async () => {
      const existing = await this.readAll();
      if (
        existing.some(
          (entry) =>
            entry.id === recipe.id &&
            entry.revision === recipe.revision &&
            entry.state === recipe.state
        )
      )
        return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(recipe)}\n`, 'utf8');
      appended = true;
    });
    return appended;
  }

  async readAll(): Promise<RecoveryRecipe[]> {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      return text.split('\n').flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const value = JSON.parse(line) as RecoveryRecipe;
          return value.schemaVersion === 1 && value.id && Array.isArray(value.steps) ? [value] : [];
        } catch {
          return [];
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async latest(id?: string): Promise<RecoveryRecipe[]> {
    const latest = new Map<string, RecoveryRecipe>();
    for (const recipe of await this.readAll()) {
      if (id && recipe.id !== id) continue;
      const previous = latest.get(recipe.id);
      if (!previous || recipe.revision >= previous.revision) latest.set(recipe.id, recipe);
    }
    return [...latest.values()];
  }
}

function commandOf(entry: ExperienceEntry): string {
  if (!entry.input || typeof entry.input !== 'object') return '';
  const command = (entry.input as Record<string, unknown>).command;
  return typeof command === 'string' ? command : '';
}

function cameraTraceEligible(event: LearningEvent, experiences: ExperienceEntry[]): boolean {
  if (event.skill !== 'rdk-capture-photo') return false;
  return experiences.some((entry) => {
    const command = commandOf(entry);
    return (
      /get_isp_data|ffmpeg|handle_.*\.yuv|photo.*\.jpe?g/i.test(command) ||
      entry.diagnostics?.recoveryAdapter === 'rdk-camera-capture'
    );
  });
}

/**
 * Compiles only recognized objective operations. It never copies command text
 * into the recipe, so credentials, hosts and shell control flow cannot cross
 * the learning boundary.
 */
export function compileRecoveryRecipe(input: {
  event: LearningEvent;
  experiences: ExperienceEntry[];
  relatedRecoveries: LearningEvent[];
  previous?: RecoveryRecipe;
}): RecoveryRecipe | null {
  const { event } = input;
  if (
    event.outcome !== 'recovered' ||
    !event.skill ||
    !event.failureClass ||
    event.environmentFingerprint === 'unknown'
  )
    return null;
  if (!cameraTraceEligible(event, input.experiences)) return null;
  const sourceEvents = [...input.relatedRecoveries, event].filter(
    (candidate, index, all) => all.findIndex((other) => other.id === candidate.id) === index
  );
  const sourceTaskRunIds = [
    ...new Set(sourceEvents.map((candidate) => `${candidate.taskId}:${candidate.runId}`)),
  ].sort();
  const id = recoveryRecipeId(event);
  const immutable =
    input.previous?.state === 'published' || input.previous?.state === 'rolled_back';
  const revision = immutable ? input.previous!.revision + 1 : (input.previous?.revision ?? 0) + 1;
  const artifactPath = '${artifactPath}';
  const markerPath = '${captureMarker}';
  const outputCollision = input.experiences.some(
    (entry) =>
      /(?:test\s+-d|rmdir|directory).*photo/i.test(commandOf(entry)) ||
      entry.diagnostics?.recoveryAdapter === 'rdk-camera-output-collision'
  );
  const commands = input.experiences.map(commandOf).join('\n');
  const sensorIndex = Number(/get_isp_data[^\n]*?\s-s\s+(\d+)/i.exec(commands)?.[1]);
  const dimensions = /(?:\s-s|video_size)\s+(\d+)x(\d+)/i.exec(commands);
  const width = Number(dimensions?.[1]);
  const height = Number(dimensions?.[2]);
  const verifiedBindings = {
    ...(Number.isInteger(sensorIndex) ? { sensorIndex } : {}),
    ...(Number.isInteger(width) && Number.isInteger(height)
      ? {
          width,
          height,
          frameBytes: Math.round(width * height * 1.5),
        }
      : {}),
  };
  const terminalAccept: AcceptSpec[] = [
    outputCollision
      ? { name: 'file_nonempty', params: { path: artifactPath } }
      : { name: 'file_fresh_nonempty', params: { path: artifactPath, after: markerPath } },
    {
      name: 'image_dimensions',
      params: { path: artifactPath, width: '${width}', height: '${height}' },
    },
    { name: 'image_content_nontrivial', params: { path: artifactPath, minVariation: 2 } },
  ];
  return {
    schemaVersion: 1,
    id,
    revision,
    state: 'candidate',
    skill: event.skill,
    environmentSelector: { fingerprint: event.environmentFingerprint, boardFamily: 'rdk-x5' },
    failureSignature: {
      failureClass: event.failureClass,
      reasonCodes: [
        ...new Set(sourceEvents.map((candidate) => candidate.reasonCode).filter(Boolean)),
      ].sort(),
    },
    preconditions: [{ name: 'process_running', params: { pattern: 'isp' } }],
    steps: outputCollision
      ? [
          {
            tool: 'exec',
            operation: 'inspect_output_target_type',
            arguments: { path: artifactPath },
            expectedEvidence: [
              { name: 'stdout_matches', params: { pattern: 'missing|regular|empty-directory' } },
            ],
          },
          {
            tool: 'exec',
            operation: 'remove_exact_empty_output_collision',
            arguments: { path: artifactPath, requireEmptyDirectory: true },
            expectedEvidence: [{ name: 'exit_code_zero', params: {} }],
          },
          {
            tool: 'exec',
            operation: 'convert_to_unique_staging_jpeg',
            arguments: {
              input: '${sourceYuv}',
              output: '${stagingArtifactPath}',
              width: '${width}',
              height: '${height}',
            },
            expectedEvidence: [
              {
                name: 'image_content_nontrivial',
                params: { path: '${stagingArtifactPath}', minVariation: 50 },
              },
            ],
          },
          {
            tool: 'exec',
            operation: 'promote_validated_artifact',
            arguments: { source: '${stagingArtifactPath}', output: artifactPath },
            expectedEvidence: terminalAccept,
          },
        ]
      : [
          {
            tool: 'exec',
            operation: 'mark_capture_boundary',
            arguments: { path: markerPath },
            expectedEvidence: [{ name: 'file_exist', params: { path: markerPath } }],
          },
          {
            tool: 'exec',
            operation: 'probe_sensor_index',
            arguments: { source: 'get_isp_data_help' },
            expectedEvidence: [{ name: 'stdout_matches', params: { pattern: 'sensor|index' } }],
          },
          {
            tool: 'exec',
            operation: 'capture_nv12_frame',
            arguments: { sensorIndex: '${sensorIndex}' },
            expectedEvidence: [{ name: 'exit_code_zero', params: {} }],
          },
          {
            tool: 'exec',
            operation: 'select_fresh_size_valid_frame',
            arguments: {
              createdAfter: markerPath,
              expectedBytes: '${frameBytes}',
              output: '${sourceYuv}',
            },
            expectedEvidence: [
              { name: 'file_fresh_nonempty', params: { path: '${sourceYuv}', after: markerPath } },
            ],
          },
          {
            tool: 'exec',
            operation: 'convert_nv12_to_jpeg',
            arguments: {
              input: '${sourceYuv}',
              output: artifactPath,
              width: '${width}',
              height: '${height}',
            },
            expectedEvidence: terminalAccept,
          },
        ],
    ...(outputCollision ? { executionMode: 'single-bounded-transaction' as const } : {}),
    terminalAccept,
    safetyConstraints: [
      {
        name: 'stdout_matches',
        params: { pattern: '^(?!.*(?:reboot|shutdown|mkfs)).*$' },
        safetyCritical: true,
      },
    ],
    bindings: {
      artifactPath: 'path',
      stagingArtifactPath: 'path',
      captureMarker: 'path',
      sourceYuv: 'path',
      sensorIndex: 'integer',
      width: 'integer',
      height: 'integer',
      frameBytes: 'bytes',
      runStartedAt: 'timestamp',
    },
    ...(Object.keys(verifiedBindings).length ? { verifiedBindings } : {}),
    invariants: outputCollision
      ? [
          'output-target-type',
          'bounded-empty-collision-cleanup',
          'unique-staging-output',
          'validate-before-promote',
        ]
      : [
          'capture-boundary',
          'fresh-source-frame',
          'expected-frame-size',
          'unique-output',
          'decoded-image-content',
        ],
    sourceEventIds: sourceEvents.map((candidate) => candidate.id).sort(),
    sourceTaskRunIds,
    sourceExperienceIds: [
      ...new Set([
        ...(input.previous?.sourceExperienceIds ?? []),
        ...input.experiences.map((entry) => entry.id),
      ]),
    ].sort(),
    independentRecoveryCount: sourceTaskRunIds.length,
    qualityReason: 'insufficient_independent_evidence',
    timestamp: new Date().toISOString(),
  };
}

export function validateRecoveryRecipe(
  recipe: RecoveryRecipe,
  baseSkillText = ''
): RecoveryRecipeQualityReason {
  if (
    recipe.steps.length < 2 ||
    recipe.steps.some((step) => !step.operation || step.expectedEvidence.length === 0)
  ) {
    return 'insufficient_procedural_detail';
  }
  if (recipe.independentRecoveryCount < 2) return 'insufficient_independent_evidence';
  if (
    !recipe.environmentSelector.boardFamily ||
    recipe.environmentSelector.fingerprint === 'unknown'
  ) {
    return 'overfit_to_single_environment';
  }
  if (
    Object.keys(recipe.bindings).length === 0 ||
    recipe.steps.some((step) => JSON.stringify(step.arguments).includes('undefined'))
  ) {
    return 'unsafe_or_unresolved_operation';
  }
  if (recipe.executionMode === 'single-bounded-transaction') {
    const allowed = new Set([
      'inspect_output_target_type',
      'remove_exact_empty_output_collision',
      'convert_to_unique_staging_jpeg',
      'promote_validated_artifact',
    ]);
    if (recipe.steps.some((step) => step.tool !== 'exec' || !allowed.has(step.operation))) {
      return 'unsafe_or_unresolved_operation';
    }
  }
  const normalizedBase = baseSkillText.toLowerCase().replace(/[_\s]+/g, '-');
  const material = recipe.invariants.filter((invariant) => normalizedBase.includes(invariant));
  if (material.length === recipe.invariants.length) return 'subsumed_by_base_skill';
  const hasSpecificCorrection =
    (recipe.invariants.includes('capture-boundary') &&
      recipe.invariants.includes('fresh-source-frame')) ||
    (recipe.invariants.includes('output-target-type') &&
      recipe.invariants.includes('validate-before-promote'));
  if (!hasSpecificCorrection) {
    return 'insufficient_novelty';
  }
  return 'quality_passed';
}

export function validateShadowReplay(input: {
  recipe: RecoveryRecipe;
  taskId: string;
  runId: string;
  evidenceIds: string[];
  verdict: 'pass' | 'fail' | 'unknown';
  safetyFailed?: boolean;
}): RecoveryRecipeQualityReason {
  if (
    input.recipe.sourceTaskRunIds.includes(`${input.taskId}:${input.runId}`) ||
    input.evidenceIds.some((id) => input.recipe.sourceExperienceIds.includes(id))
  )
    return 'shadow_evidence_overlap';
  if (input.verdict !== 'pass' || input.safetyFailed) return 'shadow_acceptance_failed';
  return 'quality_passed';
}
