







import { validateJsonSchema, type JsonSchema } from '../structured-output/schema-validator.js';

export interface MetricConfig {
  
  name: string;
  
  weight?: number;
  
  [key: string]: unknown;
}

export type MetricFn = (response: string, expected: unknown, config?: MetricConfig) => number;





export const exactMatchMetric: MetricFn = (response, expected, _config) => {
  const expectedStr = String(expected ?? '');
  if (!expectedStr) return 0;
  // Exact match — response must equal expected (ignoring surrounding
  // whitespace). The previous `response.includes(expectedStr)` was a substring
  // test: "pineapple" matched "apple" with score 1.0. Substring matching is
  // what containsAll/containsAny are for; exactMatch must actually be exact.
  return response.trim() === expectedStr.trim() ? 1.0 : 0.0;
};





export const containsAllMetric: MetricFn = (response, expected) => {
  const expectedArr = Array.isArray(expected) ? expected.map(String) : [String(expected ?? '')];
  const found = expectedArr.filter((s) => s && response.includes(s)).length;
  return expectedArr.length > 0 ? found / expectedArr.length : 0;
};





export const containsAnyMetric: MetricFn = (response, expected) => {
  const expectedArr = Array.isArray(expected) ? expected.map(String) : [String(expected ?? '')];
  const lowerResponse = response.toLowerCase();
  const anyFound = expectedArr.some((s) => s && lowerResponse.includes(s.toLowerCase()));
  return anyFound ? 1.0 : 0.0;
};





export const tokenOverlapMetric: MetricFn = (response, expected) => {
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






export const toolUsageMetric: MetricFn = (response, expected, _config) => {
  
  
  
  const expectedTools = Array.isArray(expected) ? expected.map(String) : [String(expected ?? '')];
  const found = expectedTools.filter(
    (toolName) => response.includes(toolName) || response.includes(`"${toolName}"`)
  ).length;
  return expectedTools.length > 0 ? found / expectedTools.length : 0;
};






export const jsonSchemaMetric: MetricFn = (response, expected) => {
  if (!expected || typeof expected !== 'object') return 0;

  
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




function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}
