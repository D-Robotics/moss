#!/usr/bin/env node
/**
 * ConversationSkillLearner — maybePersistConversationSkill end-to-end.
 *
 * Covers gate paths: null, 'intent', 'strict', 'legacy', dedup, empty turns,
 * secret redaction, SKILL.md frontmatter / content assertions.
 *
 * Reads auto-mode from RDK_MOSS_AUTO_CONVERSATION_SKILL env, so tests that go
 * through auto-mode gates set this before calling maybePersistConversationSkill.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  maybePersistConversationSkill,
  buildSkillMarkdown,
} from '../dist/skill-learning/conversation-skill-learner.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-skille2e-'));
}

/** Build a minimal multi-turn message array the learner can process. */
function makeMessages({
  role = 'user',
  text = 'deploy the model to the RDK X5 board and verify the firmware works correctly',
  toolNames = ['device_exec', 'read_file'],
  assistantReply = 'The model was deployed successfully. The RDK X5 board is now running the new firmware version 2.3.1 with all checks passing. Verified output matches expected results.',
  toolCallCount = 2,
  hasFailed = false,
} = {}) {
  const toolUseBlocks = toolNames.slice(0, toolCallCount).map((name, i) => ({
    type: 'tool_use',
    id: `tu${i}`,
    name,
    input: { path: `/tmp/test${i}` },
  }));

  const toolResultBlocks = toolUseBlocks.map((tu) => ({
    type: 'tool_result',
    tool_use_id: tu.id,
    content: 'ok',
    is_error: hasFailed && tu.name === toolNames[0] ? true : false,
  }));

  return [
    { role: 'user', content: text },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Starting deployment process.' }, ...toolUseBlocks],
    },
    ...toolResultBlocks.map((block) => ({
      role: 'tool',
      content: [block],
    })),
    { role: 'assistant', content: [{ type: 'text', text: assistantReply }] },
  ];
}

// ─── 1. gate=null — no intent + autoMode off → returns null, no write ─────

{
  const dir = await makeTempDir();
  // Unset auto mode so readAutoMode() returns 'off'
  const prevMode = process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-gate-null',
    messages: makeMessages(),
    intent: { detected: false },
  });
  assert.strictEqual(result, null, 'gate=null returns null');

  // Verify nothing was written to disk
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    entries = [];
  }
  assert.equal(entries.length, 0, 'no files written when gate=null');

  if (prevMode !== undefined) process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = prevMode;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 2. gate='intent' — intent.detected=true → writes SKILL.md ────────────

{
  const dir = await makeTempDir();
  const prevMode = process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-intent-1',
    messages: makeMessages(),
    intent: { detected: true },
  });
  assert.ok(result, 'gate=intent returns a PersistedConversationSkill');
  assert.equal(result.gate, 'intent');
  assert.equal(result.sourceKind, 'conversation');
  assert.ok(result.skillId, 'skillId assigned');
  assert.ok(result.path, 'path assigned');
  assert.ok(result.toolNames.includes('device_exec'), 'toolNames include device_exec');
  assert.equal(result.toolNames.length, 2, 'two tool names');

  // Verify the SKILL.md was written
  const skillContent = await fs.readFile(result.path, 'utf-8');
  assert.ok(
    skillContent.includes('沉淀门槛：intent'),
    'SKILL.md has gate: intent in source section'
  );
  assert.ok(skillContent.includes('name:'), 'frontmatter has name');
  assert.ok(skillContent.includes('description:'), 'frontmatter has description');
  assert.ok(skillContent.includes('trigger:'), 'frontmatter has trigger');
  assert.ok(skillContent.includes('permissions:'), 'frontmatter has permissions');
  assert.ok(skillContent.includes('## 沉淀来源'), 'section: 沉淀来源');
  assert.ok(skillContent.includes('## 执行流程'), 'section: 执行流程');

  // Verify the .moss-skill.json was written alongside SKILL.md
  const metaPath = path.join(path.dirname(result.path), '.moss-skill.json');
  const metaRaw = await fs.readFile(metaPath, 'utf-8');
  const meta = JSON.parse(metaRaw);
  assert.equal(meta.sourceKind, 'conversation');
  assert.equal(meta.gate, 'intent');
  assert.equal(meta.sourceSessionKey, 'sess-intent-1');
  assert.deepEqual(meta.toolNames.sort(), ['device_exec', 'read_file']);

  if (prevMode !== undefined) process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = prevMode;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 3. gate='strict' — insufficient distinct tools → null ───────────────

