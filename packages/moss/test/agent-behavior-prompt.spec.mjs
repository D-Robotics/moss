#!/usr/bin/env node
/**
 * @rdk-moss/core — buildAgentBehaviorPrompt content unit test
 *
 * Verifies that "engineering methodology is baked into the always-injected
 * general behavior layer" holds, and guards against regressions that would drop
 * the five original sections (communication / code-change / faithful reporting /
 * careful execution / long-term memory) or the added "problem-solving method".
 *
 * Run after package build:
 *   npm run build -w @rdk-moss/core && node packages/moss/test/agent-behavior-prompt.spec.mjs
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { buildAgentBehaviorPrompt, buildAgentBehaviorPromptQuick } = mod;

assert.equal(typeof buildAgentBehaviorPrompt, 'function', 'buildAgentBehaviorPrompt should be exported');
assert.equal(typeof buildAgentBehaviorPromptQuick, 'function', 'buildAgentBehaviorPromptQuick should be exported');

// ── Full version ──
const full = buildAgentBehaviorPrompt();
assert.equal(typeof full, 'string', 'should return a string');
assert.ok(full.length > 200, 'should be a substantive prompt');
assert.match(full, /explicit requirements as a completion checklist/i);
assert.match(full, /failure-path invariant/i);

const fullMust = [
  '## General Agent Behavior Contract',
  // The five original sections (regression guard)
  '### Communication style',
  '### Code-change discipline',
  '### Faithful reporting',
  '### Careful execution',
  '### Long-term memory',
  // Added: problem-solving method
  '### Problem-solving method',
  'Think before you act',
  'Troubleshoot systematically',
  'root cause',
  'regression check',
  'Close the loop',
  'Tell it straight',
  'reproduce',
  'Brainstorm complex solutions',
  'Use skills proactively',
  'superpower',
  'Dispatch multiple agents',
  'do not treat an empty result as success',
  'fast path',
  'under N lines',
  'fan_out_subagents',
  'Ctrl+V',
  'paste a local file path',
  'external agent / subprocess',
  'Distill experience into capabilities',
  'capability pack',
  'prompt layer',
  // The directive itself must read as English (no CJK in the prose).
];
for (const marker of fullMust) {
  assert.ok(full.includes(marker), `full behavior contract should include "${marker}"`);
}
assert.ok(!/[一-鿿]/.test(full), 'the behavior contract prose should be English (no CJK)');

// The three methods should appear as ordered sections: think → systematic → close the loop.
const idxThink = full.indexOf('Think before you act');
const idxDebug = full.indexOf('Troubleshoot systematically');
const idxVerify = full.indexOf('Close the loop');
assert.ok(
  idxThink > 0 && idxDebug > idxThink && idxVerify > idxDebug,
  'the three methods should appear in order: think → systematic → close the loop',
);

// ── Brief version ──
const quick = buildAgentBehaviorPromptQuick();
assert.equal(typeof quick, 'string', 'brief version should return a string');
assert.ok(quick.length > 80, 'brief version should have content');

// Moss-specific contracts that the model cannot infer from training —
// these must be present in the compact version regardless of restructuring.
// General engineering practices (root cause, regression check, fast path,
// problem-solving) and TUI-specific hints (Ctrl+V, [Image #n]) are NOT
// required here: TUI hints belong in the session-specific dynamic layer;
// engineering practices are baseline LLM capability.
for (const marker of [
  'tell it straight',  // faithful-reporting: separate fact/inference/assumption
  'close the loop',    // verification before done
  'superpower',        // Moss skill ecosystem
  'subagents',         // multi-agent dispatch
  'memory_read',       // Moss memory tool
  'memory_write',      // Moss memory tool
  'Runtime guard',     // no-GUI-terminal safety (headless/board targets)
  'coercion bug',      // boundary parsing: cover the bug class, not one example
  'non-finite',        // NaN/Infinity-style numeric boundary cases
  'exact expected value', // avoid property assertions that accept wrong coercions
  'cannot verify workspace-specific facts',
  'do not replace evidence with a plausible guess',
  'todo_write',        // multi-step external checklist (CC/Codex parity)
  'same turn',         // parallel independent tool calls
  'Stay on the task',  // do not stop mid-request
  'Keep going until',  // Grok autonomy: finish before yielding
  'preamble',          // Grok-style brief status with tool calls
  'notified when a background command finishes', // wired completion reminders
  'Real verification', // dedicated tools / verification-shaped exec only
  'never claim success against red output',
]) {
  assert.ok(quick.includes(marker), `brief behavior contract should include Moss contract keyword "${marker}"`);
}
assert.ok(!/[一-鿿]/.test(quick), 'the brief behavior contract prose should be English (no CJK)');

console.log('[agent-behavior-prompt.spec] PASS');
