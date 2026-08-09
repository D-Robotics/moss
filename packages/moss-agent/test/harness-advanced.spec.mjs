#!/usr/bin/env node
/**
 * Harness advanced tests — hardest end-to-end scenarios.
 *
 * Co-designed by Musk (first-principles pressure testing) and Jobs
 * (judgment and self-correction). Each test pushes a different limit:
 *
 *   7. Self-correction loop — agent detects its own error and fixes it
 *   8. Cross-file dependency chain — output of tool A drives tool B's input
 *   9. Autonomous debugging workflow — multi-chat, multi-file, self-diagnosis
 *  10. Long-horizon state tracking — 10+ tool calls, systematic operations
 *
 * The reactive mock inspects options.messages to make real decisions
 * based on actual tool results — no hardcoded answers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';

// ─── Shared infrastructure (same as harness-integration.spec.mjs) ────────

/** @typedef {import('../dist/core/llm/llm-provider.js').LLMResponse} LLMResponse */
/** @typedef {import('../dist/core/llm/llm-provider.js').LLMMessage} LLMMessage */
/** @typedef {import('../dist/core/llm/llm-provider.js').LLMRequestOptions} LLMRequestOptions */
/** @typedef {import('../dist/core/llm/llm-provider.js').LLMStreamEvent} LLMStreamEvent */

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
function lastToolResult(messages) {
  const r = extractToolResults(messages);
  return r[r.length - 1] || null;
}

/** @param {LLMMessage[]} messages */
function allUserText(messages) {
  return messages
    .filter((m) => m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content);
}

/**
 * @param {(callIndex: number, messages: LLMMessage[], systemPrompt?: string) => LLMResponse} decideFn
 */
function createReactiveProvider(decideFn) {
  let i = 0;
  return {
    id: 'reactive-mock',
    displayName: 'Reactive Mock LLM',
    async complete(options) {
      return decideFn(i++, options.messages, options.systemPrompt);
    },
    async stream(options, onEvent) {
      const resp = decideFn(i++, options.messages, options.systemPrompt);
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

/** @param {string} baseDir */
function createTestTools(baseDir) {
  const resolvedBase = path.resolve(baseDir);
  function resolvePath(relPath) {
    const joined = path.resolve(resolvedBase, relPath);
    if (!joined.startsWith(resolvedBase)) throw new Error('path traversal blocked');
    return joined;
  }
  return {
    testWriteFile: {
      name: 'test_write_file',
      description: 'Write content to a file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      async execute(input) {
        const p = resolvePath(input.path);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, input.content, 'utf8');
        return `Wrote ${input.content.length} bytes to ${input.path}`;
      },
    },
    testReadFile: {
      name: 'test_read_file',
      description: 'Read a file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(input) {
        try {
          return await fs.readFile(resolvePath(input.path), 'utf8');
        } catch (e) {
          if (e.code === 'ENOENT') throw new Error(`File not found: ${input.path}`);
          throw e;
        }
      },
    },
    testListFiles: {
      name: 'test_list_files',
      description: 'List files in a directory.',
      inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
      async execute(input) {
        const d = input.dir ? resolvePath(input.dir) : resolvedBase;
        return (await fs.readdir(d, { withFileTypes: true }))
          .map((e) => `${e.isDirectory() ? 'DIR ' : 'FILE'} ${e.name}`)
          .join('\n');
      },
    },
    testFileExists: {
      name: 'test_file_exists',
      description: 'Check if a file exists.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(input) {
        try {
          await fs.access(resolvePath(input.path));
          return 'true';
        } catch {
          return 'false';
        }
      },
    },
    testDeleteFile: {
      name: 'test_delete_file',
      description: 'Delete a file.',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async execute(input) {
        await fs.rm(resolvePath(input.path), { force: true });
        return `Deleted ${input.path}`;
      },
    },
  };
}

function createAgent(provider, store, maxTurns = 12) {
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
  for (const t of Object.values(tools)) agent.tools.register(t);
}