{
  const dir = await makeTempDir();
  process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = 'strict';

  // Only 1 distinct tool (read_file), need >=2
  const messages = makeMessages({
    toolNames: ['read_file'],
    toolCallCount: 3,
    assistantReply:
      'The file was read successfully. Contents show the configuration is correct with all parameters set to default values. This confirms the system is ready for deployment. Verification shows everything matches expected results.',
  });

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-strict-toofew',
    messages,
  });
  assert.strictEqual(result, null, 'strict gate with <2 distinct tools returns null');

  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    entries = [];
  }
  assert.equal(entries.length, 0, 'no files written');

  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 4. gate='strict' — assistantText too short → null ───────────────────

{
  const dir = await makeTempDir();
  process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = 'strict';

  const messages = makeMessages({
    assistantReply: 'done.', // too short (<120 chars)
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
  });

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-strict-shorttext',
    messages,
  });
  assert.strictEqual(result, null, 'strict gate with short assistant text returns null');

  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 5. gate='strict' — has failed tool → null ───────────────────────────

{
  const dir = await makeTempDir();
  process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = 'strict';

  const messages = makeMessages({
    hasFailed: true,
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
    assistantReply:
      'The deployment failed initially but was recovered. The RDK X5 board is now configured with all settings applied correctly. Verification shows the firmware update completed successfully.',
  });

  // hasFailed=true means the first tool (device_exec) gets is_error, so calls.some(c=>c.failed) is true
  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-strict-failed',
    messages,
  });
  assert.strictEqual(result, null, 'strict gate with failed tool returns null');

  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 6. gate='strict' — userMessage not task-like → null ────────────────

{
  const dir = await makeTempDir();
  process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = 'strict';

  // Too short — will fail userMessageLooksLikeTask (needs >=12 chars)
  const messages = makeMessages({ text: 'hi' });

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-strict-notask',
    messages,
  });
  assert.strictEqual(result, null, 'strict gate with non-task userMessage returns null');

  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 7. gate='strict' — all satisfied → writes SKILL.md ─────────────────

{
  const dir = await makeTempDir();
  process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = 'strict';

  const messages = makeMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
    assistantReply:
      'The model was deployed successfully. The RDK X5 board is now running the new firmware version 2.3.1 with all checks passing. Verified output matches expected results and the system is fully operational without any issues.',
  });

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-strict-ok',
    messages,
  });
  assert.ok(result, 'strict gate all-satisfied returns result');
  assert.equal(result.gate, 'strict');
  assert.equal(result.sourceKind, 'conversation');

  const skillContent = await fs.readFile(result.path, 'utf-8');
  assert.ok(
    skillContent.includes('沉淀门槛：strict'),
    'SKILL.md has gate: strict in source section'
  );
  assert.ok(skillContent.includes('deploy'), 'content mentions deploy from userMessage');

  // Verify .moss-skill.json
  const metaPath = path.join(path.dirname(result.path), '.moss-skill.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  assert.equal(meta.gate, 'strict');
  assert.deepEqual(meta.toolNames.sort(), ['device_exec', 'read_file', 'web_search']);

  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 8. gate='legacy' — tool call threshold (minToolCalls) ──────────────

{
  const dir = await makeTempDir();
  process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = 'legacy';

  // Only 1 tool call — below legacy default min (2, clamped >=2)
  const messagesFew = makeMessages({
    toolCallCount: 1,
    toolNames: ['read_file'],
    assistantReply:
      'The configuration file was read successfully. Contents show default settings which are acceptable for standard operation.',
  });

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-legacy-toofew',
    messages: messagesFew,
    minToolCalls: 3,
  });
  assert.strictEqual(result, null, 'legacy gate with 1 tool call (min=3) returns null');

  // With 2 tool calls (clamped min=2) legacy passes
  const messagesOk = makeMessages({
    toolCallCount: 2,
    toolNames: ['read_file', 'web_search'],
    assistantReply:
      'The configuration file was read successfully. Contents show default settings which are acceptable for standard operation.',
  });
  const result2 = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-legacy-ok',
    messages: messagesOk,
    minToolCalls: 1, // clamped to 2, passes with 2 tool calls
  });
  assert.ok(result2, 'legacy gate with 2 tool calls passes');
  assert.equal(result2.gate, 'legacy');

  const skillContent = await fs.readFile(result2.path, 'utf-8');
  assert.ok(
    skillContent.includes('沉淀门槛：legacy'),
    'SKILL.md has gate: legacy in source section'
  );

  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 9. pickSubstantiveTurn finds nothing → null ─────────────────────---

