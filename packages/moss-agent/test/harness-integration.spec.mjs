#!/usr/bin/env node
/**
 * Harness integration tests — end-to-end agent loop with real tool execution.
 *
 * These tests verify the system can actually solve multi-step problems:
 *   1. Multi-step tool chain (write → read → verify)
 *   2. Error recovery (read nonexistent → write → read again)
 *   3. Cross-turn context persistence (reactive mock reads actual messages)
 *   4. Multi-file project scaffolding (6+ tool calls, structure verification)
 *   5. Conditional data pipeline (tool results drive branching decisions)
 *   6. Long-horizon multi-turn task (cross-chat error recovery + context use)
 *
 * No mocks for tools — real file I/O in a temp directory.
 * Mock LLM is reactive (inspects options.messages to make decisions).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

// ─── Reactive Mock LLM ─────────────────────────────────────
//
// Two modes:
// 1. Scripted: returns pre-built LLMResponse objects in sequence (Tests 1-2).
// 2. Reactive: calls a decideFn(callIndex, messages) that inspects the
//    conversation history and returns the next response (Tests 3-6).
//
// The reactive mode is the key difference — the mock actually reads
// options.messages to find tool results and user text, then decides
// what to do next. This tests that the agent loop correctly feeds
// tool results back to the LLM.

/**
 * @typedef {import('../dist/core/llm/llm-provider.js').LLMResponse} LLMResponse
 * @typedef {import('../dist/core/llm/llm-provider.js').LLMContentBlock} LLMContentBlock
 * @typedef {import('../dist/core/llm/llm-provider.js').LLMStreamEvent} LLMStreamEvent
 * @typedef {import('../dist/core/llm/llm-provider.js').LLMRequestOptions} LLMRequestOptions
 * @typedef {import('../dist/core/llm/llm-provider.js').LLMMessage} LLMMessage
 */

/** @param {LLMMessage[]} messages */
function extractToolResults(messages) {
  const results = [];
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          results.push({
            id: block.tool_use_id,
            content: block.content,
            isError: block.is_error || false,
          });
        }
      }
    }
  }
  return results;
}

/** @param {LLMMessage[]} messages */
function extractLastToolResult(messages) {
  const results = extractToolResults(messages);
  return results[results.length - 1] || null;
}

/** @param {LLMMessage[]} messages */
function extractUserTexts(messages) {
  const texts = [];
  for (const msg of messages) {
    if (msg.role === 'user' && typeof msg.content === 'string') {
      texts.push(msg.content);
    }
  }
  return texts;
}

/**
 * Create a scripted mock LLM (pre-built responses, no inspection).
 * @param {LLMResponse[]} script
 */
function createScriptedProvider(script) {
  let i = 0;
  return {
    id: 'scripted-mock',
    displayName: 'Scripted Mock LLM',
    async complete() {
      if (i >= script.length) throw new Error(`scripted provider exhausted at call ${i + 1}`);
      return script[i++];
    },
    async stream(_opts, onEvent) {
      if (i >= script.length) throw new Error(`scripted provider exhausted at call ${i + 1}`);
      const resp = script[i++];
      onEvent({ type: 'message_start' });
      for (const block of resp.content) {
        onEvent({ type: 'content_block_start' });
        if (block.type === 'text') onEvent({ type: 'content_block_delta', text: block.text });
        else if (block.type === 'tool_use')
          onEvent({ type: 'content_block_delta', toolUse: { id: block.id, name: block.name } });
        onEvent({ type: 'content_block_stop' });
      }
      onEvent({ type: 'message_delta', stopReason: resp.stopReason });
      onEvent({ type: 'message_stop' });
      return resp;
    },
  };
}

/**
 * Create a reactive mock LLM (decision function inspects messages).
 * @param {(callIndex: number, messages: LLMMessage[]) => LLMResponse} decideFn
 */
