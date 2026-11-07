#!/usr/bin/env node
/**
 * Spec-audit nudge precision probe (offline, B187).
 *
 * The nudge exists for "the docs/spec/requirements are an authority" requests.
 * It used to fire on any mention of 文档/说明/需求, turning ordinary tasks into
 * SPEC-AUDIT detours. Citation phrasing must still fire; bland mentions must not.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const { evaluateSpecAuditNudge } = await import(
  pathToFileURL(path.join(root, 'dist/core/loop/nudges/spec-audit-nudge.js')).href
);

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[spec-audit-nudge] ok ${name}`);
};

const fire = (userText) =>
  evaluateSpecAuditNudge({ messages: [], userText, totalToolCalls: 1, attempts: 0 }).fire;

// 1. Citation-as-authority phrasings still fire.
for (const text of [
  'implement it per the docs',
  'the spec says the cache must be bounded',
  'requirements say the job must be idempotent',
  'fix this according to the documentation',
  '按文档要求实现缓存上限',
  '需求里说要支持重试',
  'the readme says the flag defaults to on',
]) {
  assert.equal(fire(text), true, `${text} must trigger the audit`);
}

// 2. Plain mentions / unrelated tasks do not.
for (const text of [
  'create todo.py, a command-line todo app',
  '说明一下这个函数做什么',
  '文档在哪里？',
  'add a README section about installs',
  'fix the typo in notes',
  'refactor the parser for clarity',
]) {
  assert.equal(fire(text), false, `${text} must not trigger the audit`);
}

// 3. Guards: no tool calls yet, or the audit file already written.
const base = { userText: 'per the docs, cache must be bounded' };
assert.equal(
  evaluateSpecAuditNudge({ ...base, messages: [], totalToolCalls: 0, attempts: 0 }).fire,
  false
);
const withAudit = {
  role: 'assistant',
  content: [
    { type: 'tool_use', name: 'write_file', input: { path: 'SPEC-AUDIT.md', content: 'x' } },
  ],
};
assert.equal(
  evaluateSpecAuditNudge({ ...base, messages: [withAudit], totalToolCalls: 1, attempts: 0 }).fire,
  false
);
assert.equal(
  evaluateSpecAuditNudge({ ...base, messages: [], totalToolCalls: 1, attempts: 1 }).fire,
  false,
  'fires at most once'
);
const correction = evaluateSpecAuditNudge({
  messages: [],
  userText: 'per the docs, cache must be bounded',
  totalToolCalls: 1,
  attempts: 0,
}).correction;
assert.match(correction ?? '', /write SPEC-AUDIT\.md in the workspace root/);
assert.match(correction ?? '', /do NOT ask which requirement wins/);
assert.match(correction ?? '', /ask for that doc path\/text in one short question/);
ok('citation phrasing fires once; plain mentions and completed audits stay quiet');

// 4. B258: the injected <turn-context> preamble (skill catalog here) must not
//    satisfy the trigger — ordinary "run the tests" requests used to fire it.
{
  const { selectNudgeUserText } = await import(
    pathToFileURL(path.join(root, 'dist/core/session/internal-transcript.js')).href
  );
  const prompt = 'run the tests and tell me the result in one line';
  const stored = `${prompt}\n\n<turn-context>\n## Available skills\n- writing-plans: Use when you have a spec or requirements for a multi-step task\n</turn-context>`;
  const selected = selectNudgeUserText([stored]);
  assert.equal(selected, prompt);
  assert.equal(fire(selected), false, 'the skill catalog text is not a citation');
}
ok('the turn-context preamble never satisfies nudge triggers');

console.log(`[spec-audit-nudge] ${checks}/${checks} checks passed`);