{
  const dir = await makeTempDir();
  const prevMode = process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;

  // Messages with no assistant turns at all
  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-noturn',
    messages: [{ role: 'user', content: 'hello' }],
    intent: { detected: true },
  });
  assert.strictEqual(result, null, 'no substantive turn returns null');

  if (prevMode !== undefined) process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = prevMode;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 10. userMessage or assistantText empty → null ─────────────────────

{
  const dir = await makeTempDir();
  const prevMode = process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;

  // Pass explicit whitespace-only userMessage which survives the || chain
  // ('  ' is truthy) and then '.trim()' produces '' → falsy → returns null
  const messages = makeMessages();
  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-empty-msg',
    messages,
    userMessage: '  ',
    assistantText: '  ',
    intent: { detected: true },
  });
  assert.strictEqual(
    result,
    null,
    'whitespace-only explicit userMessage+assistantText returns null'
  );

  // When turn-derived text is empty (user message is pure whitespace)
  const msgNoText = makeMessages({ text: '  ' });
  const result2 = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-empty-turn',
    messages: msgNoText,
    intent: { detected: true },
  });
  assert.strictEqual(result2, null, 'empty turn-derived text returns null');

  if (prevMode !== undefined) process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = prevMode;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 11. Dedup — existing skill with same toolNames → writes to same dir ─

{
  const dir = await makeTempDir();
  process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = 'strict';

  const msg1 = makeMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
    assistantReply:
      'The model was deployed successfully. The RDK X5 board is now running the new firmware version 2.3.1 with all checks passing. Verified output matches expected results and the system is fully operational without any issues.',
    text: 'deploy the model to the RDK X5 board and verify the firmware works correctly in this test scenario',
  });

  const first = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-dedup-1',
    messages: msg1,
  });
  assert.ok(first, 'first write succeeds');

  // Second write with identical tool set — the dedup target will be found
  const msg2 = makeMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
    assistantReply:
      'The model was deployed again successfully. The RDK X5 board firmware version 2.3.1 is confirmed working with all checks passing. Verified output matches expected results and the system is fully operational.',
    text: 'deploy the model to the RDK X5 board and verify the firmware again for this second test run',
  });

  const second = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-dedup-2',
    messages: msg2,
  });
  assert.ok(second, 'second (dedup) write also returns a result');
  // When findDedupCandidate finds a match, writeGeneratedSkill receives
  // dedupTargetDir=existing dir, so the .moss-skill.json gets overwritten
  // with the new session key.
  const metaPath = path.join(path.dirname(second.path), '.moss-skill.json');
  const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
  assert.equal(
    meta.sourceSessionKey,
    'sess-dedup-2',
    'dedup writes to same dir with new session key'
  );

  // Both should be in the same directory (same skill ID from dedup)
  assert.equal(path.dirname(first.path), path.dirname(second.path), 'dedup reuses same directory');

  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 12. Secret redaction — sk-/xoxb- not in SKILL.md ────────────────────

