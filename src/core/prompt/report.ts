import crypto from 'node:crypto';
import type { PromptLayerSpec, PromptLayersPort } from '../../contracts/prompt-layer.js';

/** Short hash of one layer's text; 12 hex chars matches the prompt telemetry style. */
export function hashPromptLayerText(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Per-layer hashes plus the number of declared layers.
 *
 * Before this, `run_metrics.systemPromptLayerCount` was always 0 and the
 * combined-hash fallback passed an empty id list (audit §3.2), so a prompt change
 * could not be attributed to the layer that changed. The loop only needs ids and
 * short hashes; the text stays in the agent.
 */
export function summarizePromptLayers(layers: PromptLayersPort | undefined): {
  layerCount: number;
  layerHashes: Record<string, string>;
} {
  if (!layers) return { layerCount: 0, layerHashes: {} };
  const specs: readonly PromptLayerSpec[] = layers.specs();
  const layerHashes: Record<string, string> = {};
  let layerCount = 0;
  for (const spec of specs) {
    if (!spec.text) continue;
    layerHashes[spec.id] = hashPromptLayerText(spec.text);
    layerCount += 1;
  }
  return { layerCount, layerHashes };
}
