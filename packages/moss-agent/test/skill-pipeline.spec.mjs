#!/usr/bin/env node
/**
 * SkillPipeline — processSession end-to-end.
 *
 * Uses a temp workspaceDir and real candidate-store / distiller / scorer
 * (no LLM needed — scoring is analytical). Covers:
 *   - Too-few-tool-calls → null
 *   - Clarifying question → null (isLowValueRun)
 *   - Read-only-only tools → null (isLowValueRun)
 *   - Normal session → produces candidate, returns SkillPipelineResult
 *   - extractToolCalls correctness
 *   - Written candidate.json content assertions
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillPipeline } from '../dist/skill-learning/skill-pipeline.js';
import { listCandidates } from '../dist/skill-learning/skill-candidate-store.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'moss-pipeline-'));
}

/** Build messages for processSession with the given tool_use blocks. */
function makePipelineMessages({
  userText = 'deploy the model to the RDK X5 board and verify it works',
  assistantReply = 'Model deployed successfully. The RDK X5 board firmware has been updated to version 2.3.1 and all verification checks passed. The system is now operational.',
  toolNames = ['device_exec', 'read_file'],
  toolCallCount,
  hasFailed = false,
  isClarifying = false,
} = {}) {
  const count = toolCallCount ?? toolNames.length;
  const names = toolNames.slice(0, count);

  const toolUseBlocks = names.map((name, i) => ({
    type: 'tool_use',
    id: `tu${i}`,
    name,
    input: { path: `/tmp/test${i}` },
  }));

  const toolResultBlocks = toolUseBlocks.map((tu, i) => ({
    type: 'tool_result',
    tool_use_id: tu.id,
    content: 'ok',
    is_error: hasFailed && i === 0 ? true : false,
  }));

  const reply = isClarifying ? 'Which board do you want to deploy to?' : assistantReply;

  return [
    { role: 'user', content: userText },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Starting deployment...' }, ...toolUseBlocks],
    },
    ...toolResultBlocks.map((block) => ({
      role: 'tool',
      content: [block],
    })),
    { role: 'assistant', content: [{ type: 'text', text: reply }] },
  ];
}

