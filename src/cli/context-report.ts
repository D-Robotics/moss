/**
 * First-request token breakdown for a fresh session in a small workspace.
 *
 * The sections follow the CLI assembly in `cli-main.ts` (system layers, then
 * the tools the model is actually offered). Token counts use the harness
 * estimator (`estimateTokensForText`): CJK characters / 1.5, everything else / 4.
 */
import path from 'node:path';
import { buildSoftwareEngineeringPromptQuick } from '../contracts/prompts/software-engineering-prompt.js';
import { buildLanguagePolicyPromptQuick } from '../contracts/prompts/language-policy-prompt.js';
import { buildAgentBehaviorPromptQuick } from '../contracts/prompts/agent-behavior-prompt.js';
import { estimateTokensForText } from '../context/tokens.js';
import { buildEnvironmentContextLayer } from '../context/environment.js';
import { buildRuntimeCapabilitiesPrompt } from '../context/runtime-capabilities.js';
import { MossAgent, TOOL_RESULT_HANDLING_SECTION } from '../core/agent/moss-agent.js';
import { resolveSoulIdentity } from '../core/agent/soul.js';
import { toolVisibleForRun } from '../core/agent/session-tool-offer.js';
import { InMemorySessionStore } from '../core/session/session.js';
import { buildProviderToolDeclarations } from '../core/loop/agent-loop-context-prep.js';
import { createInitialLoopState } from '../core/loop/agent-loop-state.js';
import { collectNudgeInjections } from '../core/loop/nudges/registry.js';
import { NUDGE_IDS } from '../core/loop/nudges/disable.js';
import { buildMcpStableIndex, mcpSearchToolDeclaration } from '../core/mcp/registry.js';
import { isDeferredToolName } from '../core/tools/deferred-tool-offer.js';
import { RDK_DOCS_SERVER_NAME, rdkDocsKnowledgeLayer } from '../core/mcp/rdk-docs.js';
import {
  buildEmptySkillsHintLayer,
  buildSkillsPromptLayer,
} from '../core/skills/skill-registry.js';
import { bundledRdkDocsSkill, includeBundledRdkDocsSkill } from '../core/skills/rdk-docs-skill.js';
import { createSkillTool } from '../tools/skill-tool.js';
import { registerBuiltinTools } from '../tools/builtin.js';
import { createModelInfoTool } from './model-info-tool.js';
import { buildAgentsMdLayer } from './project-instructions.js';
import { buildAnswerLanguageLayer } from './cli-locale.js';
import { CONSERVATIVE_DEFAULT_UNPROBED } from './config.js';
import type { Tool } from '../core/tools/tool-types.js';
import type { Message } from '../core/session/session-jsonl.js';

export const FRESH_SESSION_USER_MESSAGE =
  'Fix the off-by-one in src/parse.js. Expected behavior is in src/parse.test.js.';

export { TOOL_RESULT_HANDLING_SECTION };

export const CONTEXT_WINDOW_SECTION = (contextTokens: number): string => {
  const ctxK = Math.round(contextTokens / 1000);
  return `## Context Window\nYour context window is ${ctxK}k tokens. State this number accurately when the user asks about context size — do not guess from training knowledge.`;
};

export interface ContextReportSection {
  name: string;
  tokens: number;
  chars: number;
}

export interface ContextReportToolRow {
  name: string;
  tokens: number;
  chars: number;
}

export interface FreshSessionContextReport {
  workspaceDir: string;
  /** Headless coding session: task tools stay offered, device tools do not. */
  taskFlow: boolean | undefined;
  rdkDocsConnected: boolean;
  userMessage: string;
  sections: ContextReportSection[];
  tools: ContextReportToolRow[];
  nudgeTokens: number;
  nudgeCount: number;
  nudgeCatalogSize: number;
  systemTokens: number;
  /** Persona, contracts, and project instructions. Provider caches key off this. */
  stableTokens: number;
  /** Environment, MCP/skills, and the context-window line. */
  dynamicTokens: number;
  toolTokens: number;
  userTokens: number;
  requestTokens: number;
  systemPrompt: string;
  stablePrompt: string;
}

export interface FreshSessionContextReportOptions {
  workspaceDir: string;
  /** When true, include the rdk-docs index, usage line, search tool, and skill. */
  rdkDocsConnected?: boolean;
  /**
   * `undefined` matches headless `moss -p` (task ledger tools offered).
   * `false` matches interactive chat that did not ask for a task contract.
   */
  taskFlow?: boolean;
  deviceConfigured?: boolean;
  contextTokens?: number;
  userMessage?: string;
  /** Locale forwarded to the answer-language layer. Default: no zh layer. */
  locale?: string;
  now?: Date;
}

