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

// ── Prompt-level: a run that will not offer sub-agent tools must not advertise
// them. The run-level wiring (tiny window -> omitSubagentExperts) is proven by
// the 4096-window end-to-end probe recorded in the backlog. ───────────────────
const { MossAgent } = await import(
  pathToFileURL(path.join(root, 'dist/core/agent/moss-agent.js')).href
);
const { InMemorySessionStore } = await import(
  pathToFileURL(path.join(root, 'dist/core/session/session.js')).href
);
const promptAgent = new MossAgent({
  llmProvider: {
    id: 'scripted',
    displayName: 'scripted (offline)',
    capabilities: { streaming: true },
    async complete() {
      return { stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
    },
    async stream(_options, onEvent) {
      onEvent({ type: 'message_start' });
      onEvent({ type: 'message_delta', stopReason: 'end_turn' });
      onEvent({ type: 'message_stop' });
    },
  },
  sessionStore: new InMemorySessionStore(),
  baseSystemPrompt: 'You are an offline probe agent.',
  domainPrompt: false,
  enableSteering: false,
  enableFollowUpGuard: false,
  contextTokens: 4096,
});
let fullPrompt;
let trimmedPrompt;
let compactPrompt;
try {
  fullPrompt = promptAgent.buildSystemPrompt({});
  trimmedPrompt = promptAgent.buildSystemPrompt({ omitSubagentExperts: true });
  compactPrompt = promptAgent.buildSystemPrompt({
    omitSubagentExperts: true,
    compactGuidance: true,
  });
} finally {
  await promptAgent.close();
}
assert.ok(
  fullPrompt.includes('Available sub-agent experts'),
  'the standard prompt keeps the catalog'
);
assert.ok(
  !trimmedPrompt.includes('Available sub-agent experts'),
  'a run without sub-agent tools must not advertise them'
);
assert.ok(
  fullPrompt.length - trimmedPrompt.length > 400,
  `dropping the catalog must free real prompt budget, freed ${fullPrompt.length - trimmedPrompt.length}`
);
assert.ok(
  compactPrompt.includes('## Small-context mode'),
  'a small-context run gets the terse guidance section'
);
assert.ok(
  !compactPrompt.includes('## Tool Result Handling'),
  'the small-context prompt folds the tool-result section into the terse guidance'
);
assert.ok(
  fullPrompt.length - compactPrompt.length > 2_000,
  `the terse profile must free real prompt budget, freed ${fullPrompt.length - compactPrompt.length}`
);

// ── Tool results: a tiny window must not accept a result sized for a big one. ──
const { tinyWindowToolResultTokens } = await import(
  pathToFileURL(path.join(root, 'dist/context/window-economics.js')).href
);
const { truncateToolOutput } = await import(
  pathToFileURL(path.join(root, 'dist/context/tool-output-truncate.js')).href
);
assert.equal(tinyWindowToolResultTokens(4096), 409);
assert.equal(tinyWindowToolResultTokens(8000), undefined);
assert.equal(tinyWindowToolResultTokens(32000), undefined);
const bigOutput = 'x'.repeat(6000);
const tinyCapped = truncateToolOutput('exec', bigOutput, { contextWindowTokens: 4096 });
const wideKept = truncateToolOutput('exec', bigOutput, { contextWindowTokens: 32000 });
assert.ok(
  tinyCapped.length < 2200,
  `a 4096 window must cap a 6000-char result, got ${tinyCapped.length} chars`
);
assert.ok(tinyCapped.includes('tokens truncated'), 'the capped result must say what was dropped');
assert.equal(wideKept, bigOutput, 'a 32k window keeps the tool budget it had before');

// ── Startup notice: the user must be told the reduced profile is active. ─────
const { spawn } = await import('node:child_process');
const fs = await import('node:fs');
const os = await import('node:os');

async function bootStderr(contextTokens, extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-tiny-notice-'));
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({
      provider: 'openai-compatible',
      model: 'm',
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test',
      permissions: { defaultMode: 'full' },
      agent: { contextTokens },
    })
  );
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    MOSS_CONFIG_DIR: configDir,
    MOSS_NO_TUI: '1',
    MOSS_NO_RDK_DOCS: '1',
    MOSS_LANG: 'en',
    MOSS_TRUST_WORKSPACE: '1',
    ...extraEnv,
  };
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'dist/cli.js'), '-p', 'hi'], {
      cwd: home,
      env,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(home, { recursive: true, force: true });
      resolve(stderr);
    });
  });
}

const tinyStderr = await bootStderr(4096);
assert.ok(
  tinyStderr.includes('context window is small (4k tokens)'),
  `a 4096 window must announce the reduced profile, stderr was: ${tinyStderr.slice(0, 400)}`
);
assert.ok(tinyStderr.includes('5 core tools'), 'the notice must say the tool surface is reduced');
const wideStderr = await bootStderr(32_000);
assert.ok(
  !wideStderr.includes('context window is small'),
  'a 32k window must not print the tiny-window notice'
);
const forcedOffStderr = await bootStderr(4096, { MOSS_TINY_WINDOW_TOOLS: '0' });
assert.ok(
  !forcedOffStderr.includes('context window is small'),
  'MOSS_TINY_WINDOW_TOOLS=0 must not announce a profile it disabled'
);

console.log(
  `[tiny-window-surface] ok: 4096 window -> ${tinyBudget} prompt tokens / 682 output, ` +
    `${declared.length} core tools (${declared.join(', ')}), summary bounded to 2456 chars; ` +
    `sub-agent catalog freed ${fullPrompt.length - trimmedPrompt.length} prompt chars when the surface excludes it; ` +
    `4096 boot announces the reduced profile, 32k and forced-off boots do not; ` +
    `tool results capped to ${tinyWindowToolResultTokens(4096)} tokens at 4096, unchanged at 32k; ` +
    `small-context guidance frees ${fullPrompt.length - compactPrompt.length} chars`
);