// ─── Test 7: Self-correction loop ──────────────────────────
//
// Agent writes a JSON file with a deliberate syntax error, reads it
// back, the reactive mock DETECTS the error by inspecting the tool
// result content, writes a corrected version, and reads it again
// to verify the fix.
//
// This tests META-COGNITIVE ability: agent must verify its own work
// and take corrective action based on what it finds.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-adv7-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const BROKEN_JSON = '{"name": "test", "value": 42, "active": true,}';
  const FIXED_JSON = '{"name": "test", "value": 42, "active": true}';

  const provider = createReactiveProvider((callIndex, messages) => {
    const last = lastToolResult(messages);

    if (callIndex === 0) {
      // Write a deliberately broken JSON file
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'I will write a config file.' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'test_write_file',
            input: { path: 'config.json', content: BROKEN_JSON },
          },
        ],
      };
    }

    if (callIndex === 1) {
      // Read it back to verify
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c2', name: 'test_read_file', input: { path: 'config.json' } },
        ],
      };
    }

    if (callIndex === 2 && last) {
      // INSPECT the actual tool result — try to parse it as JSON
      const content = last.content;
      let parseError = null;
      try {
        JSON.parse(content);
      } catch (e) {
        parseError = e.message;
      }

      if (parseError) {
        // Detected the error! Fix it.
        // The mock knows the fix: remove the trailing comma
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'text',
              text: `JSON parse error detected: ${parseError}. Fixing by removing trailing comma.`,
            },
            {
              type: 'tool_use',
              id: 'c3',
              name: 'test_write_file',
              input: { path: 'config.json', content: FIXED_JSON },
            },
          ],
        };
      }
      // No error — already valid, done
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Config file is valid JSON.' }],
      };
    }

    if (callIndex === 3) {
      // Read the fixed version to verify
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c4', name: 'test_read_file', input: { path: 'config.json' } },
        ],
      };
    }

    if (callIndex === 4 && last) {
      // Verify the fix worked
      let valid = false;
      try {
        JSON.parse(last.content);
        valid = true;
      } catch {}
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: valid
              ? 'Self-correction successful. Config is now valid JSON.'
              : 'Fix did not work.',
          },
        ],
      };
    }

    throw new Error(`unexpected call ${callIndex}`);
  });

  const agent = createAgent(provider, store);
  registerAllTools(agent, tools);
  const result = await agent.chat(
    'adv:test-7',
    'Write a config.json file and verify it is valid JSON. If not, fix it.'
  );

  // Verify: 4 tool calls (write broken, read, write fixed, read)
  assert.equal(result.toolCalls.length, 4, `expected 4 tool calls, got ${result.toolCalls.length}`);
  assert.equal(result.toolCalls[0].name, 'test_write_file', 'first: write');
  assert.equal(result.toolCalls[1].name, 'test_read_file', 'second: read (verify)');
  assert.equal(result.toolCalls[2].name, 'test_write_file', 'third: write (fix)');
  assert.equal(result.toolCalls[3].name, 'test_read_file', 'fourth: read (verify fix)');

  // Verify: file on disk is the FIXED version
  const finalContent = await fs.readFile(path.join(tmpDir, 'config.json'), 'utf8');
  assert.equal(finalContent, FIXED_JSON, 'file should contain fixed JSON');
  assert.doesNotThrow(() => JSON.parse(finalContent), 'file should be valid JSON');

  // Verify: response confirms self-correction
  assert.ok(
    result.response.includes('successful') || result.response.includes('valid'),
    'response confirms fix'
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('  [PASS] Test 7: Self-correction loop — agent detects JSON error and fixes it');
}

