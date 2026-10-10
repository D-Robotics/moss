import { isOutputLimitStopReason } from '../../provider/output-limit.js';

export { isOutputLimitStopReason };

/** First-turn cap for a gateway model Moss does not recognize. */
export const UNKNOWN_MODEL_DEFAULT_OUTPUT_TOKENS = 16_384;

/** Escalation ceiling for a gateway model Moss does not recognize. */
export const UNKNOWN_MODEL_MAX_OUTPUT_TOKENS = 65_536;

const MIN_OUTPUT_TOKENS = 2_048;

export interface ModelOutputLimit {
  /** Lowercase model-id prefix. The longest match wins. */
  prefix: string;
  defaultTokens: number;
  maxTokens: number;
}

/**
 * Known per-response output ceilings. Defaults are high enough that a
 * reasoning model can finish a visible answer; escalation may rise as far
 * as `maxTokens`. A config override (`agent.models.<id>.maxOutputTokens`)
 * replaces both numbers for that model.
 */
export const KNOWN_MODEL_OUTPUT_LIMITS: readonly ModelOutputLimit[] = [
  { prefix: 'glm-5', defaultTokens: 32_768, maxTokens: 65_536 },
  { prefix: 'glm-4.7', defaultTokens: 16_384, maxTokens: 32_768 },
  { prefix: 'glm-4.6', defaultTokens: 16_384, maxTokens: 32_768 },
  { prefix: 'glm-4.5', defaultTokens: 16_384, maxTokens: 32_768 },
  { prefix: 'glm', defaultTokens: 8_192, maxTokens: 16_384 },
  { prefix: 'claude-opus-4', defaultTokens: 32_768, maxTokens: 64_000 },
  { prefix: 'claude-sonnet-4', defaultTokens: 32_768, maxTokens: 64_000 },
  { prefix: 'claude-haiku-4', defaultTokens: 32_768, maxTokens: 64_000 },
  { prefix: 'claude-3-5', defaultTokens: 8_192, maxTokens: 8_192 },
  { prefix: 'claude-3.5', defaultTokens: 8_192, maxTokens: 8_192 },
  { prefix: 'claude', defaultTokens: 16_384, maxTokens: 64_000 },
  { prefix: 'gpt-5', defaultTokens: 32_768, maxTokens: 128_000 },
  { prefix: 'gpt-4.1', defaultTokens: 32_768, maxTokens: 32_768 },
  { prefix: 'gpt-4o', defaultTokens: 16_384, maxTokens: 16_384 },
  { prefix: 'o4', defaultTokens: 32_768, maxTokens: 100_000 },
  { prefix: 'o3', defaultTokens: 32_768, maxTokens: 100_000 },
  { prefix: 'o1', defaultTokens: 32_768, maxTokens: 100_000 },
  { prefix: 'deepseek-reasoner', defaultTokens: 16_384, maxTokens: 65_536 },
  { prefix: 'deepseek-r1', defaultTokens: 16_384, maxTokens: 65_536 },
  { prefix: 'deepseek', defaultTokens: 8_192, maxTokens: 8_192 },
  { prefix: 'qwq', defaultTokens: 16_384, maxTokens: 32_768 },
  { prefix: 'qwen3', defaultTokens: 16_384, maxTokens: 32_768 },
  { prefix: 'qwen', defaultTokens: 8_192, maxTokens: 8_192 },
  { prefix: 'gemini-2.5', defaultTokens: 32_768, maxTokens: 65_536 },
  { prefix: 'gemini-3', defaultTokens: 32_768, maxTokens: 65_536 },
  { prefix: 'gemini', defaultTokens: 8_192, maxTokens: 8_192 },
];

const LIMITS_BY_SPECIFICITY = [...KNOWN_MODEL_OUTPUT_LIMITS].sort(
  (a, b) => b.prefix.length - a.prefix.length
);

