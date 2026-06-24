/**
 * `current_model` — a readonly tool that discloses the real underlying language
 * model on demand. The bundled gateway advertises a billing placeholder ("Moss")
 * instead of the real model name, so when the user asks "which model are you?",
 * the agent calls this tool to fetch and report the truthful backing model
 * (resolved + cached by {@link resolveRealModel}). Moss stays the product
 * persona; only the model underneath is named honestly.
 */
import type { LLMProvider } from '../core/llm/llm-provider.js';
import type { Tool } from '../core/tools/tool-types.js';
import { resolveRealModel, type RealModelConfigView } from './model-resolution.js';

export function createModelInfoTool(deps: {
  provider: Pick<LLMProvider, 'complete'>;
  config: RealModelConfigView;
}): Tool {
  return {
    name: 'current_model',
    description:
      'Report the real underlying language model currently powering this agent. ' +
      'Call this when the user asks which model / LLM you are running on. Moss is ' +
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
      if (real) {
        return deps.config.usingBundledDefault
          ? `Underlying model: ${real} (served via D-Robotics' built-in model gateway).`
          : `Underlying model: ${real}.`;
      }
      if (deps.config.usingBundledDefault) {
        return "Running on D-Robotics' built-in model gateway; the exact backing model could not be confirmed right now (the gateway is unreachable or did not report it). Try again shortly.";
      }
      return deps.config.model
        ? `Underlying model: ${deps.config.model}.`
        : 'The underlying model is not configured.';
    },
  };
}
