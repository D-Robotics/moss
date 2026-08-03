import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LearningEvent, LearningEventLog } from './learning-event-log.js';
import { CandidatePatchLog, type CandidatePatchRecord } from './candidate-patch-log.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { memoryWarn } from './logger.js';

const SAFE_TOOL = /^[A-Za-z0-9_.:-]{1,80}$/;

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
    minRecoveryProofs?: number;
  }) {
    this.minRecoveryProofs = deps.minRecoveryProofs ?? 2;
  }

  async observeLearningEvent(event: LearningEvent): Promise<CandidatePatchRecord | null> {
    if (event.attribution !== 'single-skill' || !event.skill || event.environmentFingerprint === 'unknown') return null;
    if (event.failureClass === 'contract_drift' && event.outcome === 'failed') {
      return this.record(event, 'contract-review', 'proposed', [event], [], 'contract_requires_independent_review');
    }
    if (event.outcome !== 'recovered' || !event.failureClass) return null;
    const related = (await this.deps.eventLog.readAll()).filter((candidate) =>
      candidate.outcome === 'recovered'
      && candidate.attribution === 'single-skill'
      && candidate.skill === event.skill
      && candidate.environmentFingerprint === event.environmentFingerprint
      && candidate.failureClass === event.failureClass,
    );
    const independentProofs = new Set(related.map((candidate) => `${candidate.taskId}:${candidate.runId}`)).size;
    const sequences = uniqueSequences(related);
    const proposed = await this.record(event, 'skill-guidance', 'proposed', related, sequences, `recovery_proofs=${independentProofs}`);
    if (independentProofs < this.minRecoveryProofs) return proposed;
    const errors = this.validateGuidance(event, sequences);
    if (errors.length) return this.record(event, 'skill-guidance', 'rejected', related, sequences, 'validation_failed', errors);
    await this.record(event, 'skill-guidance', 'validated', related, sequences, 'trusted_recovery_threshold_met');
    return this.publishGuidance(event, related, sequences);
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
  ): Promise<CandidatePatchRecord> {
    const id = patchId(event, 'skill-guidance');
    const paths = getMossWorkspacePaths(this.deps.workspaceDir);
    const targetDir = path.join(paths.learnedSkillsDir, `${slug(event.skill!)}-trusted-recovery`);
    const targetPath = path.join(targetDir, 'SKILL.md');
    const metadataPath = path.join(targetDir, 'TRUSTED-PATCH.json');
    const existingLatest = (await this.deps.patchLog.latest(id))[0];
    const sourceEventIds = related.map((entry) => entry.id).sort();
    if (existingLatest?.state === 'published'
      && JSON.stringify(existingLatest.sourceEventIds) === JSON.stringify(sourceEventIds)) return existingLatest;
    await fs.mkdir(targetDir, { recursive: true });
    let backupPath: string | undefined;
    try {
      const previous = await fs.readFile(targetPath, 'utf8');
      backupPath = path.join(targetDir, `SKILL.backup.${Date.now()}.md`);
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
      `Objective recovery proofs: ${sourceEventIds.length}.`,
    ].join('\n');
    try {
      await atomicWriteFile(targetPath, body);
      await atomicWriteFile(metadataPath, `${JSON.stringify({
        schemaVersion: 1, patchId: id, sourceEventIds, environmentFingerprint: event.environmentFingerprint,
        failureClass: event.failureClass, generatedAt: new Date().toISOString(),
      }, null, 2)}\n`);
    } catch (error) {
      if (backupPath) await atomicWriteFile(targetPath, await fs.readFile(backupPath, 'utf8'));
      throw error;
    }
    return this.record(event, 'skill-guidance', 'published', related, sequences, 'auto_published_trusted_recovery', [], targetPath, backupPath);
  }

  async rollback(patchIdValue: string): Promise<boolean> {
    const history = (await this.deps.patchLog.readAll()).filter((record) => record.id === patchIdValue);
    if (history.at(-1)?.state === 'rolled_back') return false;
    const latest = [...history].reverse().find((record) => record.state === 'published');
    if (!latest?.artifactPath) return false;
    const learnedRoot = `${path.resolve(getMossWorkspacePaths(this.deps.workspaceDir).learnedSkillsDir)}${path.sep}`;
    const artifactPath = path.resolve(latest.artifactPath);
    if (!artifactPath.startsWith(learnedRoot)) return false;
    if (latest.backupPath) {
      const backupPath = path.resolve(latest.backupPath);
      if (path.dirname(backupPath) !== path.dirname(artifactPath)) return false;
      await atomicWriteFile(artifactPath, await fs.readFile(backupPath, 'utf8'));
    } else {
      await fs.rm(path.dirname(artifactPath), { recursive: true, force: true });
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
