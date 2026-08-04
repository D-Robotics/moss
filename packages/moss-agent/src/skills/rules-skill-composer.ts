import type { SkillComposerConfig, SkillComposeInput, SkillComposer, SkillPlan, PlannedSkill } from './composer-types.js';
import { retrieveSkillCandidates } from './skill-retriever.js';
import { expandRequiredSkills, orderPlannedSkills, resolveSkillConflicts } from './skill-dependency-graph.js';
import { validateSkillPlan } from './skill-plan-validation.js';

export class RulesSkillComposer implements SkillComposer {
  readonly provider = 'rules' as const;

  constructor(private readonly config: SkillComposerConfig) {}

  async compose(input: SkillComposeInput, signal?: AbortSignal): Promise<SkillPlan> {
    const startedAt = Date.now();
    if (signal?.aborted) throw signal.reason ?? new Error('Skill composition aborted');
    const retrieval = retrieveSkillCandidates({
      task: input.task,
      skills: input.skills,
      environment: input.environment,
      registryDigest: input.registryDigest,
      limit: this.config.candidateLimit,
    });
    const aboveThreshold = retrieval.candidates.filter((candidate) => candidate.score >= this.config.minScore);
    const selected: PlannedSkill[] = [];
    const topScore = aboveThreshold[0]?.score ?? 0;
    for (let index = 0; index < aboveThreshold.length && selected.length < input.maxSkills; index++) {
      const candidate = aboveThreshold[index];
      const previous = aboveThreshold[index - 1];
      const explicit = candidate.reasonCodes.some((reason) => reason !== 'tfidf');
      const relative = topScore === 0 ? 0 : candidate.score / topScore;
      const scoreGap = previous ? previous.score - candidate.score : 0;
      if (index > 0 && !explicit && (relative < 0.55 || scoreGap > 0.32)) break;
      selected.push({
        stableId: candidate.stableId,
        name: candidate.name,
        score: candidate.score,
        reasonCode: candidate.reasonCodes.join('+') || 'retrieval',
      });
    }
    const expanded = expandRequiredSkills(selected, input.skills, input.maxSkills);
    const conflictResult = resolveSkillConflicts(expanded, input.skills);
    const ordered = orderPlannedSkills(conflictResult.skills, input.skills);
    const secondScore = retrieval.candidates[1]?.score ?? 0;
    const confidence = ordered.skills.length === 0
      ? Math.max(0, 1 - topScore)
      : Math.min(1, topScore * 0.8 + Math.max(0, topScore - secondScore) * 0.2);
    const plan: SkillPlan = {
      skills: ordered.skills,
      confidence,
      rejected: ordered.skills.length === 0,
      provider: 'rules',
      diagnostics: {
        candidateScores: retrieval.candidates.map(({ stableId, name, score, reasonCodes }) => ({
          stableId,
          name,
          score,
          reasonCodes,
        })),
        excluded: retrieval.excluded,
        warnings: [...conflictResult.warnings, ...ordered.warnings],
        registryDigest: input.registryDigest,
        latencyMs: Date.now() - startedAt,
      },
    };
    const validation = validateSkillPlan(plan, input);
    if (!validation.valid) {
      return {
        skills: [],
        confidence: 0,
        rejected: true,
        provider: 'rules',
        diagnostics: {
          ...plan.diagnostics,
          warnings: [...(plan.diagnostics?.warnings ?? []), ...validation.errors],
          fallbackReason: 'rules-plan-validation-failed',
        },
      };
    }
    return plan;
  }
}