// ─── 1. Too few tool calls (< 2) → null ─────────────────────────────────

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir });

  const messages = makePipelineMessages({ toolCallCount: 1 });
  const result = await pipeline.processSession('sess-fewtools', messages);
  assert.strictEqual(result, null, '<2 tool calls returns null');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 2. Clarifying question → null (isLowValueRun) ─────────────────────

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir });

  // Assistant ends with "?" → isClarifyingQuestion picks it up
  const messages = makePipelineMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
    isClarifying: true,
  });
  const result = await pipeline.processSession('sess-clarify', messages);
  assert.strictEqual(result, null, 'clarifying question returns null');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 3. Only read-only tools → null (isLowValueRun) ────────────────────

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir });

  // All tools are in DEFAULT_READONLY_TOOL_NAMES
  const messages = makePipelineMessages({
    toolCallCount: 2,
    toolNames: ['read_file', 'web_search'],
  });
  const result = await pipeline.processSession('sess-readonly', messages);
  assert.strictEqual(result, null, 'read-only-only tools returns null');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 4. Normal session → produces candidate, returns result ────────────

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({
    workspaceDir: dir,
    model: 'test-model',
    autoPromoteHighConfidence: false,
  });

  const messages = makePipelineMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
  });
  const result = await pipeline.processSession('sess-normal', messages);
  assert.ok(result, 'normal session returns a result');
  assert.ok(result.candidateId, 'candidateId assigned');
  assert.ok(result.candidatePath, 'candidatePath assigned');
  assert.ok(
    result.candidatePath.endsWith('candidate.json'),
    'candidatePath ends with candidate.json'
  );

  // Distill should have run
  assert.ok(result.distill, 'distill result present');
  assert.equal(result.distill.candidateId, result.candidateId, 'distill candidateId matches');
  assert.ok(result.distill.score, 'distill score present');
  assert.equal(typeof result.distill.score.confidence, 'number', 'confidence is a number');
  assert.ok(result.distill.score.confidence > 0, 'confidence > 0');

  // autoPromoteHighConfidence=false → promoted should be null
  assert.strictEqual(result.promoted, null, 'promoted is null when autoPromote is false');

  // Verify the candidate was written to disk
  const candidates = await listCandidates(dir);
  assert.ok(candidates.length >= 1, 'at least one candidate persisted');
  const found = candidates.find((c) => c.candidateId === result.candidateId);
  assert.ok(found, 'the candidate is retrievable via listCandidates');
  assert.equal(
    found.toolNames.sort().join(','),
    'device_exec,read_file,web_search',
    'tool names match'
  );

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 5. extractToolCalls correctness via write content ─────────────────

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir });

  // Use known tool calls with specific inputs
  const messages = [
    { role: 'user', content: 'test the device and report stats' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Testing...' },
        {
          type: 'tool_use',
          id: 't1',
          name: 'device_exec',
          input: { command: 'ls /sys/class', timeout: 5 },
        },
        {
          type: 'tool_use',
          id: 't2',
          name: 'read_file',
          input: { file_path: '/sys/class/thermal/thermal_zone0/temp' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'thermal gpio i2c', is_error: false },
      ],
    },
    {
      role: 'tool',
      content: [{ type: 'tool_result', tool_use_id: 't2', content: '55000', is_error: false }],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Device stats collected. Temperature is 55C which is within normal operating range. All sensors are responding correctly. The system hardware is functioning as expected.',
        },
      ],
    },
  ];

  const result = await pipeline.processSession('sess-extract', messages);
  assert.ok(result, 'processSession returns result');

  // Read the candidate.json to verify tool calls were extracted correctly
  const candidates = await listCandidates(dir);
  const match = candidates.find((c) => c.candidateId === result.candidateId);
  assert.ok(match, 'candidate found on disk');
  assert.equal(match.toolCalls.length, 2, 'two tool calls extracted');
  assert.equal(match.toolCalls[0].name, 'device_exec', 'first tool name correct');
  assert.equal(match.toolCalls[0].input.command, 'ls /sys/class', 'first tool input preserved');
  assert.equal(match.toolCalls[1].name, 'read_file', 'second tool name correct');
  assert.equal(
    match.toolCalls[1].input.file_path,
    '/sys/class/thermal/thermal_zone0/temp',
    'second tool input preserved'
  );
  assert.equal(match.toolCalls[0].failed, false, 'first tool not failed');
  assert.equal(match.toolCalls[1].failed, false, 'second tool not failed');

  // Verify evidence fields
  assert.equal(match.sourceSessionKey, 'sess-extract');
  assert.equal(match.gate, 'strict');
  assert.equal(match.runMeta.model, 'unknown'); // default model
  assert.equal(match.runMeta.completionKind, 'complete');
  assert.ok(match.userMessage.includes('test the device'), 'userMessage captured');
  assert.ok(match.assistantText.includes('Device stats collected'), 'assistantText captured');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 6. Distill draft is written to disk and has frontmatter ────────────

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir });

  const messages = makePipelineMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
  });
  const result = await pipeline.processSession('sess-draft', messages);
  assert.ok(result);
  assert.ok(result.distill, 'distill result present');

  // The draft file is named SKILL.draft.md inside the candidate directory
  const candidatesRoot = path.join(dir, '.moss', 'skills', 'candidates');
  const draftPath = path.join(candidatesRoot, result.candidateId, 'SKILL.draft.md');
  const draftContent = await fs.readFile(draftPath, 'utf-8');
  assert.ok(draftContent.startsWith('---'), 'draft has frontmatter');
  assert.ok(draftContent.includes('schemaVersion:'), 'draft has schemaVersion');
  assert.ok(draftContent.includes('name:'), 'draft has name');
  assert.ok(draftContent.includes('quality:'), 'draft has quality score');
  assert.ok(draftContent.includes('confidence:'), 'draft has confidence');
  assert.ok(draftContent.includes('## 执行流程'), 'draft has 执行流程 section');
  assert.ok(draftContent.includes('## 沉淀来源'), 'draft has 沉淀来源 section');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 7. Missing user message → null ─────────────────────────────────────

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir });

  // No user message — only assistant and tool messages.
  const noUserMessages = [
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tu1', name: 'read_file', input: {} }],
    },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
  ];

  const result = await pipeline.processSession('sess-nouser', noUserMessages);
  assert.strictEqual(result, null, 'no user message returns null');
  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 8. Multiple sessions with same tool pattern → patternOccurrences increases ─

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir });

  // First session
  const msgs1 = makePipelineMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
    userText: 'first deploy test to the RDK board',
    assistantReply:
      'First deployment completed successfully. All checks passed on the RDK X5 board with firmware version 2.3.1 operational and verified.',
  });
  const r1 = await pipeline.processSession('sess-pattern-1', msgs1);
  assert.ok(r1, 'first session produces candidate');

  // Second session with same tool names
  const msgs2 = makePipelineMessages({
    toolCallCount: 3,
    toolNames: ['device_exec', 'read_file', 'web_search'],
    userText: 'second deploy test to the RDK board',
    assistantReply:
      'Second deployment completed successfully. All checks passed on the RDK X5 board with firmware version 2.3.1 operational and verified.',
  });
  const r2 = await pipeline.processSession('sess-pattern-2', msgs2);
  assert.ok(r2, 'second session produces candidate');
  // candidateId will differ because userMessage differs
  assert.notEqual(
    r1.candidateId,
    r2.candidateId,
    'different messages produce different candidate IDs'
  );

  // Both should appear in listCandidates
  const all = await listCandidates(dir);
  assert.equal(all.length, 2, 'two candidates exist');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 9. Failed tool is recorded correctly in evidence ───────────────────