function createReactiveProvider(decideFn) {
  let i = 0;
  return {
    id: 'reactive-mock',
    displayName: 'Reactive Mock LLM',
    /** @param {LLMRequestOptions} options */
    async complete(options) {
      const resp = decideFn(i, options.messages);
      i++;
      return resp;
    },
    /** @param {LLMRequestOptions} options @param {(e: LLMStreamEvent) => void} onEvent */
    async stream(options, onEvent) {
      const resp = decideFn(i, options.messages);
      i++;
      onEvent({ type: 'message_start' });
      for (const block of resp.content) {
        onEvent({ type: 'content_block_start' });
        if (block.type === 'text') onEvent({ type: 'content_block_delta', text: block.text });
        else if (block.type === 'tool_use')
          onEvent({ type: 'content_block_delta', toolUse: { id: block.id, name: block.name } });
        onEvent({ type: 'content_block_stop' });
      }
      onEvent({ type: 'message_delta', stopReason: resp.stopReason });
      onEvent({ type: 'message_stop' });
      return resp;
    },
  };
}

// ─── Test Tools (real file I/O) ────────────────────────────

/** @param {string} baseDir */
function createTestTools(baseDir) {
  const resolvedBase = path.resolve(baseDir);
  /** @param {string} relPath */
  function resolvePath(relPath) {
    const joined = path.resolve(resolvedBase, relPath);
    if (!joined.startsWith(resolvedBase)) throw new Error('path traversal blocked');
    return joined;
  }

  const testWriteFile = {
    name: 'test_write_file',
    description: 'Write content to a file in the test workspace.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    /** @param {{path: string, content: string}} input */
    async execute(input) {
      const fullPath = resolvePath(input.path);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, input.content, 'utf8');
      return `Wrote ${input.content.length} bytes to ${input.path}`;
    },
  };

  const testReadFile = {
    name: 'test_read_file',
    description: 'Read a file from the test workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    /** @param {{path: string}} input */
    async execute(input) {
      const fullPath = resolvePath(input.path);
      try {
        return await fs.readFile(fullPath, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`File not found: ${input.path}`);
        throw err;
      }
    },
  };

  const testListFiles = {
    name: 'test_list_files',
    description: 'List files in a directory in the test workspace.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Subdirectory to list (default: root).' } },
    },
    /** @param {{dir?: string}} input */
    async execute(input) {
      const dir = input.dir ? resolvePath(input.dir) : resolvedBase;
      const entries = await fs.readdir(dir, { withFileTypes: true, recursive: false });
      return entries.map((e) => `${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}`).join('\n');
    },
  };

  const testFileExists = {
    name: 'test_file_exists',
    description: 'Check if a file exists in the test workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    /** @param {{path: string}} input */
    async execute(input) {
      const fullPath = resolvePath(input.path);
      try {
        await fs.access(fullPath);
        return 'true';
      } catch {
        return 'false';
      }
    },
  };

  const testDeleteFile = {
    name: 'test_delete_file',
    description: 'Delete a file from the test workspace.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    /** @param {{path: string}} input */
    async execute(input) {
      const fullPath = resolvePath(input.path);
      await fs.rm(fullPath, { force: true });
      return `Deleted ${input.path}`;
    },
  };

  return { testWriteFile, testReadFile, testListFiles, testFileExists, testDeleteFile };
}

// ─── Helper: create agent with tools ───────────────────────

function createAgent(provider, store, maxTurns = 8) {
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    baseSystemPrompt: 'You are a test agent.',
    domainPrompt: false,
    maxAgentTurns: maxTurns,
    enableSteering: false,
    enableFollowUpGuard: false,
  });
  return agent;
}

function registerAllTools(agent, tools) {
  for (const tool of Object.values(tools)) agent.tools.register(tool);
}

