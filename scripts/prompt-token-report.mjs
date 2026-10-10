#!/usr/bin/env node
/**
 * Per-section cl100k token counts for a fresh interactive turn and `moss -p`.
 *
 * Tokenizer: tiktoken cl100k_base, the same encoding the gateway prompt_tokens
 * figure was checked against. Run after `npm run build`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEncoding } from 'js-tiktoken';

import { buildAgentBehaviorPromptQuick } from '../dist/contracts/prompts/agent-behavior-prompt.js';
import {
  FRESH_SESSION_USER_MESSAGE,
  buildFreshSessionContextReport,
} from '../dist/cli/context-report.js';
import { oneShotToolFilterForMessage } from '../dist/cli/oneshot.js';
import { MossAgent } from '../dist/core/agent/moss-agent.js';
import { toolVisibleForRun } from '../dist/core/agent/session-tool-offer.js';
import { isDeferredToolName } from '../dist/core/tools/deferred-tool-offer.js';
import { InMemorySessionStore } from '../dist/core/session/session.js';
import { buildProviderToolDeclarations } from '../dist/core/loop/agent-loop-context-prep.js';
import { mcpSearchToolDeclaration } from '../dist/core/mcp/registry.js';
import { RDK_DOCS_SERVER_NAME } from '../dist/core/mcp/rdk-docs.js';
import { bundledRdkDocsSkill } from '../dist/core/skills/rdk-docs-skill.js';
import { registerBuiltinTools } from '../dist/tools/builtin.js';
import { createSkillTool } from '../dist/tools/skill-tool.js';
import { createModelInfoTool } from '../dist/cli/model-info-tool.js';

const enc = getEncoding('cl100k_base');

export function countTokens(text) {
  if (!text) return 0;
  return enc.encode(text).length;
}

function sliceBetween(text, startMarker, endMarkers) {
  const start = text.indexOf(startMarker);
  if (start < 0) return '';
  let end = text.length;
  for (const marker of endMarkers) {
    const at = text.indexOf(marker, start + startMarker.length);
    if (at >= 0 && at < end) end = at;
  }
  return text.slice(start, end).trim();
}

export function smallPromptRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-prompt-tokens-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', 'parse.js'),
    'export function parse(text) {\n  return text.split(",").slice(1);\n}\n'
  );
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Project\n\nRun `npm test`. Do not push.\n');
  return dir;
}

function providerStub() {
  return {
    id: 'prompt-tokens',
    displayName: 'prompt-tokens',
    capabilities: { streaming: false },
    async complete() {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '' }],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async stream() {
      return {
        stopReason: 'end_turn',
        content: [{ type: 'text', text: '' }],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

function declarationsFor(taskFlow) {
  const agent = new MossAgent({
    llmProvider: providerStub(),
    sessionStore: new InMemorySessionStore(),
    model: 'prompt-tokens',
    workspaceDir: process.cwd(),
    enableSteering: false,
    domainPrompt: false,
    includeAgentBehaviorPrompt: false,
    includeLanguagePolicyPrompt: false,
  });
  registerBuiltinTools(agent);
  agent.tools.replace(
    createModelInfoTool({
      provider: () => agent.config.llmProvider,
      config: () => ({ model: 'prompt-tokens' }),
      getContextTokens: () => 1_000_000,
    })
  );
  agent.tools.register(createSkillTool([bundledRdkDocsSkill()]));
  const declared = mcpSearchToolDeclaration(RDK_DOCS_SERVER_NAME);
  agent.tools.register({
    name: declared.name,
    description: declared.description,
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: declared.inputSchema,
    async execute() {
      return '';
    },
  });
  const offered = agent.tools.getAll().filter(
    (tool) =>
      !isDeferredToolName(tool.name) &&
      toolVisibleForRun(tool.name, {
        ...(taskFlow === undefined ? {} : { taskFlow }),
        deviceConfigured: false,
        // Interactive chat has the TUI asker. Headless `-p` (taskFlow unset) does not.
        userQuestions: taskFlow === false,
        requiresUserQuestion: tool.metadata?.requiresUserQuestion === true,
      })
  );
  return buildProviderToolDeclarations(offered).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function toolWire(declarations) {
  return JSON.stringify(declarations);
}

export function summarizeDeclarations(declarations) {
  const rows = declarations
    .map((tool) => ({
      name: tool.name,
      tokens: countTokens(JSON.stringify(tool)),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));
  return { rows, count: declarations.length, tokens: countTokens(toolWire(declarations)) };
}

function promptSections(systemPrompt, behavior) {
  const doing = sliceBetween(behavior, '# Doing tasks', ['\n# ']);
  const mcpIndex = sliceBetween(systemPrompt, '## MCP Tool Servers', ['\n## ', '\n# ']);
  const rdkManuals = sliceBetween(systemPrompt, '### RDK manuals', ['\n## ', '\n# ']);
  const mcp = [mcpIndex, rdkManuals].filter(Boolean).join('\n');
  const named = [
    ['identity', 'You are Moss', ['\n## ', '\n# ']],
    ['language policy', '## Language', ['\n## ', '\n# ']],
    ['software engineering', '## Software Engineering', ['\n## ', '\n# ']],
    ['agent behavior', '# System', ['\n## Tool Result Handling']],
    ['tool result handling', '## Tool Result Handling', ['\n## ', '\n# ']],
    ['environment', '# Environment', ['\n## ', '\n# ']],
    ['project context', '## Project context', ['\n## ', '\n# ']],
    ['MCP', '## MCP Tool Servers', ['\n## ', '\n# ']],
    ['skills', '## Available skills', ['\n## ', '\n# ']],
    ['runtime capabilities', '## Runtime Capabilities', ['\n## ', '\n# ']],
    ['context window', '## Context Window', ['\n## ', '\n# ']],
  ];
  return {
    doingTasksTokens: countTokens(doing),
    mcpTokens: countTokens(mcp),
    sections: named
      .map(([name, start, ends]) => ({
        name,
        tokens: countTokens(sliceBetween(systemPrompt, start, ends)),
      }))
      .filter((row) => row.tokens > 0),
  };
}

export async function measurePromptTokens(workspaceDir) {
  const interactiveReport = await buildFreshSessionContextReport({
    workspaceDir,
    rdkDocsConnected: true,
    taskFlow: false,
    userQuestions: true,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });
  const printReport = await buildFreshSessionContextReport({
    workspaceDir,
    rdkDocsConnected: true,
    userQuestions: false,
    now: new Date('2026-10-10T00:00:00.000Z'),
  });
  const behavior = buildAgentBehaviorPromptQuick();
  const filter = oneShotToolFilterForMessage(FRESH_SESSION_USER_MESSAGE);
  const interactiveDecls = declarationsFor(false);
  const printDecls = declarationsFor(undefined).filter((tool) => filter({ name: tool.name }));
  const interactiveTools = summarizeDeclarations(interactiveDecls);
  const printTools = summarizeDeclarations(printDecls);
  const pack = (report, tools) => {
    const sections = promptSections(report.systemPrompt, behavior);
    const systemTokens = countTokens(report.systemPrompt);
    const stableTokens = countTokens(report.stablePrompt);
    const dynamicText = report.systemPrompt.startsWith(report.stablePrompt)
      ? report.systemPrompt.slice(report.stablePrompt.length).replace(/^\n+/, '')
      : '';
    const userTokens = countTokens(report.userMessage);
    return {
      ...sections,
      systemTokens,
      stableTokens,
      dynamicTokens: countTokens(dynamicText),
      userTokens,
      toolCount: tools.count,
      toolTokens: tools.tokens,
      toolRows: tools.rows,
      requestTokens: systemTokens + tools.tokens + userTokens,
      systemPrompt: report.systemPrompt,
      stablePrompt: report.stablePrompt,
    };
  };
  return {
    interactive: pack(interactiveReport, interactiveTools),
    print: pack(printReport, printTools),
  };
}

function pad(text, width) {
  return String(text).padEnd(width);
}

function formatScenario(label, summary) {
  const lines = [
    `## ${label}`,
    '',
    `request ${summary.requestTokens}  system ${summary.systemTokens} (stable ${summary.stableTokens} + dynamic ${summary.dynamicTokens})  tools ${summary.toolCount} / ${summary.toolTokens}  user ${summary.userTokens}`,
    `Doing tasks ${summary.doingTasksTokens}   MCP section ${summary.mcpTokens}`,
    '',
    'sections',
  ];
  for (const row of summary.sections) {
    lines.push(`  ${pad(row.name, 28)} ${String(row.tokens).padStart(5)}`);
  }
  lines.push('', 'tools');
  for (const row of summary.toolRows) {
    lines.push(`  ${pad(row.name, 32)} ${String(row.tokens).padStart(5)}`);
  }
  return lines.join('\n');
}

async function main() {
  const dir = smallPromptRepo();
  try {
    const measured = await measurePromptTokens(dir);
    process.stdout.write(
      [
        'Moss prompt token report (tiktoken cl100k_base)',
        '',
        formatScenario('interactive (taskFlow=false, rdk-docs connected)', measured.interactive),
        '',
        formatScenario('moss -p (coding prompt, rdk-docs connected)', measured.print),
        '',
      ].join('\n') + '\n'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