// ─── Test 8: Cross-file dependency chain ───────────────────
//
// Agent writes a "schema" file that defines a transformation rule,
// writes a "data" file, reads both, then applies the rule from the
// schema to the data and writes the result. The reactive mock must
// read BOTH tool results to produce the correct output.
//
// This tests CROSS-FILE REASONING: the decision depends on data
// from two independent tool calls, not just the last one.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-adv8-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const SCHEMA = '{"operation": "reverse", "separator": "-"}';
  const DATA = 'hello world foo bar';

  const provider = createReactiveProvider((callIndex, messages) => {
    const results = extractToolResults(messages);

    if (callIndex === 0) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'I will create a schema and data file, then process them.' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'test_write_file',
            input: { path: 'schema.json', content: SCHEMA },
          },
        ],
      };
    }
    if (callIndex === 1) {
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'c2',
            name: 'test_write_file',
            input: { path: 'data.txt', content: DATA },
          },
        ],
      };
    }
    if (callIndex === 2) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c3', name: 'test_read_file', input: { path: 'schema.json' } },
        ],
      };
    }
    if (callIndex === 3) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c4', name: 'test_read_file', input: { path: 'data.txt' } },
        ],
      };
    }
    if (callIndex === 4) {
      // Must read BOTH tool results to compute the output
      const schemaResult = results.find((r) => r.id === 'c3');
      const dataResult = results.find((r) => r.id === 'c4');
      assert.ok(schemaResult, 'schema result must be present');
      assert.ok(dataResult, 'data result must be present');

      let operation = 'unknown';
      let separator = '';
      try {
        const schema = JSON.parse(schemaResult.content);
        operation = schema.operation;
        separator = schema.separator;
      } catch {}

      let output = dataResult.content;
      if (operation === 'reverse') {
        // Split by space, reverse words, join with separator
        output = output.split(' ').reverse().join(separator);
      } else if (operation === 'sort') {
        output = output.split(' ').sort().join(separator);
      } else {
        output = `unknown operation: ${operation}`;
      }

      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'text',
            text: `Applying ${operation} with separator "${separator}". Result: ${output}`,
          },
          {
            type: 'tool_use',
            id: 'c5',
            name: 'test_write_file',
            input: { path: 'output.txt', content: output },
          },
        ],
      };
    }
    if (callIndex === 5) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c6', name: 'test_read_file', input: { path: 'output.txt' } },
        ],
      };
    }
    if (callIndex === 6) {
      const last = lastToolResult(messages);
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `Pipeline complete. Output: ${last?.content || 'empty'}` }],
      };
    }
    throw new Error(`unexpected call ${callIndex}`);
  });

  const agent = createAgent(provider, store);
  registerAllTools(agent, tools);
  const result = await agent.chat(
    'adv:test-8',
    'Create schema.json with operation=reverse and separator="-", create data.txt with "hello world foo bar", read both, apply the schema operation to the data, and write the result.'
  );

  // Verify: 6 tool calls
  assert.equal(result.toolCalls.length, 6, `expected 6 tool calls, got ${result.toolCalls.length}`);

  // Verify: output is correctly computed from BOTH files
  const expectedOutput = 'bar-foo-world-hello';
  const outputOnDisk = await fs.readFile(path.join(tmpDir, 'output.txt'), 'utf8');
  assert.equal(
    outputOnDisk,
    expectedOutput,
    `output should be "${expectedOutput}", got "${outputOnDisk}"`
  );

  // Verify: response includes the computed result
  assert.ok(
    result.response.includes(expectedOutput),
    `response should include "${expectedOutput}"`
  );

  // Verify: the computation used data from BOTH tool results
  // (if either was missing, the mock would have thrown)
  assert.ok(!result.response.includes('unknown operation'), 'should not hit unknown branch');

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log('  [PASS] Test 8: Cross-file dependency chain — schema + data -> computed output');
}

