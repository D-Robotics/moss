#!/usr/bin/env node
/**
 * Deterministic probe for the checkpoint structure check (backlog B03).
 *
 * The nine-section summary contract used to be prompt-only: a model that
 * dropped `## 6.` was accepted, and the hole propagated into every later
 * compaction. These checks pin the validator and the single bounded retry
 * against the real `buildCompactionSummary` path with a stub summarizer.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { buildCompactionSummary } = await import(
  pathToFileURL(path.join(root, 'dist/context/compaction.js')).href
);
const validate = await import(
  pathToFileURL(path.join(root, 'dist/context/summary-validate.js')).href
);

let checks = 0;
function ok(name) {
  checks += 1;
  console.log(`[compaction-summary] ok ${name}`);
}

const TITLES = [
  '历史脉络',
  '主要目标',
  '关键决策与约束',
  '已完成的工作',
  '当前进行中',
  '待办事项',
  '设备与环境状态',
  '关键文件与路径',
  '错误与问题',
  '后续工作所需上下文',
];
function validSummary(marker = 'VALID') {
  return `<summary>\n${TITLES.map((title, index) => `## ${index}. ${title}\n（无）`).join('\n')}\n${marker}\n</summary>`;
}
function summaryMissing(section) {
  return `<summary>\n${TITLES.map((title, index) =>
    index === section ? '' : `## ${index}. ${title}\n（无）`
  )
    .filter(Boolean)
    .join('\n')}\n</summary>`;
}

const messages = [
  { role: 'user', content: 'please fix the build', timestamp: 1 },
  { role: 'assistant', content: 'looking at it', timestamp: 2 },
  { role: 'user', content: 'the error is in calc.js', timestamp: 3 },
];

async function summarizeWith(sequence) {
  const calls = [];
  const summarize = async (params) => {
    calls.push(params.userPrompt);
    const next = sequence[calls.length - 1];
    if (next === undefined) throw new Error('probe: unexpected extra summarize call');
    return next;
  };
  const summary = await buildCompactionSummary({
    summarize,
    messages,
    contextWindowTokens: 128_000,
  });
  return { summary, calls };
}

// ── 1. The validator itself ────────────────────────────────────────────────

const complete = validate.validateSummaryStructure(validSummary());
assert.equal(complete.ok, true);
assert.deepEqual(complete.found, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
ok('complete nine-section summary passes');

const missingSix = validate.validateSummaryStructure(summaryMissing(6));
assert.equal(missingSix.ok, false);
assert.deepEqual(missingSix.missing, [6]);
ok('a missing section is reported by number');

const boldHeadings = validate.validateSummaryStructure(
  TITLES.map((title, index) => `**${index}. ${title}**\n（无）`).join('\n')
);
assert.equal(boldHeadings.ok, true);
ok('bold section headings count too');

// Plain numbered list items inside prose are not section headings.
const listOnly = validate.validateSummaryStructure(
  ['## 0. 历史脉络', '（无）', '1. first step', '2. second step'].join('\n')
);
assert.equal(listOnly.ok, false);
ok('numbered prose lines are not mistaken for sections');

// ── 2. One bounded retry on a structurally incomplete summary ──────────────

const retried = await summarizeWith([summaryMissing(6), validSummary('SECOND')]);
assert.equal(retried.calls.length, 2);
assert.ok(retried.summary.includes('SECOND'));
assert.ok(/Correction required/.test(retried.calls[1]));
assert.ok(/## 6\. 设备与环境状态/.test(retried.calls[1]));
assert.ok(/ALL ten sections/.test(retried.calls[1]));
ok('missing section triggers exactly one corrective retry');

const clean = await summarizeWith([validSummary('FIRST')]);
assert.equal(clean.calls.length, 1);
assert.ok(clean.summary.includes('FIRST'));
ok('a valid summary is accepted on the first call');

const stillInvalid = await summarizeWith([summaryMissing(6), summaryMissing(9)]);
assert.equal(stillInvalid.calls.length, 2);
assert.ok(!stillInvalid.summary.includes('## 9.'), 'second attempt is accepted as-is');
ok('the retry is bounded: a still-invalid second attempt is accepted, not looped');

// Custom /compact instructions survive the retry.
const withFocus = await summarizeWith([summaryMissing(1), validSummary('FOCUS')]);
assert.equal(withFocus.calls.length, 2);
assert.ok(withFocus.summary.includes('FOCUS'));
const focusedCalls = [];
await buildCompactionSummary({
  summarize: async (params) => {
    focusedCalls.push(params.userPrompt);
    return focusedCalls.length === 1 ? summaryMissing(1) : validSummary('OK');
  },
  messages,
  contextWindowTokens: 128_000,
  customInstructions: 'focus on the device bring-up',
});
assert.ok(focusedCalls.every((prompt) => prompt.includes('focus on the device bring-up')));
ok('custom compaction instructions are preserved on the retry');

// ── 3. Only the checkpoint summary is validated, not every partial ─────────

// A long conversation splits into chunks; an always-invalid model must still
// cost one correction (the final merge), not one per chunk.
const longMessages = Array.from({ length: 24 }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `turn ${index}: ${'context detail '.repeat(60)}`,
  timestamp: index,
}));
const longCalls = [];
await buildCompactionSummary({
  summarize: async (params) => {
    longCalls.push(params.userPrompt);
    return '<summary>no structure at all</summary>';
  },
  messages: longMessages,
  contextWindowTokens: 8_000,
});
const corrections = longCalls.filter((prompt) => prompt.includes('Correction required')).length;
assert.equal(
  corrections,
  1,
  `expected one corrective call, got ${corrections} of ${longCalls.length}`
);
ok('multi-chunk conversation validates only the checkpoint summary (one correction)');

console.log(`[compaction-summary] PASS (${checks} checks)`);
