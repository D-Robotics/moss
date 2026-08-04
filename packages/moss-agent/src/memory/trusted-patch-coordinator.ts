import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LearningEvent, LearningEventLog } from './learning-event-log.js';
import { CandidatePatchLog, type CandidatePatchRecord } from './candidate-patch-log.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { memoryWarn } from './logger.js';
import { isRealEvidenceEligible, requiresRealDeviceEvidence } from './evidence-trust.js';
import { SkillRegistry } from '../skills/registry.js';
import {
  validateRecoveryRecipe,
  validateShadowReplay,
  type RecoveryRecipe,
  type RecoveryRecipeLog,
} from './recovery-recipe-log.js';

const SAFE_TOOL = /^[A-Za-z0-9_.:-]{1,80}$/;
const TRUSTED_PATCH_METADATA_FILE = 'TRUSTED-PATCH.json';
const TRUSTED_SKILL_FILE = 'SKILL.md';
const TRUSTED_SKILL_BACKUP_RE = /^SKILL\.backup\.\d+(?:\.[0-9a-f-]+)?\.md$/;

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'skill';
}

function patchId(event: LearningEvent, kind: CandidatePatchRecord['kind']): string {
  const key = `${kind}\0${event.skill ?? event.taskId}\0${event.environmentFingerprint}\0${event.failureClass ?? 'unknown'}`;
  return `patch_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

function uniqueSequences(events: LearningEvent[]): string[][] {
  const map = new Map<string, string[]>();
  for (const event of events) {
    const sequence = (event.toolSequence ?? []).filter(Boolean);
    if (sequence.length) map.set(sequence.join('\0'), sequence);
  }
  return [...map.values()];
}

export class TrustedPatchCoordinator {
  private readonly minRecoveryProofs: number;

  constructor(private readonly deps: {
    workspaceDir: string;
    eventLog: LearningEventLog;
    patchLog: CandidatePatchLog;
    recipeLog?: RecoveryRecipeLog;
    skillRegistry?: SkillRegistry;
    minRecoveryProofs?: number;
  }) {
    this.minRecoveryProofs = deps.minRecoveryProofs ?? 2;
    if (!Number.isInteger(this.minRecoveryProofs) || this.minRecoveryProofs < 1) {
      throw new RangeError('minRecoveryProofs must be a positive integer');
    }
  }

  async observeLearningEvent(event: LearningEvent): Promise<CandidatePatchRecord | null> {
    if ((event.attribution !== 'single-skill' && event.attribution !== 'single-owner-step')
      || !event.skill || event.environmentFingerprint === 'unknown') return null;
    if (requiresRealDeviceEvidence(event.skill) && !isRealEvidenceEligible(event)) return null;
    if (event.failureClass === 'contract_drift' && event.outcome === 'failed') {
      return this.record(event, 'contract-review', 'proposed', [event], [], 'contract_requires_independent_review');
    }
    if (event.outcome !== 'recovered' || !event.failureClass) return null;
    // A published revision is the immutable subject of its A/B experiment.
    // Later recoveries remain in LearningEventLog, but must not silently
    // rewrite/reject the patch being measured. A rolled-back patch likewise
    // cannot auto-resurrect from another observation.
    const stableId = patchId(event, 'skill-guidance');
    const stable = (await this.deps.patchLog.latest(stableId))[0];
    if (stable?.state === 'published' || stable?.state === 'rolled_back') return stable;
    const related = (await this.deps.eventLog.readAll()).filter((candidate) =>
      candidate.outcome === 'recovered'
      && (candidate.attribution === 'single-skill' || candidate.attribution === 'single-owner-step')
      && candidate.skill === event.skill
      && candidate.environmentFingerprint === event.environmentFingerprint
      && candidate.failureClass === event.failureClass,
    ).filter((candidate) => !requiresRealDeviceEvidence(candidate.skill) || isRealEvidenceEligible(candidate));
    const independentProofs = new Set(related.map((candidate) => `${candidate.taskId}:${candidate.runId}`)).size;
    const sequences = uniqueSequences(related);
    const proposed = await this.record(event, 'skill-guidance', 'proposed', related, sequences, `recovery_proofs=${independentProofs}`);
    if (independentProofs < this.minRecoveryProofs) return proposed;
    const recipe = event.recoveryRecipeId && this.deps.recipeLog
      ? (await this.deps.recipeLog.latest(event.recoveryRecipeId))[0]
      : undefined;
    const recipeReason = recipe ? await this.validateRecipe(recipe) : 'insufficient_procedural_detail';
    const errors = this.validateGuidance(event, sequences);
    if (recipeReason !== 'quality_passed') errors.push(recipeReason);
    if (errors.length) return this.record(event, 'skill-guidance', 'rejected', related, sequences, 'validation_failed', errors);
    if (recipe && this.deps.recipeLog) {
      await this.deps.recipeLog.append({
        ...recipe,
        revision: recipe.revision + 1,
        state: 'quality_validated',
        qualityReason: 'quality_passed',
        timestamp: new Date().toISOString(),
      });
    }
    return this.record(event, 'skill-guidance', 'validated', related, sequences, 'awaiting_held_out_shadow_replay');
  }

  async observeShadowReplay(input: {
    recipeId: string;
    taskId: string;
    runId: string;
    evidenceIds: string[];
    verdict: 'pass' | 'fail' | 'unknown';
    safetyFailed?: boolean;
  }): Promise<CandidatePatchRecord | null> {
    if (!this.deps.recipeLog) return null;
    const recipe = (await this.deps.recipeLog.latest(input.recipeId))[0];
    if (!recipe || (recipe.state !== 'quality_validated' && recipe.state !== 'shadow_validated')) return null;
    const reason = validateShadowReplay({ recipe, ...input });
    const sourceEvents = (await this.deps.eventLog.readAll()).filter((event) => recipe.sourceEventIds.includes(event.id));
    const event = sourceEvents.at(-1);
    if (!event) return null;
    const sequences = uniqueSequences(sourceEvents);
    if (reason !== 'quality_passed') {
      await this.deps.recipeLog.append({
        ...recipe, revision: recipe.revision + 1, state: 'rejected', qualityReason: reason,
        shadowEvidenceIds: [...input.evidenceIds].sort(), timestamp: new Date().toISOString(),
      });
      return this.record(event, 'skill-guidance', 'rejected', sourceEvents, sequences, 'shadow_replay_failed', [reason]);
    }
    const validated: RecoveryRecipe = {
      ...recipe, revision: recipe.revision + 1, state: 'shadow_validated', qualityReason: 'quality_passed',
      shadowEvidenceIds: [...input.evidenceIds].sort(), timestamp: new Date().toISOString(),
    };
    await this.deps.recipeLog.append(validated);
    return this.publishGuidance(event, sourceEvents, sequences, validated);
  }

  private validateGuidance(event: LearningEvent, sequences: string[][]): string[] {
    const errors: string[] = [];
    if (!event.skill) errors.push('skill_missing');
    if (!event.failureClass) errors.push('failure_class_missing');
    if (!sequences.length) errors.push('tool_sequence_missing');
    if (sequences.some((sequence) => sequence.length > 12 || sequence.some((tool) => !SAFE_TOOL.test(tool)))) {
      errors.push('unsafe_tool_name');
    }
    return errors;
  }

  private async publishGuidance(
    event: LearningEvent,
    related: LearningEvent[],
    sequences: string[][],
    recipe?: RecoveryRecipe,
  ): Promise<CandidatePatchRecord> {
    const id = patchId(event, 'skill-guidance');
    const paths = getMossWorkspacePaths(this.deps.workspaceDir);
    const targetDir = path.join(paths.learnedSkillsDir, `${slug(event.skill!)}-trusted-recovery`);
    const targetPath = path.join(targetDir, TRUSTED_SKILL_FILE);
    const metadataPath = path.join(targetDir, TRUSTED_PATCH_METADATA_FILE);
    const existingLatest = (await this.deps.patchLog.latest(id))[0];
    const sourceEventIds = related.map((entry) => entry.id).sort();
    if (existingLatest?.state === 'published'
      && JSON.stringify(existingLatest.sourceEventIds) === JSON.stringify(sourceEventIds)) return existingLatest;
    await fs.mkdir(targetDir, { recursive: true });
    let backupPath: string | undefined;
    try {
      const previous = await fs.readFile(targetPath, 'utf8');
      backupPath = path.join(targetDir, `SKILL.backup.${Date.now()}.${randomUUID()}.md`);
      await atomicWriteFile(backupPath, previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const body = [
      '---',
      `name: ${slug(event.skill!)}-trusted-recovery`,
      `description: Objective recovery guidance learned for ${event.skill}`,
      `version: 0.1.${Math.min(999, sourceEventIds.length)}`,
      `tags: ${event.skill}, trusted-recovery, ${event.failureClass}`,
      `triggers: ${event.skill}, ${event.failureClass}`,
      'enabled: false',
      'risk: low',
      'permissions:',
      'approval_level: confirm',
      '---',
      '',
      '# Trusted recovery guidance',
      '',
      `Apply only for **${event.skill}** in environment fingerprint \`${event.environmentFingerprint}\`.`,
      'Treat this as execution guidance, not as proof of success. Re-run the Plan acceptance predicates and terminal acceptance.',
      '',
      `Observed failure class: \`${event.failureClass}\`.`,
      '',
      'Verified recovery tool sequences:',
      ...sequences.map((sequence) => `- ${sequence.map((tool) => `\`${tool}\``).join(' → ')}`),
      '',
      ...(recipe ? [
        'Validated recovery procedure:',
        ...recipe.steps.map((step, index) => `${index + 1}. Use \`${step.tool}\` to \`${step.operation}\` with ${Object.entries(step.arguments).map(([key, value]) => `\`${key}=${String(value)}\``).join(', ')}.`),
        '',
        ...(recipe.executionMode === 'single-bounded-transaction' ? [
          'Execution mode: `single-bounded-transaction`.',
          'Execute only the four compiler-listed recovery operations above in one bounded `exec` transaction using fail-fast (`set -eu`) semantics and a cleanup trap for the unique staging artifact.',
          'This compiler-owned transaction supersedes the base Skill one-command-per-tool rule only for these allowlisted recovery operations; keep capture, service checks, and every other operation separate.',
          'After the transaction succeeds, do not manually repeat terminal probes. Submit completion so the independent terminal gate evaluates the current Plan terminalAccept.',
          '',
        ] : []),
        `Required invariants: ${recipe.invariants.map((value) => `\`${value}\``).join(', ')}.`,
        ...(recipe.verifiedBindings && Object.keys(recipe.verifiedBindings).length ? [
          `Verified bindings for this exact environment: ${Object.entries(recipe.verifiedBindings).map(([key, value]) => `\`${key}=${String(value)}\``).join(', ')}.`,
          'Fast-path precedence: for this exact environment, these verified bindings supersede the base Skill parameter-discovery steps.',
          'Keep every base-Skill safety invariant and terminal check, but do not repeat discovery probes for these bindings.',
          'Fall back to the full base-Skill discovery flow only if an objective command rejects a binding or the environment fingerprint changes.',
        ] : []),
        `Available recovery checks: ${recipe.terminalAccept.map((spec) => `\`${spec.name}\``).join(', ')}.`,
        'These are capabilities, not extra requirements. Execute only the checks also declared by the current Plan terminalAccept.',
        '',
      ] : []),
      `Objective recovery proofs: ${sourceEventIds.length}.`,
    ].join('\n');
    let targetWritten = false;
    try {
      await atomicWriteFile(targetPath, body);
      targetWritten = true;
      await atomicWriteFile(metadataPath, `${JSON.stringify({
        schemaVersion: 1, patchId: id, sourceEventIds, environmentFingerprint: event.environmentFingerprint,
        failureClass: event.failureClass, recoveryRecipeId: recipe?.id, recoveryRecipeRevision: recipe?.revision,
        generatedAt: new Date().toISOString(),
      }, null, 2)}\n`);
    } catch (error) {
      if (backupPath) {
        try {
          await atomicWriteFile(targetPath, await fs.readFile(backupPath, 'utf8'));
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `trusted patch publish failed and backup restoration also failed: ${targetPath}`,
          );
        }
      } else if (targetWritten) {
        // A new publication has no prior directory state to restore. Remove only
        // files owned by this coordinator; never recursively delete the directory.
        await Promise.allSettled([
          fs.rm(targetPath, { force: true }),
          fs.rm(metadataPath, { force: true }),
        ]);
      }
      throw error;
    }
    const published = await this.record(event, 'skill-guidance', 'published', related, sequences, 'auto_published_trusted_recovery', [], targetPath, backupPath);
    if (recipe && this.deps.recipeLog) {
      const latest = (await this.deps.recipeLog.latest(recipe.id))[0] ?? recipe;
      await this.deps.recipeLog.append({
        ...latest,
        revision: latest.revision + 1,
        state: 'published',
        qualityReason: 'quality_passed',
        timestamp: new Date().toISOString(),
      });
    }
    return published;
  }

  private async validateRecipe(recipe: RecoveryRecipe): Promise<ReturnType<typeof validateRecoveryRecipe>> {
    const registry = this.deps.skillRegistry ?? new SkillRegistry({ workspaceDir: this.deps.workspaceDir });
    const meta = registry.list().find((skill) => skill.name === recipe.skill && !/trusted-recovery/i.test(skill.sourcePath));
    let baseSkillText = '';
    if (meta?.sourcePath) {
      try { baseSkillText = await fs.readFile(meta.sourcePath, 'utf8'); } catch { baseSkillText = ''; }
    }
    return validateRecoveryRecipe(recipe, baseSkillText);
  }

  async rollback(patchIdValue: string): Promise<boolean> {
    const history = (await this.deps.patchLog.readAll()).filter((record) => record.id === patchIdValue);
    if (history.at(-1)?.state === 'rolled_back') return false;
    const latest = [...history].reverse().find((record) => record.state === 'published');
    if (!latest?.artifactPath) return false;
    const learnedRoot = `${path.resolve(getMossWorkspacePaths(this.deps.workspaceDir).learnedSkillsDir)}${path.sep}`;
    const artifactPath = path.resolve(latest.artifactPath);
    if (!artifactPath.startsWith(learnedRoot) || path.basename(artifactPath) !== TRUSTED_SKILL_FILE) return false;
    const artifactDir = path.dirname(artifactPath);
    if (latest.backupPath) {
      const backupPath = path.resolve(latest.backupPath);
      if (path.dirname(backupPath) !== artifactDir || !TRUSTED_SKILL_BACKUP_RE.test(path.basename(backupPath))) return false;
      await atomicWriteFile(artifactPath, await fs.readFile(backupPath, 'utf8'));
    } else {
      await Promise.all([
        fs.rm(artifactPath, { force: true }),
        fs.rm(path.join(artifactDir, TRUSTED_PATCH_METADATA_FILE), { force: true }),
      ]);
    }
    await this.deps.patchLog.append({ ...latest, revision: latest.revision + 1, state: 'rolled_back', timestamp: new Date().toISOString() });
    return true;
  }

  private async record(
    event: LearningEvent,
    kind: CandidatePatchRecord['kind'],
    state: CandidatePatchRecord['state'],
    sources: LearningEvent[],
    sequences: string[][],
    reasonCode: string,
    validationErrors: string[] = [],
    artifactPath?: string,
    backupPath?: string,
  ): Promise<CandidatePatchRecord> {
    const id = patchId(event, kind);
    const existing = (await this.deps.patchLog.latest(id))[0];
    const record: CandidatePatchRecord = {
      schemaVersion: 1, id, revision: (existing?.revision ?? 0) + 1, kind, state,
      skill: event.skill!, environmentFingerprint: event.environmentFingerprint,
      ...(event.environmentIdentityVersion ? {
        environmentIdentityVersion: event.environmentIdentityVersion,
        environmentCompleteness: event.environmentCompleteness,
      } : {}),
      executionDomain: event.executionDomain,
      realEvidenceEligible: event.realEvidenceEligible,
      failureClass: event.failureClass ?? 'unknown', sourceEventIds: sources.map((entry) => entry.id).sort(),
      toolSequences: sequences, reasonCode,
      ...(validationErrors.length ? { validationErrors } : {}),
      ...(artifactPath ? { artifactPath } : {}), ...(backupPath ? { backupPath } : {}),
      timestamp: new Date().toISOString(),
    };
    try { await this.deps.patchLog.append(record); } catch (error) { memoryWarn('candidate patch log write failed:', error); }
    return record;
  }
}
