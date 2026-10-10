import type { LLMProvider } from '../core/llm/llm-provider.js';
import type { Tool } from '../core/tools/tool-types.js';
import {
  reportedModelMatchesConfigured,
  resolveRealModel,
  type RealModelConfigView,
} from './model-resolution.js';

export function createModelInfoTool(deps: {
  provider: () => Pick<LLMProvider, 'complete'>;
  config: () => RealModelConfigView;
  /** Dynamic getter for the current probed context window (may update after startup probe). */
  getContextTokens?: () => number | undefined;
  /** Dynamic getter for the current max output tokens (derived from context window or user-pinned). */
  getMaxOutputTokens?: () => number | undefined;
  /** Model id from the latest gateway response, when the provider sent one. */
  getReportedModel?: () => string | undefined;
}): Tool {
  return {
    name: 'current_model',
    description:
      'Return the real model id, context window, and max output length. Call this when asked which model you are. Moss is the product name, not the model.',
    metadata: {
      sideEffectClass: 'readonly',
      planMode: 'allow',
      transientRetry: true,
    },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      const provider = deps.provider();
      const config = deps.config();
      const real = await resolveRealModel(provider, config);
      const ctxTokens = deps.getContextTokens?.();
      const maxOut = deps.getMaxOutputTokens?.();
      const ctxLine =
        ctxTokens && ctxTokens > 0
          ? ` Context window: ${(ctxTokens / 1000).toFixed(0)}k tokens.`
          : '';
      const outLine =
        maxOut && maxOut > 0
          ? ` Max output per response: ${(maxOut / 1000).toFixed(0)}k tokens.`
          : '';
      const configured = config.model?.trim();
      const reported = deps.getReportedModel?.()?.trim();
      if (config.usingBundledDefault) {
        return real
          ? `Underlying model: ${real} (served via the built-in model gateway).${ctxLine}${outLine}`
          : `Running on the built-in model gateway; the exact backing model could not be confirmed right now (the gateway is unreachable or did not report it). Try again shortly.${ctxLine}${outLine}`;
      }
      if (reported && configured && !reportedModelMatchesConfigured(configured, reported)) {
        return `Underlying model: configured ${configured}, gateway reported ${reported}.${ctxLine}${outLine}`;
      }
      if (real) {
        return `Underlying model: ${real}.${ctxLine}${outLine}`;
      }
      return config.model
        ? `Underlying model: ${config.model}.${ctxLine}${outLine}`
        : `The underlying model is not configured.${ctxLine}${outLine}`;
    },
  };
}
