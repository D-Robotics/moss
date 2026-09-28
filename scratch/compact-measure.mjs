#!/usr/bin/env node
/**
 * Compaction measurement driver (O2 follow-up decision data).
 * Builds a realistic long session from real repo files, forces compaction
 * on the REAL configured model, and reports effectiveness metrics.
 *
 * Usage: node scratch/compact-measure.mjs [label]
 * Set MOSS_REMOTE_COMPACT_ENDPOINT to measure the remote arm.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { MossAgent, InMemorySessionStore } from '../dist/core/index.js';
import { createCliProvider } from '../dist/cli/providers.js';
import { resolveCliConfig } from '../dist/cli/config.js';
import { estimateMessagesTokens } from '../dist/context/tokens.js';

const label = process.argv[2] ?? (process.env.MOSS_REMOTE_COMPACT_ENDPOINT ? 'remote' : 'local');

const FILES = [
  'src/cli/doctor.ts',
  'src/cli/providers.ts',
  'src/cli/repl.ts',
  'src/cli/session-usage.ts',
  'src/cli/commands/registry.ts',
  'src/provider/pi-ai-http-transport.ts',
  'src/provider/multi-provider-router.ts',
  'src/core/loop/agent-loop-compaction.ts',
];

function fileText(rel, cap = 20_000) {
  return fs.readFileSync(path.resolve(rel), 'utf8').slice(0, cap);
}

function buildHistory() {
  const msgs = [];
  let toolSeq = 0;
  msgs.push({
    role: 'user',
    content:
      'We are working in the moss repo. Read the listed files and keep their contents in mind; I will ask follow-up questions after.',
  });
  for (const rel of FILES) {
    toolSeq += 1;
    msgs.push({
      role: 'user',
      content: `Please read ${rel} and tell me what it does.`,
    });
    msgs.push({
      role: 'assistant',
      content: [
        { type: 'text', text: `Reading ${rel} now.` },
        {
          type: 'tool_use',
          id: `tu_${toolSeq}`,
          name: 'read_file',
          input: { file_path: rel },
        },
      ],
    });
    msgs.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `tu_${toolSeq}`,
          content: fileText(rel),
          is_error: false,
        },
      ],
    });
    msgs.push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `${rel}: this module is part of the CLI/provider surface. Key details: it handles part of the request pipeline and error reporting. (analysis of ${rel}, round ${toolSeq})`,
        },
      ],
    });
  }
  // A work segment with exec + edit so tool diversity is measurable.
  toolSeq += 1;
  msgs.push({
    role: 'user',
    content: 'Run the test suite and fix any failure you find in the provider transport.',
  });
  msgs.push({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running the provider specs first.' },
      {
        type: 'tool_use',
        id: `tu_${toolSeq}`,
        name: 'exec',
        input: { command: 'npm run test:filter -- --filter cli-provider' },
      },
    ],
  });
  msgs.push({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `tu_${toolSeq}`,
        content: '[PASS] Provider routing and error handling\n[test] passed 1 file(s)\nexit 0',
        is_error: false,
      },
    ],
  });
  toolSeq += 1;
  msgs.push({
    role: 'user',
    content:
      'Now edit src/provider/pi-ai-http-transport.ts to add a retry hint comment near the fetch call.',
  });
  msgs.push({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Applying the edit.' },
      {
        type: 'tool_use',
        id: `tu_${toolSeq}`,
        name: 'edit_file',
        input: {
          file_path: 'src/provider/pi-ai-http-transport.ts',
          old_string: 'const res = await fetchWithConnectionContext',
          new_string:
            '// bounded retry happens upstream in MultiProviderRouter\n    const res = await fetchWithConnectionContext',
        },
      },
    ],
  });
  msgs.push({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: `tu_${toolSeq}`,
        content: 'OK: applied 1 edit.',
        is_error: false,
      },
    ],
  });
  msgs.push({
    role: 'user',
    content:
      'Good. Now compact this conversation; I want the next model call to still know which files we reviewed and what we changed.',
  });
  return msgs;
}

function distinctToolNames(messages) {
  const names = new Set();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b.type === 'tool_use' && b.name) names.add(b.name);
  }
  return [...names];
}

const resolved = resolveCliConfig();
const provider = createCliProvider({
  provider: resolved.provider,
  apiKey: resolved.apiKey,
  model: resolved.model,
  baseUrl: resolved.baseUrl,
});

const store = new InMemorySessionStore();
const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: store,
  model: resolved.model,
  workspaceDir: process.cwd(),
  baseSystemPrompt: 'You are Moss, a coding agent.',
  domainPrompt: false,
  includeAgentBehaviorPrompt: false,
  enableSteering: false,
});

const sessionKey = `measure-${label}`;
const history = buildHistory();
const tokensBefore = estimateMessagesTokens(history);
await store.replaceMessages(sessionKey, history);
const toolNamesBefore = distinctToolNames(history);

const t0 = performance.now();
const result = await agent.compactSession(sessionKey);
const elapsedMs = performance.now() - t0;

const after = await store.loadMessages(sessionKey);
const tokensAfter = estimateMessagesTokens(after);
const toolNamesAfter = distinctToolNames(after);

const summary = result.summary ?? '';
const summaryLines = summary.split('\n');
const restoreIdx = summary.indexOf('<restored-files>');

const filesRetained = FILES.filter((rel) => summary.includes(rel));
const toolsRetained = toolNamesAfter.length;

console.log(
  JSON.stringify(
    {
      label,
      model: resolved.model,
      remoteEndpoint: process.env.MOSS_REMOTE_COMPACT_ENDPOINT ?? null,
      messagesBefore: history.length,
      messagesAfter: after.length,
      tokensBefore,
      tokensAfter,
      compressionRatio: Number((tokensAfter / tokensBefore).toFixed(3)),
      droppedMessages: result.droppedMessages,
      summaryChars: result.summaryChars,
      toolNamesBefore: toolNamesBefore.length,
      toolNamesAfter: toolsRetained,
      filesRetainedInSummary: `${filesRetained.length}/${FILES.length}`,
      retainedFileList: filesRetained,
      elapsedMs: Math.round(elapsedMs),
      summaryPreview: summary.slice(0, 500),
      summaryModelChars: restoreIdx > 0 ? summary.slice(0, restoreIdx).length : summary.length,
      summaryRestoreChars: restoreIdx > 0 ? summary.length - restoreIdx : 0,
    },
    null,
    2
  )
);
