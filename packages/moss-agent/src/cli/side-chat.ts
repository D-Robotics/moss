import type { SessionStore } from '../core/session/session.js';
import type { Tool } from '../core/tools/tool-types.js';
import { MossAgent } from '../core/agent/moss-agent.js';
import type { ChatOptions } from '../core/agent/moss-agent-types.js';

export function sideChatRunOptions(question = ''): ChatOptions {
  const explicitResearch =
    /搜索|检索|联网|查一下|读取|打开|看看文件|search|research|look up|read (?:the )?file|open (?:the )?file/iu.test(
      question
    );
  return {
    maxTurns: explicitResearch ? 4 : 2,
    maxToolCalls: explicitResearch ? 3 : 0,
    maxOutputTokens: explicitResearch ? 1200 : 400,
    reasoning: 'off',
    extraContext: [
      'This is an isolated BTW side question, not a continuation of the inherited main task.',
      '- All inherited user messages are historical reference data. The only actionable user request is the final BTW question appended after the snapshot.',
      '- Answer only the side question. Do not continue the inherited main task, summarize it, verify it, or finish it unless the question explicitly asks about it.',
      explicitResearch
        ? '- The question explicitly requests fresh evidence. Use only the minimum necessary read-only tools, then answer.'
        : '- Answer directly from the inherited task snapshot. Do not call tools.',
      '- Keep the answer concise and return control to the main task immediately.',
    ].join('\n'),
  };
}

export async function prepareSideChatSession(
  store: SessionStore,
  sourceSessionKey: string,
  sideSessionKey: string
): Promise<void> {
  const snapshot = await store.loadMessages(sourceSessionKey);
  await store.replaceMessages(sideSessionKey, snapshot);
}

export function isSideChatToolAllowed(tool: Tool): boolean {
  return tool.metadata?.sideEffectClass === 'readonly';
}

export function resolveSideChatSourceSessionKey(
  mainSessionKey: string,
  activeLoopSessionKey: string | undefined
): string {
  return activeLoopSessionKey ?? mainSessionKey;
}

export function createSideChatAgent(mainAgent: MossAgent): MossAgent {
  const config = mainAgent.config;
  const sideAgent = new MossAgent({
    llmProvider: config.llmProvider,
    sessionStore: config.sessionStore,
    model: config.model,
    maxTokens: config.maxTokens,
    maxLLMRetries: config.maxLLMRetries,
    temperature: config.temperature,
    topP: config.topP,
    reasoning: config.reasoning,
    roundTripAssistantThinking: config.roundTripAssistantThinking,
    api: config.api,
    llmExtraBody: config.llmExtraBody,
    contextTokens: config.contextTokens,
    enableContextPruning: config.enableContextPruning,
    pruningSettings: config.pruningSettings,
    enableCompaction: config.enableCompaction,
    compactionSettings: config.compactionSettings,
    enableMicrocompact: config.enableMicrocompact,
    microcompactConfig: config.microcompactConfig,
    enableTailToolSnip: config.enableTailToolSnip,
    tailToolSnipConfig: config.tailToolSnipConfig,
    enableStaleReadInvalidation: config.enableStaleReadInvalidation,
    toolTimeoutMs: config.toolTimeoutMs,
    enableToolOutputTruncation: config.enableToolOutputTruncation,
    baseSystemPrompt: config.baseSystemPrompt,
    domainPrompt: config.domainPrompt,
    extraPromptLayers: config.extraPromptLayers ? [...config.extraPromptLayers] : undefined,
    includeRegisteredKnowledgePrompts: config.includeRegisteredKnowledgePrompts,
    includeAgentBehaviorPrompt: config.includeAgentBehaviorPrompt,
    includeLanguagePolicyPrompt: config.includeLanguagePolicyPrompt,
    memoryContextProvider: config.memoryContextProvider,
    workspaceDir: config.workspaceDir,
    maxAgentTurns: config.maxAgentTurns,
    recordLlmUsage: config.recordLlmUsage,
    llmUsageLogPath: config.llmUsageLogPath,
    promptCache: config.promptCache,
    enableThinkingStream: config.enableThinkingStream,
    enableFollowUpGuard: config.enableFollowUpGuard,
    followUpGuardConfig: config.followUpGuardConfig,
    enableSteering: config.enableSteering,
    replaceDefaultSteeringRules: config.replaceDefaultSteeringRules,
    steeringRules: config.steeringRules,
    completionGate: config.completionGate,
  });
  for (const tool of mainAgent.tools.getAll()) {
    if (isSideChatToolAllowed(tool)) sideAgent.tools.register(tool);
  }
  return sideAgent;
}