{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir });

  const messages = makePipelineMessages({
    toolCallCount: 2,
    toolNames: ['device_exec', 'read_file'],
    hasFailed: true,
    assistantReply:
      'The first device exec failed but file read completed successfully. The system needs manual intervention to resolve the device connection issue before proceeding.',
  });

  const result = await pipeline.processSession('sess-failed', messages);
  assert.ok(result);

  const candidates = await listCandidates(dir);
  const match = candidates.find((c) => c.candidateId === result.candidateId);
  assert.ok(match, 'candidate found');
  // Note: processSession uses its own extractToolCalls which is a copy of
  // the same logic. It marks failed=true on the tool whose result has is_error.
  assert.ok(
    match.toolCalls.some((tc) => tc.failed),
    'failed tool marked as failed'
  );

  // The score should reflect the failure
  assert.ok(result.distill, 'distill present');
  assert.equal(result.distill.score.signals.allSucceeded, false, 'allSucceeded is false');

  await fs.rm(dir, { recursive: true, force: true });
}

// ─── 10. Custom readonlyToolNames — tools outside the set prevent low-value ─

{
  const dir = await makeTempDir();

  // Custom set: treat even device_exec as readonly
  const pipeline = new SkillPipeline({
    workspaceDir: dir,
    readonlyToolNames: ['device_exec', 'read_file', 'read'],
  });

  const messages = makePipelineMessages({
    toolCallCount: 2,
    toolNames: ['device_exec', 'read_file'],
  });
  const result = await pipeline.processSession('sess-custom-readonly', messages);
  // All distinct tools are in the custom readonly set → isLowValueRun returns true
  assert.strictEqual(result, null, 'all tools in custom readonly set → null');
  await fs.rm(dir, { recursive: true, force: true });
}

// Production mode only learns from an explicit no-Plan teaching request.
{
  const dir = await makeTempDir();
  const pipeline = new SkillPipeline({ workspaceDir: dir, explicitIntentOnly: true });
  const ordinary = await pipeline.processSession(
    'sess-no-intent',
    makePipelineMessages({
      toolNames: ['device_exec', 'write_file'],
    })
  );
  assert.equal(ordinary, null, 'assistant success wording alone cannot create a Skill candidate');
  const explicit = await pipeline.processSession(
    'sess-explicit-intent',
    makePipelineMessages({
      userText: 'Please save this as a skill',
      toolNames: ['device_exec', 'write_file'],
    })
  );
  assert.ok(explicit, 'explicit teaching remains compatible');
  await fs.rm(dir, { recursive: true, force: true });
}

console.log('  [PASS] skill-pipeline.spec.mjs: SkillPipeline.processSession');
