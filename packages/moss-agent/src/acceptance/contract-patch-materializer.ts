import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AcceptSpec } from './types.js';
import type { PromotionDecisionRecord } from './promotion-coordinator.js';
import { validateAcceptSpecs } from './accept-spec-validator.js';
import { parseAcceptanceContract } from './contract-loader.js';
import { SkillRegistry } from '../skills/registry.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import type { CandidatePatchLog, CandidatePatchRecord } from '../memory/candidate-patch-log.js';

export interface ContractPatchProposal {
  skill: string;
  section: 'preconditions' | 'postconditions' | 'safetyConstraints';
  index?: number;
  spec: AcceptSpec;
  expectedVersion: string;
  sourceEventIds: string[];
  environmentFingerprint: string;
}

function nextVersion(version: string): string {
  const parts = version.split('.');
  const last = Number(parts.at(-1));
  return Number.isInteger(last) && last >= 0
    ? [...parts.slice(0, -1), String(last + 1)].join('.')
    : `${version}.1`;
}

function proposalId(proposal: ContractPatchProposal): string {
  return `patch_${createHash('sha256').update(JSON.stringify(proposal)).digest('hex').slice(0, 20)}`;
}

export class ContractPatchMaterializer {
  private readonly skillRegistry: SkillRegistry;

  constructor(
    private readonly deps: {
      workspaceDir: string;
      patchLog: CandidatePatchLog;
      skillRegistry?: SkillRegistry;
    }
  ) {
    this.skillRegistry =
      deps.skillRegistry ?? new SkillRegistry({ workspaceDir: deps.workspaceDir });
  }

  async publish(
    proposal: ContractPatchProposal,
    promotion: PromotionDecisionRecord
  ): Promise<CandidatePatchRecord> {
    const id = proposalId(proposal);
    const errors = validateAcceptSpecs([proposal.spec]);
    if (promotion.candidate.targetSkill !== proposal.skill) errors.push('promotion_skill_mismatch');
    if (!promotion.decision.promotable) errors.push('promotion_gate_not_passed');
    const skill = this.skillRegistry
      .list()
      .find((entry) => entry.name === proposal.skill && !entry.sourcePath.startsWith('builtin://'));
    if (!skill) errors.push('skill_not_found');
    const paths = getMossWorkspacePaths(this.deps.workspaceDir);
    const allowedRoots = [paths.skillsDir, paths.agentSkillsDir].map(
      (root) => `${path.resolve(root)}${path.sep}`
    );
    const sourcePath = skill?.sourcePath ? path.resolve(skill.sourcePath) : '';
    if (sourcePath && !allowedRoots.some((root) => sourcePath.startsWith(root)))
      errors.push('skill_not_workspace_owned');
    const contractPath = sourcePath ? path.join(path.dirname(sourcePath), 'ACCEPTANCE.json') : '';
    let raw: Record<string, unknown> | undefined;
    if (!errors.length) {
      try {
        raw = JSON.parse(await fs.readFile(contractPath, 'utf8')) as Record<string, unknown>;
      } catch {
        errors.push('acceptance_contract_unreadable');
      }
    }
    if (raw && String(raw.version ?? '1') !== proposal.expectedVersion)
      errors.push('stale_contract_version');
    if (errors.length)
      return this.record(id, proposal, 'rejected', errors, 'contract_patch_rejected');

    await this.record(id, proposal, 'validated', [], 'whitelist_and_promotion_gates_passed');
    const section = Array.isArray(raw![proposal.section])
      ? [...(raw![proposal.section] as unknown[])]
      : [];
    if (proposal.index === undefined) section.push(proposal.spec);
    else if (proposal.index >= 0 && proposal.index < section.length)
      section[proposal.index] = proposal.spec;
    else
      return this.record(
        id,
        proposal,
        'rejected',
        ['section_index_out_of_range'],
        'contract_patch_rejected'
      );
    const next = {
      ...raw!,
      [proposal.section]: section,
      version: nextVersion(proposal.expectedVersion),
    };
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    const parsed = parseAcceptanceContract(serialized, contractPath);
    if (!parsed || parsed.skillName !== proposal.skill) {
      return this.record(
        id,
        proposal,
        'rejected',
        ['resulting_contract_invalid'],
        'contract_patch_rejected'
      );
    }
    const backupPath = `${contractPath}.backup.${Date.now()}.${randomUUID()}`;
    await atomicWriteFile(backupPath, `${JSON.stringify(raw!, null, 2)}\n`);
    try {
      await atomicWriteFile(contractPath, serialized);
    } catch (error) {
      try {
        await atomicWriteFile(contractPath, await fs.readFile(backupPath, 'utf8'));
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `contract patch publish failed and backup restoration also failed: ${contractPath}`
        );
      }
      throw error;
    }
    return this.record(
      id,
      proposal,
      'published',
      [],
      'contract_patch_published',
      contractPath,
      backupPath
    );
  }

  async rollback(patchId: string): Promise<boolean> {
    const history = (await this.deps.patchLog.readAll()).filter((record) => record.id === patchId);
    if (history.at(-1)?.state === 'rolled_back') return false;
    const latest = [...history].reverse().find((record) => record.state === 'published');
    if (!latest || latest.kind !== 'contract-params' || !latest.artifactPath || !latest.backupPath)
      return false;
    const paths = getMossWorkspacePaths(this.deps.workspaceDir);
    const allowedRoots = [paths.skillsDir, paths.agentSkillsDir].map(
      (root) => `${path.resolve(root)}${path.sep}`
    );
    const artifactPath = path.resolve(latest.artifactPath);
    const backupPath = path.resolve(latest.backupPath);
    if (
      !allowedRoots.some((root) => artifactPath.startsWith(root)) ||
      path.basename(artifactPath) !== 'ACCEPTANCE.json' ||
      path.dirname(backupPath) !== path.dirname(artifactPath) ||
      !/^ACCEPTANCE\.json\.backup\.\d+(?:\.[0-9a-f-]+)?$/.test(path.basename(backupPath))
    )
      return false;
    await atomicWriteFile(artifactPath, await fs.readFile(backupPath, 'utf8'));
    await this.deps.patchLog.append({
      ...latest,
      revision: latest.revision + 1,
      state: 'rolled_back',
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  private async record(
    id: string,
    proposal: ContractPatchProposal,
    state: CandidatePatchRecord['state'],
    validationErrors: string[],
    reasonCode: string,
    artifactPath?: string,
    backupPath?: string
  ): Promise<CandidatePatchRecord> {
    const previous = (await this.deps.patchLog.latest(id))[0];
    const record: CandidatePatchRecord = {
      schemaVersion: 1,
      id,
      revision: (previous?.revision ?? 0) + 1,
      kind: 'contract-params',
      state,
      skill: proposal.skill,
      environmentFingerprint: proposal.environmentFingerprint,
      failureClass: 'contract_drift',
      sourceEventIds: [...new Set(proposal.sourceEventIds)].sort(),
      toolSequences: [],
      reasonCode,
      ...(validationErrors.length ? { validationErrors } : {}),
      ...(artifactPath ? { artifactPath } : {}),
      ...(backupPath ? { backupPath } : {}),
      timestamp: new Date().toISOString(),
    };
    await this.deps.patchLog.append(record);
    return record;
  }
}
