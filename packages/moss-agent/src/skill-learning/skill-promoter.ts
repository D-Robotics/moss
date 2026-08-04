









import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillCandidateEvidence } from './skill-candidate-store.js';
import {
  getCandidatesRoot,
  isUnsafeCandidateId,
  removeCandidate,
} from './skill-candidate-store.js';
import {
  mergeSkillFrontmatterDefaults,
  validateSkillContent,
  type SkillValidationResult,
} from './skill-validation.js';
import { MOSS_SKILL_META_FILE } from './skill-metadata.js';
import { atomicWriteFile } from './fs-atomic.js';

export interface PromoteResult {
  skillId: string;
  skillPath: string;
  candidateId: string;
  validation: SkillValidationResult;
  confidence?: number;
  promotedAt: number;
}

export interface PromoteOptions {
  workspaceDir: string;
  candidateId: string;
  
  confidence?: number;
  
  onPromoted?: (result: PromoteResult) => void;
}












export async function promoteSkillCandidate(opts: PromoteOptions): Promise<PromoteResult | null> {
  const { workspaceDir, candidateId, confidence } = opts;
  
  
  
  
  
  if (isUnsafeCandidateId(candidateId)) {
    throw new Error('Invalid candidate ID');
  }
  const candidatesRoot = getCandidatesRoot(workspaceDir);
  const candidateDir = path.join(candidatesRoot, candidateId);
  const candidatePath = path.join(candidateDir, 'candidate.json');

  let evidence: SkillCandidateEvidence;
  try {
    evidence = JSON.parse(
      await fs.promises.readFile(candidatePath, 'utf-8')
    ) as SkillCandidateEvidence;
  } catch {
    return null;
  }

  
  const draftPath = path.join(candidateDir, 'SKILL.draft.md');
  let markdown: string;
  try {
    markdown = await fs.promises.readFile(draftPath, 'utf-8');
  } catch {
    
    markdown = generateMinimalSkillMd(evidence);
  }

  
  
  const normalized = mergeSkillFrontmatterDefaults(markdown, {
    skillId: candidateId,
  });

  const validation = validateSkillContent(normalized);
  if (!validation.valid) {
    throw new Error(`技能校验失败:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  const skillId = sanitizeSkillId(candidateId);
  if (!skillId) {
    throw new Error('Invalid candidate ID: normalized skill ID is empty');
  }
  const skillsDir = path.join(workspaceDir, '.moss', 'skills');
  const skillDir = path.join(skillsDir, skillId);

  const directoryExisted = await pathExists(skillDir);
  await fs.promises.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  const metaPath = path.join(skillDir, MOSS_SKILL_META_FILE);
  const promotedAt = Date.now();
  const previousSkill = await readOptionalFile(skillPath);
  const previousMeta = await readOptionalFile(metaPath);

  try {
    await atomicWriteFile(skillPath, normalized);

    await atomicWriteFile(
      metaPath,
      JSON.stringify(
        {
          sourceKind: 'conversation',
          status: 'promoted',
          promotedAt,
          sourceCandidateId: candidateId,
          sourceSessionKey: evidence.sourceSessionKey,
          toolNames: evidence.toolNames,
          gate: evidence.gate,
          ...(confidence !== undefined ? { confidence } : {}),
          updatedAt: promotedAt,
        },
        null,
        2
      )
    );
  } catch (err) {
    const restoration = await Promise.allSettled([
      restoreOwnedFile(skillPath, previousSkill),
      restoreOwnedFile(metaPath, previousMeta),
    ]);
    if (!directoryExisted) {
      // Remove the directory only when it is still empty. Never recursively
      // delete a path that can contain files not owned by this promotion.
      try { await fs.promises.rmdir(skillDir); } catch { /* best effort */ }
    }
    const restoreErrors = restoration.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (restoreErrors.length > 0) {
      throw new AggregateError([err, ...restoreErrors], `skill promotion failed and restoration was incomplete: ${skillDir}`);
    }
    throw err;
  }

  await removeCandidate(workspaceDir, candidateId);

  const result: PromoteResult = {
    skillId,
    skillPath,
    candidateId,
    validation,
    confidence,
    promotedAt,
  };

  opts.onPromoted?.(result);

  return result;
}

function sanitizeSkillId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function restoreOwnedFile(filePath: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await fs.promises.rm(filePath, { force: true });
    return;
  }
  await atomicWriteFile(filePath, previous);
}

function generateMinimalSkillMd(evidence: SkillCandidateEvidence): string {
  const steps =
    evidence.toolCalls
      ?.map(
        (call, i) =>
          `${i + 1}. \`${call.name}\`${Object.keys(call.input).length > 0 ? ` — ${Object.keys(call.input).slice(0, 3).join(', ')}` : ''}`
      )
      .join('\n') ?? '';

  return `---
name: 对话沉淀 ${evidence.userMessage.slice(0, 40)}
description: 从一次宿主对话沉淀的可复用流程
stable_id: learned-${sanitizeSkillId(evidence.candidateId)}
summary: ${JSON.stringify(evidence.userMessage.slice(0, 160))}
version: 1.0.0
trigger: ${[evidence.candidateId, ...evidence.toolNames, '对话沉淀'].join(',')}
risk: low
permissions: workspace_read
delegate_preference: local
requires_board: false
approval_level: confirm
cooldown_seconds: 0
category: Conversation
visible_in_empty: false
primary_intent: other
example_query: ${JSON.stringify(evidence.userMessage.slice(0, 120))}
---

# 对话沉淀技能

## 执行流程
${steps}

## 沉淀来源
- 来源会话：${evidence.sourceSessionKey}
- 沉淀门槛：${evidence.gate}
- 沉淀时间：${new Date(evidence.createdAt).toISOString()}
- 原始需求：${evidence.userMessage.slice(0, 300)}
`;
}