{
  const dir = await makeTempDir();
  const prevMode = process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;

  // Construct a situation where the user message contains a plain-text key
  const messages = [
    {
      role: 'user',
      content:
        'remember my api key sk_live_abcdef1234567890xyz123 and slack token xoxb-9876543210-abc',
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Starting.' },
        { type: 'tool_use', id: 'tu0', name: 'read_file', input: { path: '/tmp/config' } },
        { type: 'tool_use', id: 'tu1', name: 'web_search', input: { query: 'test' } },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'tu0', content: 'ok', is_error: false }],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok', is_error: false }],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Stored your slack token securely. The configuration has been saved and the API key is now set up correctly for all services. Everything completed as requested.',
        },
      ],
    },
  ];

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-secret-1',
    messages,
    intent: { detected: true },
  });
  assert.ok(result, 'intent gate returns a result');

  const skillContent = await fs.readFile(result.path, 'utf-8');
  assert.ok(
    !skillContent.includes('sk_live_abcdef1234567890xyz123'),
    'live api key not in SKILL.md'
  );
  assert.ok(!skillContent.includes('xoxb-9876543210-abc'), 'slack token not in SKILL.md');
  // The secret should be replaced with [redacted] in the userMessage-derived fields
  // Note: redactSecretsInText replaces matches with '[redacted]'
  assert.ok(skillContent.includes('[redacted]'), 'secret replaced with [redacted] in SKILL.md');

  if (prevMode !== undefined) process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = prevMode;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 13. Content assertions — name, description, trigger, steps, source ──

{
  const dir = await makeTempDir();
  process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL = 'strict';

  const messages = makeMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
    assistantReply:
      'The model was deployed successfully. The RDK X5 board firmware has been updated to version 2.3.1. All verification checks passed. The system is now operational and ready for production use without any known issues.',
    text: 'deploy new firmware to the RDK X5 development board',
  });

  const result = await maybePersistConversationSkill({
    skillsDir: dir,
    sessionKey: 'sess-content-verify',
    messages,
  });
  assert.ok(result);

  const skillContent = await fs.readFile(result.path, 'utf-8');

  // Frontmatter structure
  assert.ok(skillContent.startsWith('---'), 'starts with frontmatter');
  assert.ok(skillContent.includes('\nname:'), 'has name in frontmatter');
  assert.ok(skillContent.includes('\nversion:'), 'has version');
  assert.ok(skillContent.includes('\nrisk:'), 'has risk');
  assert.ok(skillContent.includes('\ncategory: Conversation'), 'category is Conversation');

  // Content sections
  assert.ok(skillContent.includes('# 对话沉淀'), 'has title heading');
  assert.ok(skillContent.includes('## 适用场景'), 'section: 适用场景');
  assert.ok(skillContent.includes('## 执行流程'), 'section: 执行流程');
  assert.ok(skillContent.includes('## 工具映射'), 'section: 工具映射');
  assert.ok(skillContent.includes('## 沉淀来源'), 'section: 沉淀来源');
  assert.ok(skillContent.includes('## 禁止事项'), 'section: 禁止事项');

  // Tool mapping rows
  assert.ok(skillContent.includes('| `device_exec`'), 'tool mapping has device_exec');
  assert.ok(skillContent.includes('| `read_file`'), 'tool mapping has read_file');
  assert.ok(skillContent.includes('| `web_search`'), 'tool mapping has web_search');

  // Source info
  assert.ok(skillContent.includes('sess-content-verify'), 'source session key in content');
  assert.ok(skillContent.includes('沉淀门槛：strict'), 'gate in source section');
  assert.ok(skillContent.includes('deploy new firmware'), 'original user message in content');

  delete process.env.RDK_MOSS_AUTO_CONVERSATION_SKILL;
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 14. buildSkillMarkdown unit-level: customSlug → name includes it ──

{
  const md = buildSkillMarkdown({
    skillId: 'my-skill',
    userMessage: 'test message for custom slug verification purpose only',
    assistantText: 'done successfully with all steps completed and verified correctly',
    sessionKey: 'sess-slug',
    calls: [{ id: 'c1', name: 'read_file', input: { path: '/tmp/a' }, failed: false }],
    createdAt: 1_700_000_000_000,
    gate: 'intent',
    intent: { detected: true, customSlug: 'deploy-model' },
  });
  assert.ok(md.includes('deploy model'), 'name includes custom slug words');
  assert.ok(md.includes('沉淀门槛：intent'), 'gate in source section');
}

console.log('  [PASS] conversation-skill-learner-e2e: maybePersistConversationSkill');