function tokensOf(text: string): ContextReportSection['tokens'] {
  return estimateTokensForText(text);
}

function section(name: string, text: string): ContextReportSection {
  return { name, tokens: tokensOf(text), chars: text.length };
}

function toolRow(name: string, payload: string): ContextReportToolRow {
  return { name, tokens: tokensOf(payload), chars: payload.length };
}

/**
 * Stable MCP index for a configured rdk-docs server. No tool counts — those
 * change when the handshake finishes and must not sit in the cached prefix.
 * Matches `buildMcpStableIndex` in cli-main, which is pushed as soon as the
 * server is configured (including `moss -p`, before npx connects).
 */
export function connectedRdkDocsMcpLayer(): string {
  return buildMcpStableIndex([RDK_DOCS_SERVER_NAME]);
}

export async function buildFreshSessionContextReport(
  options: FreshSessionContextReportOptions
): Promise<FreshSessionContextReport> {
  const rdkDocsConnected = options.rdkDocsConnected === true;
  const deviceConfigured = options.deviceConfigured === true;
  const contextTokens = options.contextTokens ?? CONSERVATIVE_DEFAULT_UNPROBED;
  const userMessage = options.userMessage ?? FRESH_SESSION_USER_MESSAGE;
  const locale = options.locale ?? 'C';

  const identity = resolveSoulIdentity({
    workspaceDir: options.workspaceDir,
    model: 'context-report',
  });
  const language = buildLanguagePolicyPromptQuick();
  const engineering = buildSoftwareEngineeringPromptQuick();
  const behavior = buildAgentBehaviorPromptQuick();
  const toolHandling = TOOL_RESULT_HANDLING_SECTION;
  const environment = await buildEnvironmentContextLayer(options.workspaceDir, {
    ...(options.now ? { now: () => options.now as Date } : {}),
  });
  const agents = buildAgentsMdLayer(options.workspaceDir);
  const answerLanguage = buildAnswerLanguageLayer(locale);
  const skillDirs = [
    path.join(options.workspaceDir, '.moss', 'skills'),
    path.join(options.workspaceDir, '.config', 'skills'),
  ];
  const skills = rdkDocsConnected
    ? includeBundledRdkDocsSkill([], true)
    : includeBundledRdkDocsSkill([], false);
  const skillsLayer =
    skills.length > 0
      ? (buildSkillsPromptLayer(skills) ?? '')
      : buildEmptySkillsHintLayer(skillDirs);
  const mcpLayer = rdkDocsConnected ? connectedRdkDocsMcpLayer() : '';
  const rdkLayer = rdkDocsConnected
    ? rdkDocsKnowledgeLayer([{ name: RDK_DOCS_SERVER_NAME, state: 'connected' }])
    : '';
  const contextWindow = CONTEXT_WINDOW_SECTION(contextTokens);

  const agent = new MossAgent({
    llmProvider: {
      id: 'context-report',
      displayName: 'context-report',
      capabilities: { streaming: false },
      async complete() {
        return {
          stopReason: 'end_turn' as const,
          content: [{ type: 'text' as const, text: '' }],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
      async stream() {
        return {
          stopReason: 'end_turn' as const,
          content: [{ type: 'text' as const, text: '' }],
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    },
    sessionStore: new InMemorySessionStore(),
    model: 'context-report',
    workspaceDir: options.workspaceDir,
    baseSystemPrompt: identity,
    domainPrompt: () => engineering,
    extraPromptLayers: [],
    enableSteering: false,
    includeLanguagePolicyPrompt: true,
    includeAgentBehaviorPrompt: true,
  });
  registerBuiltinTools(agent);
  agent.tools.replace(
    createModelInfoTool({
      provider: () => agent.config.llmProvider,
      config: () => ({ model: 'context-report' }),
      getContextTokens: () => contextTokens,
    })
  );
  if (rdkDocsConnected) {
    agent.tools.register(createSkillTool([bundledRdkDocsSkill()]));
    const declared = mcpSearchToolDeclaration(RDK_DOCS_SERVER_NAME);
    const searchTool: Tool = {
      name: declared.name,
      description: declared.description,
      metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
      inputSchema: declared.inputSchema,
      async execute() {
        return '';
      },
    };
    agent.tools.register(searchTool);
  }

  const runtime = buildRuntimeCapabilitiesPrompt({ tools: agent.tools.getAll() });
  const stableLayers = [agents, answerLanguage, mcpLayer, runtime].filter(
    (layer) => layer.trim().length > 0
  );
  const dynamicLayers = [environment, rdkLayer, skillsLayer, contextWindow].filter(
    (layer) => layer.trim().length > 0
  );
  agent.config.extraPromptLayers = stableLayers;
  agent.config.dynamicPromptLayers = dynamicLayers;
  const composed = agent.composeSystemPrompt();
  const systemPrompt = composed.full;

  const labeled: ContextReportSection[] = [
    section('identity', identity),
    section('language policy', language),
    section('software engineering', engineering),
    section('agent behavior', behavior),
    section('tool result handling', toolHandling),
    section('environment', environment),
    section('AGENTS.md / project context', agents),
    section('answer language', answerLanguage),
    section('MCP guide', [mcpLayer, rdkLayer].filter(Boolean).join('\n')),
    section('skills', skillsLayer),
    section('runtime capabilities', runtime),
    section('context window', contextWindow),
  ];

  const offered = agent.tools.getAll().filter(
    (tool) =>
      !isDeferredToolName(tool.name) &&
      toolVisibleForRun(tool.name, {
        ...(options.taskFlow === undefined ? {} : { taskFlow: options.taskFlow }),
        deviceConfigured,
      })
  );
  const declarations = buildProviderToolDeclarations(offered);
  const tools = declarations.map((tool) => {
    const payload = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    });
    return toolRow(tool.name, payload);
  });
  const toolsPayload = JSON.stringify(
    declarations.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  );

  const state = createInitialLoopState();
  const history: Message[] = [{ role: 'user', content: userMessage, timestamp: Date.now() }];
  const injected = collectNudgeInjections({
    state,
    currentMessages: history,
    lastUserText: () => userMessage,
    buildCorrectionMessage: (systemText) => ({
      role: 'user',
      content: systemText,
      timestamp: Date.now(),
    }),
  });
  const nudgeText = injected
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n\n');

  const systemTokens = tokensOf(systemPrompt);
  const toolTokens = tokensOf(toolsPayload);
  const userTokens = tokensOf(userMessage);
  const nudgeTokens = tokensOf(nudgeText);

  return {
    workspaceDir: options.workspaceDir,
    taskFlow: options.taskFlow,
    rdkDocsConnected,
    userMessage,
    sections: labeled,
    tools,
    nudgeTokens,
    nudgeCount: injected.length,
    nudgeCatalogSize: NUDGE_IDS.length,
    systemTokens,
    stableTokens: tokensOf(composed.stable),
    dynamicTokens: tokensOf(composed.dynamic),
    toolTokens,
    userTokens,
    requestTokens: systemTokens + toolTokens + userTokens + nudgeTokens,
    systemPrompt,
    stablePrompt: composed.stable,
  };
}

export function formatContextReport(report: FreshSessionContextReport): string {
  const lines: string[] = [];
  const task =
    report.taskFlow === undefined ? 'headless (task tools offered)' : `taskFlow=${report.taskFlow}`;
  lines.push('Moss first-request context report');
  lines.push(`workspace: ${report.workspaceDir}`);
  lines.push(
    `scenario: fresh session, no device, ${task}, rdk-docs ${report.rdkDocsConnected ? 'connected' : 'not connected yet'}`
  );
  lines.push(`estimator: CJK/1.5 + other/4 (estimateTokensForText)`);
  lines.push('');
  lines.push('system prompt');
  const nameWidth = Math.max(28, ...report.sections.map((row) => row.name.length));
  for (const row of report.sections) {
    lines.push(
      `  ${row.name.padEnd(nameWidth)} ${String(row.tokens).padStart(6)}  (${row.chars} chars)`
    );
  }
  lines.push(`  ${'stable prefix'.padEnd(nameWidth)} ${String(report.stableTokens).padStart(6)}`);
  lines.push(`  ${'dynamic suffix'.padEnd(nameWidth)} ${String(report.dynamicTokens).padStart(6)}`);
  lines.push(`  ${'TOTAL system'.padEnd(nameWidth)} ${String(report.systemTokens).padStart(6)}`);
  lines.push('');
  lines.push('tools');
  const toolWidth = Math.max(28, ...report.tools.map((row) => row.name.length));
  for (const row of report.tools) {
    lines.push(
      `  ${row.name.padEnd(toolWidth)} ${String(row.tokens).padStart(6)}  (${row.chars} chars)`
    );
  }
  lines.push(`  ${'TOTAL tools'.padEnd(toolWidth)} ${String(report.toolTokens).padStart(6)}`);
  lines.push('');
  lines.push(
    `user message${''.padEnd(Math.max(0, nameWidth - 'user message'.length))} ${String(report.userTokens).padStart(6)}`
  );
  lines.push(
    `nudges injected (${report.nudgeCount}/${report.nudgeCatalogSize} catalog)`.padEnd(
      nameWidth + 2
    ) + String(report.nudgeTokens).padStart(6)
  );
  lines.push(`REQUEST TOTAL`.padEnd(nameWidth + 2) + String(report.requestTokens).padStart(6));
  return lines.join('\n');
}