function bareModelId(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

function idHasPrefix(id: string, prefix: string): boolean {
  if (id === prefix) return true;
  if (!id.startsWith(prefix)) return false;
  const next = id.charAt(prefix.length);
  return next === '-' || next === '.' || next === '/' || next === ':';
}

function modelMatchesPrefix(modelId: string, prefix: string): boolean {
  const id = modelId.trim().toLowerCase();
  const p = prefix.trim().toLowerCase();
  if (!id || !p) return false;
  return idHasPrefix(id, p) || idHasPrefix(bareModelId(id), p);
}

export function lookupKnownModelOutputLimit(
  modelId: string | undefined
): ModelOutputLimit | undefined {
  if (!modelId?.trim()) return undefined;
  return LIMITS_BY_SPECIFICITY.find((entry) => modelMatchesPrefix(modelId, entry.prefix));
}

export function lookupModelOutputOverride(
  modelId: string | undefined,
  overrides: Readonly<Record<string, number>> | undefined
): number | undefined {
  if (!modelId?.trim() || !overrides) return undefined;
  const direct = overrides[modelId] ?? overrides[modelId.trim()];
  if (typeof direct === 'number' && direct > 0) return direct;
  const id = modelId.trim().toLowerCase();
  const ranked = Object.entries(overrides)
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of ranked) {
    if (key.trim().toLowerCase() === id) return value;
    if (modelMatchesPrefix(modelId, key)) return value;
  }
  return undefined;
}

function positive(value: number): number {
  return Math.max(1, Math.floor(value));
}

/** Upper bound that still leaves the prompt some of the context window. */
function clampToContext(tokens: number, contextTokens: number | undefined): number {
  if (!contextTokens || contextTokens <= 0) return positive(tokens);
  const ceiling = Math.max(MIN_OUTPUT_TOKENS, contextTokens - 1_024);
  return Math.min(Math.max(positive(tokens), MIN_OUTPUT_TOKENS), ceiling);
}

export interface ResolveModelOutputBudgetInput {
  modelId?: string;
  contextTokens?: number;
  /** Explicit per-call cap (user pin, derived default, or test fixture). */
  configured?: number;
  /** When true, `configured` is a user pin and recovery will not raise it. */
  pinned?: boolean;
  /** Per-model config overrides. Wins over the pin and the built-in table. */
  overrides?: Readonly<Record<string, number>>;
}

export interface ResolvedModelOutputBudget {
  initial: number;
  ceiling: number;
}

/**
 * Starting output cap and the ceiling automatic recovery may escalate to.
 * A per-model config override is both. A user pin is both. Otherwise the
 * start is `configured` when the caller already chose one, and the ceiling
 * is the model's known maximum (or the unknown-gateway ceiling).
 */
export function resolveModelOutputBudget(
  input: ResolveModelOutputBudgetInput
): ResolvedModelOutputBudget {
  const override = lookupModelOutputOverride(input.modelId, input.overrides);
  if (override !== undefined) {
    const tokens = clampToContext(override, input.contextTokens);
    return { initial: tokens, ceiling: tokens };
  }
  const known = lookupKnownModelOutputLimit(input.modelId);
  const tableDefault = known?.defaultTokens ?? UNKNOWN_MODEL_DEFAULT_OUTPUT_TOKENS;
  const tableMax = known?.maxTokens ?? UNKNOWN_MODEL_MAX_OUTPUT_TOKENS;
  if (input.configured !== undefined && input.configured > 0) {
    const initial = positive(input.configured);
    if (input.pinned) return { initial, ceiling: initial };
    const ceiling = Math.max(initial, clampToContext(tableMax, input.contextTokens));
    return { initial, ceiling };
  }
  const initial = clampToContext(tableDefault, input.contextTokens);
  const ceiling = Math.max(initial, clampToContext(tableMax, input.contextTokens));
  return { initial, ceiling };
}

/** Double the cap (at least +4096) without passing the model's ceiling. */
export function escalateOutputTokens(current: number, ceiling: number): number {
  const cur = positive(current);
  const cap = Math.max(cur, positive(ceiling));
  if (cur >= cap) return cur;
  return Math.min(cap, Math.max(cur + 4_096, cur * 2));
}

/** Join a truncated visible prefix with the continuation. No extra separator. */
export function stitchTruncatedOutput(carried: string, piece: string): string {
  if (!carried) return piece;
  if (!piece) return carried;
  return `${carried}${piece}`;
}
