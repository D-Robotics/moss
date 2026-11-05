#!/usr/bin/env node
/**
 * B66 probe: a model window too small for the standard surface (Ollama's 4096
 * default) used to fail the first turn outright -- the ~4.3k-token lean tool
 * surface alone exceeded the window, so the gateway rejected every request with
 * a context-length error.
 *
 * No model call: the surface, the output budget, and the deterministic summary
 * bound are pure.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { builtinTools } = await import(pathToFileURL(path.join(root, 'dist/tools/builtin.js')).href);
const { TINY_WINDOW_AUTO_CONTEXT_TOKENS, TINY_WINDOW_TOOL_NAMES, tinyWindowToolSurfaceEnabled } =
  await import(pathToFileURL(path.join(root, 'dist/core/tools/tiny-window-tools.js')).href);
const { resolveModelOutputBudget } = await import(
  pathToFileURL(path.join(root, 'dist/core/loop/output-limit.js')).href
);
const { getEffectiveContextWindowTokens } = await import(
  pathToFileURL(path.join(root, 'dist/context/window-economics.js')).href
);
const { buildDeterministicCompactionSummary } = await import(
  pathToFileURL(path.join(root, 'dist/context/deterministic-summary.js')).href
);

// A 4096 window reserves 682 output tokens, leaving 3414 prompt tokens.
const tinyBudget = getEffectiveContextWindowTokens(
  4096,
  resolveModelOutputBudget({
    modelId: 'unknown-model',
    contextTokens: 4096,
  }).initial
);
assert.ok(tinyBudget > 3000, `4096 window prompt budget ${tinyBudget} must leave room for tools`);
assert.equal(tinyWindowToolSurfaceEnabled({ effectiveContextTokens: tinyBudget }), true);
// 8192 keeps the standard surface (it fits: ~4.3k + 2048 output).
assert.equal(
  tinyWindowToolSurfaceEnabled({
    effectiveContextTokens: getEffectiveContextWindowTokens(8192, 2048),
  }),
  false
);
// Env override works both ways.
assert.equal(
  tinyWindowToolSurfaceEnabled({
    effectiveContextTokens: 200_000,
    env: { MOSS_TINY_WINDOW_TOOLS: '1' },
  }),
  true
);
assert.equal(
  tinyWindowToolSurfaceEnabled({
    effectiveContextTokens: 3_000,
    env: { MOSS_TINY_WINDOW_TOOLS: '0' },
  }),
  false
);
assert.ok(TINY_WINDOW_AUTO_CONTEXT_TOKENS <= 6_000);

// The surface is small enough to leave the window room for a real turn.
const declared = [...TINY_WINDOW_TOOL_NAMES];
assert.ok(declared.length <= 5, `tiny surface must stay minimal, got ${declared.length}`);
const names = new Set(
  (typeof builtinTools === 'function' ? builtinTools({ workspaceDir: root }) : builtinTools).map(
    (tool) => tool.name
  )
);
for (const name of declared)
  assert.ok(names.has(name), `tiny surface names an unknown tool: ${name}`);

// Output budget follows the window: a sixth under 6k, a quarter above it.
assert.equal(
  resolveModelOutputBudget({ modelId: 'unknown-model', contextTokens: 4096 }).initial,
  682
);
assert.equal(
  resolveModelOutputBudget({ modelId: 'unknown-model', contextTokens: 8192 }).initial,
  2048
);
assert.equal(
  resolveModelOutputBudget({ modelId: 'unknown-model', contextTokens: 32000 }).initial,
  8000
);

// A tiny-window compaction summary is bounded to a slice of the window.
const messages = Array.from({ length: 30 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `${'x'.repeat(300)} turn ${index}`,
}));
const bounded = buildDeterministicCompactionSummary(messages, 'tiny window', { maxChars: 2456 });
assert.ok(
  bounded.length <= 2456,
  `deterministic summary ${bounded.length} exceeds its window budget`
);

console.log(
  `[tiny-window-surface] ok: 4096 window -> ${tinyBudget} prompt tokens / 682 output, ` +
    `${declared.length} core tools (${declared.join(', ')}), summary bounded to 2456 chars`
);
