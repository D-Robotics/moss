








import type { LLMProvider } from '../core/llm/llm-provider.js';
import type { Tool } from '../core/tools/tool-types.js';
import { resolveRealModel, type RealModelConfigView } from './model-resolution.js';

export function createModelInfoTool(deps: {
  provider: Pick<LLMProvider, 'complete'>;
  config: RealModelConfigView;
  /** Dynamic getter for the current probed context window (may update after startup probe). */
  getContextTokens?: () => number | undefined;
}): Tool {
  return {
    name: 'current_model',
    description:
      'Report the real underlying language model currently powering this agent, including its context window size. ' +
      'Call this when the user asks which model / LLM you are running on, or how large the context window is. Moss is ' +
      'the product name, not the model — this returns the actual backing model ' +
      '(the built-in gateway serves it under a placeholder name).',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      transientRetry: true,
    },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const real = await resolveRealModel(deps.provider, deps.config);
      const ctxTokens = deps.getContextTokens?.();
      const ctxLine = ctxTokens && ctxTokens > 0
        ? ` Context window: ${(ctxTokens / 1000).toFixed(0)}k tokens.`
        : '';
      if (real) {
        return deps.config.usingBundledDefault
          ? `Underlying model: ${real} (served via D-Robotics' built-in model gateway).${ctxLine}`
          : `Underlying model: ${real}.${ctxLine}`;
      }
      if (deps.config.usingBundledDefault) {
        return `Running on D-Robotics' built-in model gateway; the exact backing model could not be confirmed right now (the gateway is unreachable or did not report it). Try again shortly.${ctxLine}`;
      }
      return deps.config.model
        ? `Underlying model: ${deps.config.model}.${ctxLine}`
        : `The underlying model is not configured.${ctxLine}`;
    },
  };
}