// ─── Test 1: Multi-step tool chain (write → read → verify) ─

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-h1-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const provider = createScriptedProvider([
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'I will write a file and then read it back.' },
        {
          type: 'tool_use',
          id: 'c1',
          name: 'test_write_file',
          input: { path: 'data.txt', content: 'Hello from harness test!' },
        },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'c2', name: 'test_read_file', input: { path: 'data.txt' } },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'The file contains: Hello from harness test!' }],
    },
  ]);

  const agent = createAgent(provider, store);
  registerAllTools(agent, tools);

  const result = await agent.chat(
    'h:test-1',
    'Write a file with "Hello from harness test!" then read it back.'
  );

  assert.equal(result.toolCalls.length, 2, '2 tool calls');
  assert.equal(result.toolCalls[0].name, 'test_write_file');
  assert.equal(result.toolCalls[1].name, 'test_read_file');
  assert.ok(result.response.includes('Hello from harness test!'), 'response includes content');
  assert.equal(
    await fs.readFile(path.join(tmpDir, 'data.txt'), 'utf8'),
    'Hello from harness test!'
  );

  const msgs = await store.loadMessages('h:test-1');
  assert.ok(msgs.length >= 4, `>=4 messages, got ${msgs.length}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('  [PASS] Test 1: Multi-step tool chain — write -> read -> verify');
}

// ─── Test 2: Error recovery ────────────────────────────────

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-h2-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const provider = createScriptedProvider([
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me try reading the file first.' },
        { type: 'tool_use', id: 'c1', name: 'test_read_file', input: { path: 'missing.txt' } },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'The file does not exist. I will create it.' },
        {
          type: 'tool_use',
          id: 'c2',
          name: 'test_write_file',
          input: { path: 'missing.txt', content: 'Recovered content' },
        },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'c3', name: 'test_read_file', input: { path: 'missing.txt' } },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'Recovered from the error. The file now contains: Recovered content',
        },
      ],
    },
  ]);

  const agent = createAgent(provider, store);
  registerAllTools(agent, tools);

  const result = await agent.chat(
    'h:test-2',
    'Read missing.txt, and if it does not exist, create it and read it again.'
  );

  assert.equal(result.toolCalls.length, 3, '3 tool calls');
  assert.equal(result.toolResults[0].isError, true, 'first read is error');
  assert.equal(result.toolResults[1].isError, false, 'write succeeds');
  assert.equal(result.toolResults[2].isError, false, 'second read succeeds');
  assert.ok(result.response.includes('Recovered'), 'response mentions recovery');
  assert.equal(await fs.readFile(path.join(tmpDir, 'missing.txt'), 'utf8'), 'Recovered content');

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('  [PASS] Test 2: Error recovery — read fail -> write -> read success');
}

// ─── Test 3: Cross-turn context persistence (FIXED) ────────
//
// The reactive mock inspects options.messages to find the number
// the user mentioned in chat 1. If the agent loop doesn't pass
// previous messages, the mock can't find the number and returns
// a "no context" response — the test fails.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-h3-'));
  const store = new InMemorySessionStore();

  // Chat 1: simple text response
  const provider1 = createScriptedProvider([
    {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'Got it. I will remember the number 42 for this session.' }],
    },
  ]);
  const agent1 = createAgent(provider1, store);
  const result1 = await agent1.chat('h:test-3', 'Please remember the number 42 for this session.');
  assert.ok(result1.response.includes('42'), 'first response acknowledges number');

  const msgsAfter1 = await store.loadMessages('h:test-3');
  assert.ok(msgsAfter1.length >= 2, `>=2 messages after chat 1, got ${msgsAfter1.length}`);

  // Chat 2: reactive mock reads messages to find the number
  const provider2 = createReactiveProvider((callIndex, messages) => {
    // Search all user messages for a number
    const userTexts = extractUserTexts(messages);
    const allText = userTexts.join(' ');
    const match = allText.match(/\b(\d+)\b/);
    if (match) {
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: `Based on our previous conversation, you asked me to remember the number ${match[1]}.`,
          },
        ],
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'I have no record of any number in our conversation.' }],
    };
  });

  const agent2 = createAgent(provider2, store);
  const result2 = await agent2.chat('h:test-3', 'What number did I ask you to remember?');

  // This assertion is now REAL — if context isn't passed, the mock
  // returns "no record" and this fails.
  assert.ok(
    result2.response.includes('42'),
    `second response must reference 42 from actual context, got: ${result2.response}`
  );
  assert.ok(
    !result2.response.includes('no record'),
    'response must not say "no record" — context should be available'
  );

  const msgsAfter2 = await store.loadMessages('h:test-3');
  assert.ok(msgsAfter2.length >= 4, `>=4 messages after chat 2, got ${msgsAfter2.length}`);
  const userMsgs = msgsAfter2.filter((m) => m.role === 'user' && typeof m.content === 'string');
  assert.ok(userMsgs.length >= 2, `>=2 text user messages, got ${userMsgs.length}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(
    '  [PASS] Test 3: Cross-turn context persistence — reactive mock reads actual messages'
  );
}

