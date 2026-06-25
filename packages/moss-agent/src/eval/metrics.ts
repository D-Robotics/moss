/**
 * Built-in evaluation metrics for the Moss eval framework.
 *
 * Each metric scores a response against expected criteria,
 * returning a value between 0.0 (worst) and 1.0 (best).
 *
 * @public
 */
import { validateJsonSchema, type JsonSchema } from '../structured-output/schema-validator.js';

export interface MetricConfig {
  /** Human-readable name for the metric. */
  name: string;
  /** Weight in the overall score (default 1.0). */
  weight?: number;
  /** Additional configuration for the metric. */
  [key: string]: unknown;
}

export type MetricFn = (response: string, expected: unknown, config?: MetricConfig) => number;

/**
 * Exact string match metric.
 * Score: 1.0 if response contains expected string, 0.0 otherwise.
 */
export const exactMatchMetric: MetricFn = (response, expected, _config) => {
  const expectedStr = String(expected ?? '');
  if (!expectedStr) return 0;
  return response.includes(expectedStr) ? 1.0 : 0.0;
};

/**
 * Contains-all metric: response must contain all expected substrings.
 * Score: proportion of expected substrings found.
 */
export const containsAllMetric: MetricFn = (response, expected) => {
  const expectedArr = Array.isArray(expected) ? expected.map(String) : [String(expected ?? '')];
  const found = expectedArr.filter((s) => s && response.includes(s)).length;
  return expectedArr.length > 0 ? found / expectedArr.length : 0;
};

/**
 * Contains-any metric: response must contain at least one expected substring.
 * Score: 1.0 if any substring is found, 0.0 otherwise.
 */
export const containsAnyMetric: MetricFn = (response, expected) => {
  const expectedArr = Array.isArray(expected) ? expected.map(String) : [String(expected ?? '')];
  const lowerResponse = response.toLowerCase();
  const anyFound = expectedArr.some((s) => s && lowerResponse.includes(s.toLowerCase()));
  return anyFound ? 1.0 : 0.0;
};

/**
 * Semantic similarity metric using simple token overlap (Jaccard).
 * Score: Jaccard similarity between response tokens and expected tokens.
 */
export const semanticSimilarityMetric: MetricFn = (response, expected) => {
  const expectedStr = String(expected ?? '');
  if (!expectedStr) return 0;

  const respTokens = new Set(tokenize(response));
  const expectedTokens = new Set(tokenize(expectedStr));

  if (expectedTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of expectedTokens) {
    if (respTokens.has(token)) intersection++;
  }

  const union = respTokens.size + expectedTokens.size - intersection;
  return union > 0 ? intersection / union : 0;
};

/**
 * Tool usage metric: checks whether specified tools were invoked.
 * Expected: array of tool names that should have been called.
 * Score: proportion of expected tools that were invoked.
 */
export const toolUsageMetric: MetricFn = (response, expected, _config) => {
  // This metric is designed to be used with the toolCalls context
  // provided by the eval runner, not from the response text alone.
  // When used without tool context, falls back to checking for tool names in text.
  const expectedTools = Array.isArray(expected) ? expected.map(String) : [String(expected ?? '')];
  const found = expectedTools.filter((toolName) =>
    response.includes(toolName) || response.includes(`"${toolName}"`),
  ).length;
  return expectedTools.length > 0 ? found / expectedTools.length : 0;
};

/**
 * JSON Schema compliance metric.
 * Expected: a JSON Schema object.
 * Score: 1.0 if parsed response validates against schema, 0.0 otherwise.
 */
export const jsonSchemaMetric: MetricFn = (response, expected) => {
  if (!expected || typeof expected !== 'object') return 0;

  // Try to extract JSON from response
  const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const jsonStr = jsonMatch ? jsonMatch[1] : response;

  try {
    const parsed = JSON.parse(jsonStr.trim());
    const result = validateJsonSchema(parsed, expected as JsonSchema);
    return result.valid ? 1.0 : 0.0;
  } catch {
    return 0.0;
  }
};

/**
 * Tokenize text into lowercase word tokens for similarity comparison.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}