// ─── Test 9: Autonomous debugging workflow (THE ULTIMATE TEST)
//
// Chat 1: Agent creates a 3-file "project" with a deliberate bug:
//   - config.json has a typo: "destnation" instead of "destination"
//   - data.txt has content "Hello World"
//   - run.txt has instructions: "Read config.json, find 'destination' key, read file at that path"
//
// Chat 2: Agent follows the instructions, discovers the typo by
// inspecting the actual config content, fixes it, then completes
// the pipeline. 9 tool calls across 2 chats.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-adv9-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const BROKEN_CONFIG = '{"destnation": "data.txt"}';
  const FIXED_CONFIG = '{"destination": "data.txt"}';
  const DATA_CONTENT = 'Hello World';
  const RUN_INSTRUCTIONS =
    'Read config.json, find the "destination" key, read the file at that path, write its content to output.txt';

  // ── Chat 1: Create the project ──
  const provider1 = createReactiveProvider((callIndex) => {
    if (callIndex === 0)
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'I will create a 3-file project.' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'test_write_file',
            input: { path: 'config.json', content: BROKEN_CONFIG },
          },
        ],
      };
    if (callIndex === 1)
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'c2',
            name: 'test_write_file',
            input: { path: 'data.txt', content: DATA_CONTENT },
          },
        ],
      };
    if (callIndex === 2)
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'c3',
            name: 'test_write_file',
            input: { path: 'run.txt', content: RUN_INSTRUCTIONS },
          },
        ],
      };
    if (callIndex === 3)
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: 'Project created: config.json, data.txt, run.txt. Note: config.json has a key "destnation" which should be "destination".',
          },
        ],
      };
    throw new Error(`chat 1: unexpected call ${callIndex}`);
  });

  const agent1 = createAgent(provider1, store);
  registerAllTools(agent1, tools);
  const result1 = await agent1.chat(
    'adv:test-9',
    'Create a project: config.json with destination=data.txt, data.txt with "Hello World", and run.txt with instructions to read config and follow the destination.'
  );

  assert.equal(result1.toolCalls.length, 3, 'chat 1: 3 tool calls');
  assert.equal(
    await fs.readFile(path.join(tmpDir, 'config.json'), 'utf8'),
    BROKEN_CONFIG,
    'config has the typo'
  );

  // ── Chat 2: Follow instructions, discover bug, fix, complete ──
  const provider2 = createReactiveProvider((callIndex, messages) => {
    const results = extractToolResults(messages);
    const last = lastToolResult(messages);

    if (callIndex === 0) {
      // Read instructions
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'I will follow the instructions in run.txt.' },
          { type: 'tool_use', id: 'c4', name: 'test_read_file', input: { path: 'run.txt' } },
        ],
      };
    }
    if (callIndex === 1) {
      // Read config to find the destination
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c5', name: 'test_read_file', input: { path: 'config.json' } },
        ],
      };
    }
    if (callIndex === 2 && last) {
      // DIAGNOSE: inspect the actual config content for the "destination" key
      let parsed = null;
      try {
        parsed = JSON.parse(last.content);
      } catch {}

      if (parsed && parsed.destination) {
        // Config is correct — read the data file
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: `Destination found: ${parsed.destination}. Reading it.` },
            {
              type: 'tool_use',
              id: 'c6',
              name: 'test_read_file',
              input: { path: parsed.destination },
            },
          ],
        };
      }
      if (parsed && parsed.destnation) {
        // BUG DETECTED: typo in key name
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'text',
              text: 'Bug found: config.json has key "destnation" (typo). It should be "destination". Fixing it.',
            },
            {
              type: 'tool_use',
              id: 'c6',
              name: 'test_write_file',
              input: { path: 'config.json', content: FIXED_CONFIG },
            },
          ],
        };
      }
      // Config is completely broken
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'Config is unparseable. Rewriting from scratch.' },
          {
            type: 'tool_use',
            id: 'c6',
            name: 'test_write_file',
            input: { path: 'config.json', content: FIXED_CONFIG },
          },
        ],
      };
    }
    if (callIndex === 3) {
      // After fix: re-read config to confirm
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c7', name: 'test_read_file', input: { path: 'config.json' } },
        ],
      };
    }
    if (callIndex === 4 && last) {
      // Now config should have the correct key
      let parsed = null;
      try {
        parsed = JSON.parse(last.content);
      } catch {}
      const dest = parsed?.destination;
      if (dest) {
        return {
          stopReason: 'tool_use',
          content: [
            { type: 'text', text: `Config fixed. Destination: ${dest}. Reading data file.` },
            { type: 'tool_use', id: 'c8', name: 'test_read_file', input: { path: dest } },
          ],
        };
      }
      throw new Error('config still broken after fix');
    }
    if (callIndex === 5) {
      // Write output.txt with the data content
      const dataResult = results.find((r) => r.id === 'c8');
      const dataContent = dataResult?.content || '';
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: `Writing data to output.txt: ${dataContent}` },
          {
            type: 'tool_use',
            id: 'c9',
            name: 'test_write_file',
            input: { path: 'output.txt', content: dataContent },
          },
        ],
      };
    }
    if (callIndex === 6) {
      // Verify output
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c10', name: 'test_read_file', input: { path: 'output.txt' } },
        ],
      };
    }
    if (callIndex === 7 && last) {
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: `Debugging complete. Fixed config.json typo (destnation -> destination). Pipeline output: ${last.content}`,
          },
        ],
      };
    }
    throw new Error(`chat 2: unexpected call ${callIndex}`);
  });

  const agent2 = createAgent(provider2, store);
  registerAllTools(agent2, tools);
  const result2 = await agent2.chat(
    'adv:test-9',
    'Follow the instructions in run.txt. If you find any errors in config.json, fix them first.'
  );

  // Verify: chat 2 had 7 tool calls (read run, read config, fix config, read config, read data, write output, read output)
  assert.equal(
    result2.toolCalls.length,
    7,
    `expected 7 tool calls in chat 2, got ${result2.toolCalls.length}`
  );

  // Verify: config.json was fixed
  const finalConfig = await fs.readFile(path.join(tmpDir, 'config.json'), 'utf8');
  assert.equal(finalConfig, FIXED_CONFIG, 'config should be fixed');
  const parsed = JSON.parse(finalConfig);
  assert.ok(parsed.destination, 'config has correct "destination" key');
  assert.ok(!parsed.destnation, 'config does not have typo "destnation"');

  // Verify: output.txt contains the correct data
  const outputContent = await fs.readFile(path.join(tmpDir, 'output.txt'), 'utf8');
  assert.equal(outputContent, DATA_CONTENT, 'output should contain data from data.txt');

  // Verify: response mentions the bug fix
  assert.ok(
    result2.response.includes('fix') || result2.response.includes('Fixed'),
    'response mentions the fix'
  );
  assert.ok(result2.response.includes(DATA_CONTENT), 'response includes the final output');

  // Verify: total tool calls across both chats
  const totalCalls = result1.toolCalls.length + result2.toolCalls.length;
  assert.equal(totalCalls, 10, `expected 10 total tool calls, got ${totalCalls}`);

  // Verify: session store has both chats
  const allMsgs = await store.loadMessages('adv:test-9');
  assert.ok(allMsgs.length >= 8, `>=8 messages total, got ${allMsgs.length}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(
    '  [PASS] Test 9: Autonomous debugging — 10 tool calls, typo diagnosis + fix + pipeline completion'
  );
}

// ─── Test 10: Long-horizon state tracking ──────────────────
//
// Agent performs 10+ systematic operations: create 3 files, verify
// each, list all, delete one, verify deletion, verify others survive,
// recreate deleted file, verify all 3 exist again. The reactive mock
// tracks state across all operations.
//
// This tests LONG-HORIZON CONSISTENCY: does the agent maintain
// accurate state awareness across many tool calls?

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-adv10-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const FILES = [
    { path: 'alpha.txt', content: 'Alpha content' },
    { path: 'beta.txt', content: 'Beta content' },
    { path: 'gamma.txt', content: 'Gamma content' },
  ];

  const provider = createReactiveProvider((callIndex, messages) => {
    const results = extractToolResults(messages);
    const last = lastToolResult(messages);

    // Phase 1: Create 3 files (calls 0-2)
    if (callIndex >= 0 && callIndex <= 2) {
      const file = FILES[callIndex];
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: `c${callIndex + 1}`,
            name: 'test_write_file',
            input: { path: file.path, content: file.content },
          },
        ],
      };
    }

    // Phase 2: Verify each file exists (calls 3-5)
    if (callIndex >= 3 && callIndex <= 5) {
      const file = FILES[callIndex - 3];
      return {
        stopReason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: `c${callIndex + 1}`,
            name: 'test_file_exists',
            input: { path: file.path },
          },
        ],
      };
    }

    // Phase 3: List all files (call 6)
    if (callIndex === 6) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'c7', name: 'test_list_files', input: {} }],
      };
    }

    // Phase 4: Delete beta.txt (call 7)
    if (callIndex === 7) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'Deleting beta.txt to test state tracking.' },
          { type: 'tool_use', id: 'c8', name: 'test_delete_file', input: { path: 'beta.txt' } },
        ],
      };
    }

    // Phase 5: Verify beta is gone, alpha and gamma survive (calls 8-10)
    if (callIndex === 8) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c9', name: 'test_file_exists', input: { path: 'beta.txt' } },
        ],
      };
    }
    if (callIndex === 9) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c10', name: 'test_file_exists', input: { path: 'alpha.txt' } },
        ],
      };
    }
    if (callIndex === 10) {
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c11', name: 'test_file_exists', input: { path: 'gamma.txt' } },
        ],
      };
    }

    // Phase 6: Recreate beta.txt (call 11)
    if (callIndex === 11) {
      // Verify the previous results: beta should be false, alpha and gamma true
      const betaResult = results.find((r) => r.id === 'c9');
      const alphaResult = results.find((r) => r.id === 'c10');
      const gammaResult = results.find((r) => r.id === 'c11');

      // The mock checks actual tool results
      if (
        betaResult?.content === 'false' &&
        alphaResult?.content === 'true' &&
        gammaResult?.content === 'true'
      ) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'text',
              text: 'State verified: beta deleted, alpha and gamma intact. Recreating beta.',
            },
            {
              type: 'tool_use',
              id: 'c12',
              name: 'test_write_file',
              input: { path: 'beta.txt', content: FILES[1].content },
            },
          ],
        };
      }
      throw new Error(
        `state verification failed: beta=${betaResult?.content} alpha=${alphaResult?.content} gamma=${gammaResult?.content}`
      );
    }

    // Phase 7: Final verification — all 3 files exist (call 12)
    if (callIndex === 12) {
      return {
        stopReason: 'tool_use',
        content: [{ type: 'tool_use', id: 'c13', name: 'test_list_files', input: {} }],
      };
    }

    // Final response (call 13)
    if (callIndex === 13 && last) {
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: `Long-horizon task complete. All 3 files verified. Final listing: ${last.content}`,
          },
        ],
      };
    }

    throw new Error(`unexpected call ${callIndex}`);
  });

  const agent = createAgent(provider, store, 15);
  registerAllTools(agent, tools);
  const result = await agent.chat(
    'adv:test-10',
    'Create alpha.txt, beta.txt, gamma.txt. Verify each exists. List all. Delete beta. Verify beta is gone but alpha and gamma survive. Recreate beta. List all again.'
  );

  // Verify: 13 tool calls
  assert.equal(
    result.toolCalls.length,
    13,
    `expected 13 tool calls, got ${result.toolCalls.length}`
  );

  // Verify: all 3 files exist at the end
  assert.equal(await fs.readFile(path.join(tmpDir, 'alpha.txt'), 'utf8'), 'Alpha content');
  assert.equal(await fs.readFile(path.join(tmpDir, 'beta.txt'), 'utf8'), 'Beta content');
  assert.equal(await fs.readFile(path.join(tmpDir, 'gamma.txt'), 'utf8'), 'Gamma content');

  // Verify: the state verification at call 11 actually checked real results
  // (if it didn't, the mock would have thrown)
  assert.ok(result.response.includes('complete'), 'response confirms completion');

  // Verify: no tool errors (except none — delete is force:true)
  for (let i = 0; i < result.toolResults.length; i++) {
    // The test_file_exists for beta after deletion returns 'false' but isError is false
    assert.equal(result.toolResults[i].isError, false, `tool ${i} should not error`);
  }

  // Verify: session store has the full conversation
  const msgs = await store.loadMessages('adv:test-10');
  assert.ok(msgs.length >= 10, `>=10 messages, got ${msgs.length}`);

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(
    '  [PASS] Test 10: Long-horizon state tracking — 13 tool calls, delete + verify + recreate'
  );
}

// ─── Test 11: Context compaction survival ──────────────────
//
// THE HARDEST TEST: Does key information survive context compaction?
//
// Agent writes a file containing a secret code, reads it back, writes
// a large filler file, reads that back. The tiny context window (600
// tokens) forces compaction mid-conversation. The mock detects
// summarization calls (system prompt contains "摘要") and returns a
// summary preserving the secret code.
//
// Chat 2 asks for the code. The mock checks options.messages for the
// code. If compaction dropped it, the mock returns "I don't know" and
// the test FAILS — proving the compaction pipeline is lossy.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-adv11-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const SECRET_CODE = 'BANANA-7749';
  const FILLER = 'X'.repeat(8000); // large enough to push estimated tokens over the 3600-token hard cap

  // Track whether we've seen a summarization call
  let sawCompaction = false;

  const provider = createReactiveProvider((callIndex, messages, systemPrompt) => {
    // Detect summarization calls by checking the system prompt
    if (systemPrompt && systemPrompt.includes('摘要')) {
      sawCompaction = true;
      // The conversation text is in messages[0].content — extract key info
      const convText = typeof messages[0]?.content === 'string' ? messages[0].content : '';
      // Build a summary that preserves the secret code
      const hasSecret = convText.includes(SECRET_CODE);
      const summary = `<summary>User asked to create a file with a secret code. The secret code is ${hasSecret ? SECRET_CODE : 'UNKNOWN'}. A filler file was also created. The secret was written to secret.txt and verified by reading it back.</summary>`;
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: summary }],
      };
    }

    // Regular chat calls
    if (callIndex === 0) {
      // Write secret file
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'I will write a file with a secret code.' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'test_write_file',
            input: { path: 'secret.txt', content: `The secret code is ${SECRET_CODE}` },
          },
        ],
      };
    }
    if (callIndex === 1) {
      // Read secret back
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c2', name: 'test_read_file', input: { path: 'secret.txt' } },
        ],
      };
    }
    if (callIndex === 2) {
      // Write a large filler file to push context over the limit
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'Writing a large filler file.' },
          {
            type: 'tool_use',
            id: 'c3',
            name: 'test_write_file',
            input: { path: 'filler.txt', content: FILLER },
          },
        ],
      };
    }
    if (callIndex === 3) {
      // Read filler back (adds more messages, triggers compaction)
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'tool_use', id: 'c4', name: 'test_read_file', input: { path: 'filler.txt' } },
        ],
      };
    }
    // After the 4 tool-use calls, return the final response.
    // This call may be at index 4 (no compaction) or index 5 (compaction consumed one call).
    if (callIndex >= 4) {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: `Done. The secret code is ${SECRET_CODE}.` }],
      };
    }

    throw new Error(`unexpected call ${callIndex} (sawCompaction=${sawCompaction})`);
  });

  // Create agent with tiny context window to force compaction
  const agent = new MossAgent({
    llmProvider: provider,
    sessionStore: store,
    baseSystemPrompt: 'You are a test agent.',
    domainPrompt: false,
    maxAgentTurns: 10,
    enableSteering: false,
    enableFollowUpGuard: false,
    contextTokens: 600,
    enableCompaction: true,
    compactionSettings: {
      enabled: true,
      keepRecentTokens: 50,
      reserveTokens: 100,
      restoreFileContents: false,
    },
  });
  registerAllTools(agent, tools);

  const result1 = await agent.chat(
    'adv:test-11',
    'Write secret.txt with "The secret code is BANANA-7749", read it back, then write a large filler.txt and read it back.'
  );

  // Verify: chat 1 completed and mentioned the secret
  assert.ok(result1.response.includes(SECRET_CODE), 'chat 1 response includes secret code');

  // Verify: compaction must have been triggered. The filler size is calibrated so that
  // estimated prompt tokens exceed the 3600-token hard cap. If this assertion fails,
  // increase FILLER or reduce contextTokens/keepRecentTokens.

  // ── Chat 2: ask for the secret code ──
  const provider2 = createReactiveProvider((callIndex, messages) => {
    // Search ALL messages (including compaction summary) for the secret code
    const allText = messages
      .map((m) => {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content))
          return m.content
            .map((b) => {
              if (b.type === 'text') return b.text;
              if (b.type === 'tool_result') return b.content;
              return '';
            })
            .join(' ');
        return '';
      })
      .join(' ');

    if (allText.includes(SECRET_CODE)) {
      return {
        stopReason: 'end_turn',
        content: [
          {
            type: 'text',
            text: `The secret code from our previous conversation is ${SECRET_CODE}.`,
          },
        ],
      };
    }
    return {
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'I have no record of any secret code in our conversation.' }],
    };
  });

  const agent2 = new MossAgent({
    llmProvider: provider2,
    sessionStore: store,
    baseSystemPrompt: 'You are a test agent.',
    domainPrompt: false,
    maxAgentTurns: 3,
    enableSteering: false,
    enableFollowUpGuard: false,
    contextTokens: 600,
  });

  const result2 = await agent2.chat(
    'adv:test-11',
    'What was the secret code I asked you to remember?'
  );

  // THE KEY ASSERTION: the secret code must be accessible after compaction
  assert.ok(
    result2.response.includes(SECRET_CODE),
    `secret code must survive compaction — got: "${result2.response}"`
  );
  assert.ok(
    !result2.response.includes('no record'),
    'must not say "no record" — context should preserve the secret'
  );

  // Assert that compaction truly triggered (filler is calibrated for this)
  assert.ok(
    sawCompaction,
    'compaction must trigger — reduce contextTokens or increase filler if this fails'
  );

  console.log(
    `  [PASS] Test 11: Context compaction survival — secret "${SECRET_CODE}" preserved (compaction triggered)`
  );

  await fs.rm(tmpDir, { recursive: true, force: true });
}

// ─── Test 12: Concurrent tool failure recovery ─────────────
//
// The mock issues 3 tool_use blocks in ONE LLM response. One tool
// fails (read nonexistent file), two succeed. The mock's next
// response must reference ALL 3 tool results — proving the agent
// loop correctly feeds back mixed success/failure results.
//
// This tests PARALLEL tool execution and mixed-result handling.

{
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-adv12-'));
  const store = new InMemorySessionStore();
  const tools = createTestTools(tmpDir);

  const provider = createReactiveProvider((callIndex, messages) => {
    if (callIndex === 0) {
      // Issue 3 tool calls in ONE response — mixed success/failure
      return {
        stopReason: 'tool_use',
        content: [
          { type: 'text', text: 'I will run 3 operations simultaneously.' },
          {
            type: 'tool_use',
            id: 'c1',
            name: 'test_write_file',
            input: { path: 'ok1.txt', content: 'success data' },
          },
          {
            type: 'tool_use',
            id: 'c2',
            name: 'test_read_file',
            input: { path: 'nonexistent.txt' },
          },
          { type: 'tool_use', id: 'c3', name: 'test_list_files', input: {} },
        ],
      };
    }

    if (callIndex === 1) {
      // Check that ALL 3 tool results are present in messages
      const results = extractToolResults(messages);
      const writeResult = results.find((r) => r.id === 'c1');
      const readResult = results.find((r) => r.id === 'c2');
      const listResult = results.find((r) => r.id === 'c3');

      // All 3 results must be present
      if (!writeResult) throw new Error('write result missing from messages');
      if (!readResult) throw new Error('read result missing from messages');
      if (!listResult) throw new Error('list result missing from messages');

      // Verify mixed results: write succeeded, read failed, list succeeded
      const parts = [];
      if (!writeResult.isError) parts.push(`write succeeded: ${writeResult.content}`);
      else parts.push(`write failed: ${writeResult.content}`);

      if (readResult.isError) parts.push(`read correctly failed: ${readResult.content}`);
      else parts.push(`read unexpectedly succeeded: ${readResult.content}`);

      if (!listResult.isError) parts.push(`list succeeded: ${listResult.content}`);
      else parts.push(`list failed: ${listResult.content}`);

      return {
        stopReason: 'end_turn',
        content: [
          { type: 'text', text: `Concurrent operations complete. Results: ${parts.join('; ')}` },
        ],
      };
    }

    throw new Error(`unexpected call ${callIndex}`);
  });

  const agent = createAgent(provider, store, 5);
  registerAllTools(agent, tools);
  const result = await agent.chat(
    'adv:test-12',
    'Write ok1.txt with "success data", read nonexistent.txt, and list files — all at once.'
  );

  // Verify: 3 tool calls in one turn
  assert.equal(result.toolCalls.length, 3, `expected 3 tool calls, got ${result.toolCalls.length}`);

  // Verify: mixed results — write success, read error, list success
  assert.equal(result.toolResults[0].isError, false, 'write should succeed');
  assert.equal(result.toolResults[1].isError, true, 'read should fail (file not found)');
  assert.equal(result.toolResults[2].isError, false, 'list should succeed');

  // Verify: the mock's response references ALL 3 results
  assert.ok(result.response.includes('write succeeded'), 'response references write result');
  assert.ok(result.response.includes('read correctly failed'), 'response references read failure');
  assert.ok(result.response.includes('list succeeded'), 'response references list result');

  // Verify: file was actually created
  assert.equal(await fs.readFile(path.join(tmpDir, 'ok1.txt'), 'utf8'), 'success data');

  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log(
    '  [PASS] Test 12: Concurrent tool failure recovery — 3 tools in 1 turn, mixed success/failure'
  );
}

console.log('\n  [pass] harness-advanced: 6/6');
