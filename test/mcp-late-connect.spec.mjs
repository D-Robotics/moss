#!/usr/bin/env node
/**
 * MCP tools that connect after the run starts must be callable on the next
 * model call, and a call that arrives during the handshake waits for it.
 * An unreachable server reports failed(reason) instead of staying on
 * "connecting" or answering "Unknown tool".
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatMcpStatusLine } from '../dist/cli/rdk-docs-mcp.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import {
  RDK_DOCS_CONNECTED_LAYER,
  RDK_DOCS_UNAVAILABLE_LAYER,
  rdkDocsKnowledgeLayer,
} from '../dist/core/mcp/rdk-docs.js';
import { McpToolRegistry, buildMcpPromptLayer } from '../dist/core/mcp/registry.js';
import { executeOneToolCall } from '../dist/core/tools/execute-tool-call.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mcp-rdk-docs-server.mjs');

function refreshLayers(registry, layers) {
  layers[0] = [buildMcpPromptLayer(registry), rdkDocsKnowledgeLayer(registry.getStatuses())]
    .filter(Boolean)
    .join('\n');
}

function scriptedProvider(handler) {
  return {
    id: 'late-mcp-test',
    capabilities: { streaming: true },
    async complete() {
      throw new Error('complete is not used');
    },
    stream(request, onEvent) {
      return handler(request, onEvent);
    },
  };
}

function toolResultText(messages) {
  return JSON.stringify(messages);
}

function hashShort(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function recordedMethods(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

test('a call during a 2s MCP connect waits, then the next model call sees the tool', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-late-'));
  const layers = [''];
  const calls = [];
  let registry;
  const agent = new MossAgent({
    llmProvider: scriptedProvider(async (request) => {
      calls.push({
        system: request.systemPrompt,
        tools: (request.tools ?? []).map((tool) => tool.name),
        messages: request.messages,
      });
      if (calls.length === 1) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call-docs',
              name: 'mcp__rdk-docs__search_docs',
              input: { query: 'static ip' },
            },
          ],
          usage: { inputTokens: 10, outputTokens: 4 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'answered from docs' }],
        usage: { inputTokens: 12, outputTokens: 4 },
      };
    }),
    sessionStore: new InMemorySessionStore(),
    model: 'late-mcp-test',
    workspaceDir: workspace,
    baseSystemPrompt: 'Answer directly.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    extraPromptLayers: layers,
    maxAgentTurns: 4,
    resolveMissingTool: (name, signal) => registry.resolveCallableTool(name, signal),
    describeMissingTool: (name) => registry.missingToolReason(name),
  });
  registry = McpToolRegistry.connectInBackground(
    [
      {
        name: 'rdk-docs',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture, '--startup-delay-ms=2000'],
        connectTimeoutMs: 8_000,
        requestTimeoutMs: 5_000,
      },
    ],
    {
      registerTool: (tool) => agent.tools.register(tool),
      onStatusChange: () => refreshLayers(registry, layers),
    }
  );
  try {
    for (const tool of registry.getTools()) agent.tools.register(tool);
    refreshLayers(registry, layers);
    assert.equal(registry.getStatuses()[0].state, 'connecting');
    assert.equal(layers[0], '', 'connecting must not advertise rdk-docs');
    assert.equal(rdkDocsKnowledgeLayer(registry.getStatuses()), '');
    assert.equal(buildMcpPromptLayer(registry), '');

    const started = performance.now();
    const events = [];
    let result;
    for await (const event of agent.streamChat('late-connect', 'how do I set a static IP?')) {
      events.push(event);
      if (event.type === 'done') result = event.result;
    }
    const elapsed = performance.now() - started;
    assert.ok(elapsed >= 1_500, `the call should wait for the 2s handshake, waited ${elapsed}ms`);
    assert.equal(result.response, 'answered from docs');
    assert.ok(calls.length >= 2, `expected a follow-up model call, got ${calls.length}`);

    assert.equal(
      calls[0].tools.includes('mcp__rdk-docs__search_docs'),
      false,
      'search_docs is not in the tool list frozen before connect'
    );
    assert.equal(calls[0].system.includes('official-start'), false);
    assert.equal(calls[0].system.includes('## MCP Tool Servers'), false);

    const followed = toolResultText(calls[1].messages);
    assert.match(followed, /fixture:search_docs/);
    assert.equal(followed.includes('Unknown tool'), false, followed);
    assert.ok(
      calls[1].tools.includes('mcp__rdk-docs__search_docs'),
      `next model call must see the tool registered during connect: ${calls[1].tools.join(',')}`
    );
    assert.match(calls[1].system, /official-start/);
    assert.equal(rdkDocsKnowledgeLayer(registry.getStatuses()), RDK_DOCS_CONNECTED_LAYER);
    assert.match(
      formatMcpStatusLine(registry.getStatuses()[0]),
      /● rdk-docs — connected \(4 tools/
    );
    const metrics = events.find((event) => event.type === 'cache_metrics');
    assert.equal(metrics?.systemPromptHashShort, hashShort(calls[1].system));
    assert.notEqual(metrics?.systemPromptHashShort, hashShort(calls[0].system));
  } finally {
    await registry.closeAll();
    await agent.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('an unreachable MCP server fails with a reason and is not Unknown tool', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-down-'));
  const layers = [''];
  const calls = [];
  let registry;
  const agent = new MossAgent({
    llmProvider: scriptedProvider(async (request) => {
      calls.push({
        system: request.systemPrompt,
        messages: request.messages,
      });
      if (calls.length === 1) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call-docs',
              name: 'mcp__rdk-docs__search_docs',
              input: { query: 'static ip' },
            },
          ],
          usage: { inputTokens: 8, outputTokens: 3 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'manual unavailable' }],
        usage: { inputTokens: 8, outputTokens: 3 },
      };
    }),
    sessionStore: new InMemorySessionStore(),
    model: 'late-mcp-test',
    workspaceDir: workspace,
    baseSystemPrompt: 'Answer directly.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    extraPromptLayers: layers,
    maxAgentTurns: 4,
    resolveMissingTool: (name, signal) => registry.resolveCallableTool(name, signal),
    describeMissingTool: (name) => registry.missingToolReason(name),
  });
  registry = McpToolRegistry.connectInBackground(
    [
      {
        name: 'rdk-docs',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'process.stderr.write("registry unreachable\\n"); process.exit(1)'],
        connectTimeoutMs: 3_000,
        requestTimeoutMs: 3_000,
      },
    ],
    {
      registerTool: (tool) => agent.tools.register(tool),
      onStatusChange: () => refreshLayers(registry, layers),
    }
  );
  try {
    refreshLayers(registry, layers);
    assert.equal(registry.getStatuses()[0].state, 'connecting');
    assert.equal(layers[0], '');

    const direct = await executeOneToolCall(
      { id: 'early', name: 'mcp__rdk-docs__search_docs', input: { query: 'ip' } },
      {
        toolsForRun: [],
        toolCtx: {
          workspaceDir: workspace,
          sessionKey: 'down',
          resolveMissingTool: (name, signal) => registry.resolveCallableTool(name, signal),
          describeMissingTool: (name) => registry.missingToolReason(name),
        },
        sessionKey: 'down',
        abortSignal: new AbortController().signal,
        toolTimeoutMs: 5_000,
        enableHeartbeat: false,
        heartbeatIntervalMs: 1_000,
        skipHeartbeatToolNames: new Set(),
        push() {},
      }
    );
    // The tool object is absent, so the outcome kind stays unknown-tool.
    // The model-facing text is the registry reason, not "Unknown tool".
    assert.equal(direct.kind, 'unknown-tool');
    assert.match(direct.text, /failed to connect/, direct.text);
    assert.equal(direct.text.includes('Unknown tool'), false, direct.text);

    const status = registry.getStatuses()[0];
    assert.equal(status.state, 'failed');
    assert.ok(status.error && status.error.length > 0, status.error);
    assert.match(formatMcpStatusLine(status), /^○ rdk-docs — failed: .+/);
    assert.equal(formatMcpStatusLine(status).includes('connecting'), false);
    assert.equal(rdkDocsKnowledgeLayer(registry.getStatuses()), RDK_DOCS_UNAVAILABLE_LAYER);
    assert.equal(buildMcpPromptLayer(registry).includes('rdk-docs'), false);

    const result = await agent.chat('mcp-down', 'how do I set a static IP?');
    assert.equal(result.response, 'manual unavailable');
    const rendered = calls
      .map((call) => `${call.system}\n${toolResultText(call.messages)}`)
      .join('\n');
    assert.equal(rendered.includes('Unknown tool'), false, rendered);
    assert.match(rendered, /failed to connect/);
    assert.equal(rendered.includes('official-start'), false);
    assert.match(rendered, /unavailable this session/);
  } finally {
    await registry.closeAll();
    await agent.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a tool filter of false never reaches the MCP server as tools/call', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-filter-'));
  const record = path.join(workspace, 'methods.log');
  const calls = [];
  let registry;
  const agent = new MossAgent({
    llmProvider: scriptedProvider(async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call-docs',
              name: 'mcp__rdk-docs__search_docs',
              input: { query: 'static ip' },
            },
          ],
          usage: { inputTokens: 8, outputTokens: 3 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'no tools' }],
        usage: { inputTokens: 8, outputTokens: 3 },
      };
    }),
    sessionStore: new InMemorySessionStore(),
    model: 'late-mcp-test',
    workspaceDir: workspace,
    baseSystemPrompt: 'Answer directly.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
    resolveMissingTool: (name, signal) => registry.resolveCallableTool(name, signal),
    describeMissingTool: (name) => registry.missingToolReason(name),
  });
  registry = McpToolRegistry.connectInBackground(
    [
      {
        name: 'rdk-docs',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture, `--record=${record}`],
        connectTimeoutMs: 8_000,
        requestTimeoutMs: 5_000,
      },
    ],
    { registerTool: (tool) => agent.tools.register(tool) }
  );
  try {
    const result = await agent.chat('mcp-filter', "don't call any tools", {
      toolFilter: () => false,
    });
    assert.equal(result.response, 'no tools');
    const methods = recordedMethods(record);
    assert.equal(methods.includes('tools/call'), false, methods.join(','));
    assert.ok(methods.includes('tools/list'), methods.join(','));
    const rendered = toolResultText(calls[1]?.messages);
    assert.equal(rendered.includes('fixture:search_docs'), false, rendered);
    assert.match(rendered, /Unknown tool/);
  } finally {
    await registry.closeAll();
    await agent.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a resolved MCP tool still goes through approval before tools/call', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approval-'));
  const record = path.join(workspace, 'methods.log');
  const approved = [];
  const calls = [];
  let registry;
  const agent = new MossAgent({
    llmProvider: scriptedProvider(async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return {
          stopReason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call-docs',
              name: 'mcp__rdk-docs__search_docs',
              input: { query: 'static ip' },
            },
          ],
          usage: { inputTokens: 8, outputTokens: 3 },
        };
      }
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'stopped' }],
        usage: { inputTokens: 8, outputTokens: 3 },
      };
    }),
    sessionStore: new InMemorySessionStore(),
    model: 'late-mcp-test',
    workspaceDir: workspace,
    baseSystemPrompt: 'Answer directly.',
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    enableSteering: false,
    enableFollowUpGuard: false,
    maxAgentTurns: 4,
    hooks: {
      onBeforeToolExec: async (request) => {
        approved.push(request.tool.name);
        return { approved: false, reason: 'blocked by test' };
      },
    },
    resolveMissingTool: (name, signal) => registry.resolveCallableTool(name, signal),
    describeMissingTool: (name) => registry.missingToolReason(name),
  });
  registry = McpToolRegistry.connectInBackground(
    [
      {
        name: 'rdk-docs',
        transport: 'stdio',
        command: process.execPath,
        args: [fixture, `--record=${record}`],
        connectTimeoutMs: 8_000,
        requestTimeoutMs: 5_000,
      },
    ],
    { registerTool: (tool) => agent.tools.register(tool) }
  );
  try {
    const result = await agent.chat('mcp-approval', 'look up the static IP steps');
    assert.equal(result.response, 'stopped');
    assert.deepEqual(approved, ['mcp__rdk-docs__search_docs']);
    const methods = recordedMethods(record);
    assert.equal(methods.includes('tools/call'), false, methods.join(','));
    const rendered = toolResultText(calls[1]?.messages);
    assert.match(rendered, /blocked by test/);
    assert.equal(rendered.includes('fixture:search_docs'), false, rendered);
  } finally {
    await registry.closeAll();
    await agent.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
