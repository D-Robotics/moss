#!/usr/bin/env node
/**
 * ConversationSkillLearner — buildSkillMarkdown secret redaction.
 *
 * Verifies that secrets pasted into free-text fields (userMessage,
 * assistantText) are redacted before the SKILL.md draft is produced. This is
 * the skill-persistence counterpart to the memory write-boundary validation:
 * `redactInput` only redacts structured tool-input keys, not free text, so
 * without this a user who pastes "my api_key=sk_live_…" into the conversation
 * would have that key persisted to `.moss/skills/` and re-injected into the
 * agent prompt whenever the skill matches.
 */
import assert from 'node:assert/strict';
import { buildSkillMarkdown } from '../dist/skill-learning/conversation-skill-learner.js';

const baseInput = {
  skillId: 'test-skill',
  sessionKey: 'sess-1',
  calls: [{ id: 'c1', name: 'read_file', input: { path: '/tmp/a' }, failed: false }],
  createdAt: 1_700_000_000_000,
  gate: 'legacy',
};

// ─── 1. secret in userMessage is redacted everywhere it would appear ─────────
{
  const md = buildSkillMarkdown({
    ...baseInput,
    userMessage: 'please remember my api_key=sk_live_abcdef1234567890xyz123 for later',
    assistantText: 'done',
  });
  assert.ok(
    !md.includes('sk_live_abcdef1234567890xyz123'),
    'live key must not appear anywhere in SKILL.md (title, description, example_query, 原始需求)'
  );
  assert.ok(md.includes('[redacted]'), 'secret replaced with [redacted]');
}

// ─── 2. secret in assistantText is redacted from the result summary ─────────
{
  const md = buildSkillMarkdown({
    ...baseInput,
    userMessage: 'normal task',
    assistantText: 'stored your slack token xoxb-1234567890abcdef in the config',
  });
  assert.ok(!md.includes('xoxb-1234567890abcdef'), 'slack token must not appear');
  assert.ok(md.includes('[redacted]'), 'secret in assistant text replaced');
}

// ─── 3. the same secret pasted twice is redacted in both places ─────────────
{
  const md = buildSkillMarkdown({
    ...baseInput,
    userMessage: 'use sk_live_abcdef1234567890xyz123 and also sk_live_zzz999888777666555444',
    assistantText: 'ok',
  });
  assert.ok(
    !md.includes('sk_live_abcdef1234567890xyz123') && !md.includes('sk_live_zzz999888777666555444'),
    'both occurrences redacted (global replace, not just the first)'
  );
  // two redactions → at least two [redacted] markers
  const markers = md.match(/\[redacted\]/g) ?? [];
  assert.ok(markers.length >= 2, `expected >=2 [redacted] markers, got ${markers.length}`);
}

// ─── 4. normal content is untouched ─────────────────────────────────────────
{
  const md = buildSkillMarkdown({
    ...baseInput,
    userMessage: 'how do I configure the RDK X5 board',
    assistantText: 'set up the board with these steps',
  });
  assert.ok(md.includes('how do I configure the RDK X5 board'), 'clean user message preserved');
  assert.ok(!md.includes('[redacted]'), 'no redaction marker on clean text');
}

console.log(
  '  [PASS] conversation-skill-learner: buildSkillMarkdown redacts secrets from free text'
);
