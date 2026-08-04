import type {
  SkillCandidateScore,
  SkillComposeInput,
  SkillComposer,
  SkillComposerPlanProvider,
  SkillPlan,
} from './composer-types.js';
import { retrieveSkillCandidates } from './skill-retriever.js';

export interface OpenVocabularySelection {
  skills: Array<{ name?: string; stableId?: string; score?: number; reason?: string }>;
  confidence?: number;
}

export type OpenVocabularySelector = (params: {
  task: string;
  environment: SkillComposeInput['environment'];
  candidates: SkillCandidateScore[];
  signal?: AbortSignal;
}) => Promise<OpenVocabularySelection>;

export class OpenVocabularySkillComposerAdapter implements SkillComposer {
  readonly provider: 'local-model' | 'remote-model';

  constructor(
    provider: 'local-model' | 'remote-model',
    private readonly selector: OpenVocabularySelector,
    private readonly candidateLimit = 12,
  ) {
    this.provider = provider;
  }

  async compose(input: SkillComposeInput, signal?: AbortSignal): Promise<SkillPlan> {
    const startedAt = Date.now();
    const retrieval = retrieveSkillCandidates({
      task: input.task,
      skills: input.skills,
      environment: input.environment,
      registryDigest: input.registryDigest,
      limit: this.candidateLimit,
    });
    const candidates: SkillCandidateScore[] = retrieval.candidates.map(
      ({ stableId, name, score, reasonCodes }) => ({ stableId, name, score, reasonCodes }),
    );
    const allowedById = new Map(candidates.map((candidate) => [candidate.stableId.toLowerCase(), candidate]));
    const allowedByName = new Map(candidates.map((candidate) => [candidate.name.toLowerCase(), candidate]));
    const selected = await this.selector({
      task: input.task,
      environment: input.environment,
      candidates,
      ...(signal ? { signal } : {}),
    });
    const seen = new Set<string>();
    const planned = [];
    for (const choice of selected.skills ?? []) {
      const candidate = choice.stableId
        ? allowedById.get(choice.stableId.toLowerCase())
        : choice.name
          ? allowedByName.get(choice.name.toLowerCase())
          : undefined;
      if (!candidate) throw new Error(`Provider returned unknown skill ${choice.stableId ?? choice.name ?? '<empty>'}`);
      if (seen.has(candidate.stableId)) continue;
      seen.add(candidate.stableId);
      planned.push({
        stableId: candidate.stableId,
        name: candidate.name,
        score: typeof choice.score === 'number' ? choice.score : candidate.score,
        reasonCode: choice.reason?.slice(0, 120) || 'model-selection',
      });
      if (planned.length >= input.maxSkills) break;
    }
    return {
      skills: planned,
      confidence: Math.max(0, Math.min(1, selected.confidence ?? 0.5)),
      rejected: planned.length === 0,
      provider: this.provider as SkillComposerPlanProvider,
      diagnostics: {
        candidateScores: candidates,
        excluded: retrieval.excluded,
        registryDigest: input.registryDigest,
        latencyMs: Date.now() - startedAt,
      },
    };
  }
}
