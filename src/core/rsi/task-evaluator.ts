import type { RsiLearningProvider } from './engine.js';
import { rsiPublicCase } from './learning.js';
import { RsiError } from './store.js';
import type { RsiAdapter, RsiEvaluation, RsiLearningBudget, RsiMetrics } from './types.js';

/** Labels, split identifiers and private execution IDs never enter the task actor. */
export interface RsiTaskInput {
  input: string;
  evidence: ReturnType<typeof rsiPublicCase>['observed'];
}
export interface RsiTaskRunResult {
  /** Must come from the host's independent task verifier, not model prose. */
  passed: boolean;
  reason: string;
  metrics?: RsiMetrics;
  spend: NonNullable<RsiEvaluation['spend']>;
}
export type RsiTaskRunner = (input: {
  adapter: RsiAdapter;
  task: RsiTaskInput;
  budget: RsiLearningBudget;
}) => Promise<RsiTaskRunResult>;

/** Pairs real host task executions without introducing another agent loop. */
export function createRsiTaskEvaluator(options: {
  model: string;
  evaluatorVersion: string;
  runCase: RsiTaskRunner;
}): RsiLearningProvider['evaluate'] {
  const { model, evaluatorVersion, runCase } = options;
  if (
    typeof model !== 'string' ||
    !model.trim() ||
    typeof evaluatorVersion !== 'string' ||
    !evaluatorVersion.trim() ||
    typeof runCase !== 'function'
  )
    throw new RsiError('learner_configuration_invalid', 503);
  return async ({ baseline, candidate, cases, budget }) => {
    const armCount = cases.length * 2;
    if (!armCount || !Number.isSafeInteger(budget.maxModelCalls) || budget.maxModelCalls < armCount)
      throw new RsiError('learning_budget_insufficient');
    const perArmLimit = Math.floor(budget.maxModelCalls / armCount);
    let remainingArms = armCount;
    let modelCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageKnown = true;
    const results = [];
    for (const [index, item] of cases.entries()) {
      const publicCase = rsiPublicCase(item);
      const task: RsiTaskInput = { input: publicCase.task, evidence: publicCase.observed };
      const arms =
        index % 2 ? (['candidate', 'baseline'] as const) : (['baseline', 'candidate'] as const);
      const outcomes: Partial<Record<'candidate' | 'baseline', RsiTaskRunResult>> = {};
      for (const arm of arms) {
        const maxModelCalls = Math.min(
          perArmLimit,
          Math.floor((budget.maxModelCalls - modelCalls) / remainingArms)
        );
        if (maxModelCalls < 1) throw new RsiError('learning_budget_insufficient');
        const allocated = Object.freeze({ maxModelCalls, maxOutputTokens: budget.maxOutputTokens });
        let result: RsiTaskRunResult;
        try {
          result = await runCase({
            adapter: structuredClone(arm === 'baseline' ? baseline : candidate),
            task: structuredClone(task),
            budget: allocated,
          });
        } catch (cause) {
          throw new RsiError('rsi_task_evaluation_failed', 503, cause);
        }
        const actual = result.spend?.modelCalls;
        if (
          typeof result.passed !== 'boolean' ||
          typeof result.reason !== 'string' ||
          !Number.isSafeInteger(actual) ||
          actual < 0 ||
          actual > allocated.maxModelCalls ||
          (result.metrics?.modelCalls !== undefined && result.metrics.modelCalls !== actual)
        )
          throw new RsiError('invalid_task_evaluation_result', 422);
        modelCalls += actual;
        remainingArms -= 1;
        if (
          result.spend.inputTokens !== undefined &&
          result.spend.outputTokens !== undefined &&
          Number.isSafeInteger(result.spend.inputTokens) &&
          result.spend.inputTokens >= 0 &&
          Number.isSafeInteger(result.spend.outputTokens) &&
          result.spend.outputTokens >= 0
        ) {
          inputTokens += result.spend.inputTokens;
          outputTokens += result.spend.outputTokens;
        } else usageKnown = false;
        outcomes[arm] = structuredClone(result);
      }
      const left = outcomes.baseline!;
      const right = outcomes.candidate!;
      results.push({
        caseId: item.id,
        split: item.split,
        baselinePassed: left.passed,
        candidatePassed: right.passed,
        baselineMetrics: { ...left.metrics, modelCalls: left.spend.modelCalls },
        candidateMetrics: { ...right.metrics, modelCalls: right.spend.modelCalls },
        reason: right.passed ? 'task_oracle_passed' : 'task_oracle_failed',
      });
    }
    return {
      model,
      evaluatorVersion,
      results,
      spend: { modelCalls, ...(usageKnown ? { inputTokens, outputTokens } : {}) },
    };
  };
}