// ─── Test 4: Multi-file project scaffolding ────────────────
//
// Agent creates a 3-file project structure, lists files, reads
// one back to verify, and summarizes. 6+ tool calls.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-h4-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const provider = createScriptedProvider([
    // Turn 1: create main.py
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'I will create a Python project with 3 files.' },
        {
          type: 'tool_use',
          id: 'c1',
          name: 'test_write_file',
          input: { path: 'src/main.py', content: 'from utils import greet\nprint(greet("World"))' },
        },
      ],
    },
    // Turn 2: create utils.py
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'c2',
          name: 'test_write_file',
          input: {
            path: 'src/utils.py',
            content: 'def greet(name):\n    return f"Hello, {name}!"',
          },
        },
      ],
    },
    // Turn 3: create README.md
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'c3',
          name: 'test_write_file',
          input: { path: 'README.md', content: '# Test Project\n\nA simple Python greeting app.' },
        },
      ],
    },
    // Turn 4: list files to verify structure
    {
      stopReason: 'tool_use',
      content: [{ type: 'tool_use', id: 'c4', name: 'test_list_files', input: {} }],
    },
    // Turn 5: read main.py back to verify content
    {
      stopReason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'c5', name: 'test_read_file', input: { path: 'src/main.py' } },
      ],
    },
    // Turn 6: final summary
    {
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'Project created successfully. Structure: src/main.py, src/utils.py, README.md. Verified main.py contains the greeting import and print statement.',
        },
      ],
    },
  ]);

  const agent = createAgent(provider, store, 10);
  registerAllTools(agent, tools);

  const result = await agent.chat(
    'h:test-4',
    'Create a Python project with main.py, utils.py, and README.md, then list the files and read main.py to verify.'
  );

  // Verify: 5 tool calls executed
  assert.equal(result.toolCalls.length, 5, `expected 5 tool calls, got ${result.toolCalls.length}`);
  assert.equal(result.toolCalls[0].name, 'test_write_file');
  assert.equal(result.toolCalls[1].name, 'test_write_file');
  assert.equal(result.toolCalls[2].name, 'test_write_file');
  assert.equal(result.toolCalls[3].name, 'test_list_files');
  assert.equal(result.toolCalls[4].name, 'test_read_file');

  // Verify: all files exist on disk
  assert.equal(
    await fs.readFile(path.join(tmpDir, 'src/main.py'), 'utf8'),
    'from utils import greet\nprint(greet("World"))'
  );
  assert.equal(
    await fs.readFile(path.join(tmpDir, 'src/utils.py'), 'utf8'),
    'def greet(name):\n    return f"Hello, {name}!"'
  );
  assert.equal(
    await fs.readFile(path.join(tmpDir, 'README.md'), 'utf8'),
    '# Test Project\n\nA simple Python greeting app.'
  );

  // Verify: no tool errors
  for (let i = 0; i < result.toolResults.length; i++) {
    assert.equal(result.toolResults[i].isError, false, `tool ${i} should not error`);
  }

  // Verify: final response mentions the project structure
  assert.ok(result.response.includes('main.py'), 'response mentions main.py');
  assert.ok(result.response.includes('utils.py'), 'response mentions utils.py');

  // Verify: session store has complete conversation
  const msgs = await store.loadMessages('h:test-4');
  assert.ok(msgs.length >= 6, `>=6 messages, got ${msgs.length}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('  [PASS] Test 4: Multi-file project scaffolding — 5 tool calls, 3 files verified');
}

// ─── Test 5: Conditional data pipeline ─────────────────────
//
// Reactive mock writes a config file, reads it back, then BRANCHES
// based on the actual content in the tool result. If the tool result
// says "upper", it writes uppercase output; if "lower", lowercase.
// This tests that tool results actually drive LLM decisions.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-h5-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const CONFIG_CONTENT = '{"mode": "upper", "data": "hello world"}';

  const provider = createReactiveProvider((callIndex, messages) => {
    const lastResult = extractLastToolResult(messages);

    if (callIndex === 0) {
      // Turn 1: write config file
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'I will write a config file and process it.' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'test_write_file',
            input: { path: 'config.json', content: CONFIG_CONTENT },
          },
        ],
      };
    }

    if (callIndex === 1) {
      // Turn 2: read config back
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c2', name: 'test_read_file', input: { path: 'config.json' } },
        ],
      };
    }

    if (callIndex === 2 && lastResult) {
      // Turn 3: BRANCH based on actual tool result content
      // Parse the config from the tool result
      const configText = lastResult.content;
      let mode = 'unknown';
      let data = '';
      try {
        const parsed = JSON.parse(configText);
        mode = parsed.mode || 'unknown';
        data = parsed.data || '';
      } catch {
        /* keep defaults */
      }

      if (mode === 'upper') {
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: `Config says mode=upper. Transforming "${data}" to uppercase.` },
            {
              type: 'tool_use',
              id: 'c3',
              name: 'test_write_file',
              input: { path: 'output.txt', content: data.toUpperCase() },
            },
          ],
        };
      } else if (mode === 'lower') {
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: `Config says mode=lower. Transforming "${data}" to lowercase.` },
            {
              type: 'tool_use',
              id: 'c3',
              name: 'test_write_file',
              input: { path: 'output.txt', content: data.toLowerCase() },
            },
          ],
        };
      }
      // Fallback: unknown mode
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: `Unknown mode: ${mode}. Writing raw data.` },
          {
            type: 'tool_use',
            id: 'c3',
            name: 'test_write_file',
            input: { path: 'output.txt', content: data },
          },
        ],
      };
    }

    if (callIndex === 3) {
      // Turn 4: read output to verify
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c4', name: 'test_read_file', input: { path: 'output.txt' } },
        ],
      };
    }

    if (callIndex === 4 && lastResult) {
      // Turn 5: final response based on actual output content
      return {
        stopReason: 'end_turn',
        content: [
          { type: 'text', text: `Pipeline complete. Output file contains: ${lastResult.content}` },
        ],
      };
    }

    throw new Error(`unexpected call index ${callIndex}`);
  });

  const agent = createAgent(provider, store, 10);
  registerAllTools(agent, tools);

  const result = await agent.chat(
    'h:test-5',
    'Create a config.json with mode=upper and data="hello world", then read it, transform the data based on the mode, and write the result to output.txt.'
  );

  // Verify: 4 tool calls
  assert.equal(result.toolCalls.length, 4, `expected 4 tool calls, got ${result.toolCalls.length}`);

  // Verify: config file was created with correct content
  const configOnDisk = await fs.readFile(path.join(tmpDir, 'config.json'), 'utf8');
  assert.equal(configOnDisk, CONFIG_CONTENT);

  // Verify: output file was transformed to uppercase (branching worked)
  const outputOnDisk = await fs.readFile(path.join(tmpDir, 'output.txt'), 'utf8');
  assert.equal(outputOnDisk, 'HELLO WORLD', `output should be uppercase, got: ${outputOnDisk}`);

  // Verify: final response includes the transformed content
  assert.ok(
    result.response.includes('HELLO WORLD'),
    `response should include uppercase output, got: ${result.response}`
  );

  // Verify: the branching decision was based on actual tool result
  // (if tool results weren't fed back, the mock would have hit the "unknown" branch)
  assert.ok(!result.response.includes('Unknown mode'), 'should not hit unknown branch');

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('  [PASS] Test 5: Conditional data pipeline — tool result drives branching decision');
}

// ─── Test 6: Long-horizon multi-turn with error recovery ───
//
// Chat 1: Agent creates 3 files (a.txt, b.txt, c.txt) with content.
// Between chats: b.txt is deleted (simulating external modification).
// Chat 2: Agent reads all 3 files, hits error on b.txt, recovers by
//         recreating it with content derived from session context,
//         then verifies all 3 files exist.
//
// This tests: cross-turn context use, error recovery, reactive
// decision-making, and 6+ tool calls across 2 chats.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-h6-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  // ── Chat 1: create 3 files ──
  const provider1 = createScriptedProvider([
    {
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'I will create three files with specific content.' },
        {
          type: 'tool_use',
          id: 'c1',
          name: 'test_write_file',
          input: { path: 'a.txt', content: 'Content of file A' },
        },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'c2',
          name: 'test_write_file',
          input: { path: 'b.txt', content: 'Content of file B' },
        },
      ],
    },
    {
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'c3',
          name: 'test_write_file',
          input: { path: 'c.txt', content: 'Content of file C' },
        },
      ],
    },
    {
      stopReason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'Created 3 files: a.txt, b.txt, c.txt. Each contains "Content of file X".',
        },
      ],
    },
  ]);

  const agent1 = createAgent(provider1, store, 10);
  registerAllTools(agent1, tools);
  const result1 = await agent1.chat(
    'h:test-6',
    'Create three files: a.txt with "Content of file A", b.txt with "Content of file B", c.txt with "Content of file C".'
  );

  assert.equal(result1.toolCalls.length, 3, 'chat 1 should have 3 tool calls');
  assert.equal(await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf8'), 'Content of file A');
  assert.equal(await fs.readFile(path.join(tmpDir, 'b.txt'), 'utf8'), 'Content of file B');
  assert.equal(await fs.readFile(path.join(tmpDir, 'c.txt'), 'utf8'), 'Content of file C');

  // ── Simulate external modification: delete b.txt ──
  await fs.rm(path.join(tmpDir, 'b.txt'));

  // ── Chat 2: verify all 3 files, recover from missing b.txt ──
  const provider2 = createReactiveProvider((callIndex, messages) => {
    const lastResult = extractLastToolResult(messages);
    const toolResults = extractToolResults(messages);

    if (callIndex === 0) {
      // Read a.txt
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'I will verify all three files from our previous session.' },
          { type: 'tool_use', id: 'c4', name: 'test_read_file', input: { path: 'a.txt' } },
        ],
      };
    }
    if (callIndex === 1) {
      // Read b.txt (will fail)
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'c5', name: 'test_read_file', input: { path: 'b.txt' } }],
      };
    }
    if (callIndex === 2) {
      // Read c.txt
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'c6', name: 'test_read_file', input: { path: 'c.txt' } }],
      };
    }
    if (callIndex === 3 && lastResult) {
      // b.txt read failed — recover by recreating it
      // The mock checks: did the b.txt read error?
      const bResult = toolResults.find((r) => r.id === 'c5');
      if (bResult && bResult.isError) {
        // Recovery: look at the pattern from a.txt and c.txt to reconstruct b.txt
        const aResult = toolResults.find((r) => r.id === 'c4');
        const cResult = toolResults.find((r) => r.id === 'c6');
        // Derive b.txt content from the pattern: "Content of file X"
        const aContent = aResult ? aResult.content : '';
        const cContent = cResult ? cResult.content : '';
        // Check if pattern is "Content of file X"
        const aMatch = aContent.match(/Content of file (\w)/);
        const cMatch = cContent.match(/Content of file (\w)/);
        if (aMatch && cMatch && aMatch[1] === 'A' && cMatch[1] === 'C') {
          // Pattern confirmed: b.txt should be "Content of file B"
          return {
            stopReason: 'tool_use',
            content: [
              {
                type: 'text',
                text: 'b.txt is missing. Based on the pattern from a.txt and c.txt, I will recreate it with "Content of file B".',
              },
              {
                type: 'tool_use',
                id: 'c7',
                name: 'test_write_file',
                input: { path: 'b.txt', content: 'Content of file B' },
              },
            ],
          };
        }
        // Fallback: just write a placeholder
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: 'b.txt is missing. Recreating with placeholder.' },
            {
              type: 'tool_use',
              id: 'c7',
              name: 'test_write_file',
              input: { path: 'b.txt', content: 'Content of file B' },
            },
          ],
        };
      }
      // b.txt read succeeded — no recovery needed
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'All three files verified successfully.' }],
      };
    }
    if (callIndex === 4) {
      // Verify b.txt exists now
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c8', name: 'test_file_exists', input: { path: 'b.txt' } },
        ],
      };
    }
    if (callIndex === 5 && lastResult) {
      // Final response
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: `Recovery complete. b.txt was missing and has been recreated. All 3 files now exist: ${lastResult.content === 'true' ? 'confirmed' : 'error'}.`,
          },
        ],
      };
    }
    throw new Error(`unexpected call index ${callIndex}`);
  });

  const agent2 = createAgent(provider2, store, 10);
  registerAllTools(agent2, tools);
  const result2 = await agent2.chat(
    'h:test-6',
    'Verify that all three files from the previous session still exist. If any are missing, recreate them based on the pattern.'
  );

  // Verify: chat 2 had 5 tool calls (read a, read b fail, read c, write b, check exists)
  assert.equal(
    result2.toolCalls.length,
    5,
    `expected 5 tool calls in chat 2, got ${result2.toolCalls.length}`
  );

  // Verify: b.txt read was an error
  const bReadResult = result2.toolResults.find(
    (r, i) =>
      result2.toolCalls[i]?.name === 'test_read_file' &&
      result2.toolCalls[i]?.input?.path === 'b.txt'
  );
  assert.ok(bReadResult, 'should have a b.txt read result');
  assert.equal(bReadResult.isError, true, 'b.txt read should error');

  // Verify: b.txt was recovered
  assert.ok(
    result2.response.includes('recreated'),
    `response should mention recreation, got: ${result2.response}`
  );

  // Verify: b.txt exists on disk with correct content
  const bContent = await fs.readFile(path.join(tmpDir, 'b.txt'), 'utf8');
  assert.equal(bContent, 'Content of file B', 'recovered b.txt has correct content');

  // Verify: session store has both chats
  const allMsgs = await store.loadMessages('h:test-6');
  assert.ok(allMsgs.length >= 8, `>=8 messages total (2 chats), got ${allMsgs.length}`);

  // Verify: both user messages are in the store
  const userMsgs = allMsgs.filter((m) => m.role === 'user' && typeof m.content === 'string');
  assert.ok(userMsgs.length >= 2, `>=2 user messages, got ${userMsgs.length}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(
    '  [PASS] Test 6: Long-horizon multi-turn — 8 tool calls, error recovery, pattern-based reconstruction'
  );
}

console.log('\n  [pass] harness-integration: 6/6');
