


















import {
  COMPACTION_SUMMARY_PREFIX,
  type ContentBlock,
  type Message,
} from '../core/session/session-jsonl.js';
import { CHARS_PER_TOKEN_ESTIMATE, estimateMessageChars, estimateMessagesChars } from './tokens.js';













const MIN_MESSAGE_HISTORY_TOKEN_UNITS = 4096;









export type ContextPruningToolMatch = {
  
  allow?: string[];
  
  deny?: string[];
};







function makeToolPrunablePredicate(match?: ContextPruningToolMatch): (toolName: string) => boolean {
  if (!match) return () => true;

  const deny = match.deny ?? [];
  const allow = match.allow ?? [];

  return (toolName: string) => {
    const normalized = toolName.trim().toLowerCase();
    if (deny.some((pattern) => matchStarPattern(normalized, pattern.toLowerCase()))) {
      return false;
    }
    if (allow.length === 0) {
      return true;
    }
    return allow.some((pattern) => matchStarPattern(normalized, pattern.toLowerCase()));
  };
}


function matchStarPattern(value: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return value === pattern;

  const parts = pattern.split('*');
  
  if (parts[0] !== '' && !value.startsWith(parts[0])) return false;
  let pos = parts[0].length;

  
  for (let i = 1; i < parts.length - 1; i++) {
    if (parts[i] === '') continue;
    const idx = value.indexOf(parts[i], pos);
    if (idx === -1) return false;
    pos = idx + parts[i].length;
  }

  
  const last = parts[parts.length - 1];
  if (last === '') return true;
  return value.length >= pos + last.length && value.endsWith(last);
}



export type ContextPruningSettings = {
  
  maxHistoryShare: number;
  
  keepLastAssistants: number;
  
  softTrimRatio: number;
  
  hardClearRatio: number;
  
  minPrunableToolChars: number;
  
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
  
  tools: ContextPruningToolMatch;
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: ContextPruningSettings = {
  maxHistoryShare: 0.5,
  keepLastAssistants: 3,
  softTrimRatio: 0.3,
  hardClearRatio: 0.5,
  minPrunableToolChars: 50_000,
  softTrim: {
    maxChars: 4_000,
    headChars: 1_500,
    tailChars: 1_500,
  },
  hardClear: {
    enabled: true,
    placeholder: '[Old tool result content cleared]',
  },
  tools: {},
};

export type PruneResult = {
  messages: Message[];
  droppedMessages: Message[];
  trimmedToolResults: number;
  hardClearedToolResults: number;
  totalChars: number;
  keptChars: number;
  droppedChars: number;
  budgetChars: number;
};

function clampShare(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function parseEnvNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function resolveEnvPruningSettings(base: ContextPruningSettings): Partial<ContextPruningSettings> {
  return {
    maxHistoryShare: parseEnvNumber('MOSS_CONTEXT_MAX_HISTORY_SHARE'),
    keepLastAssistants: parseEnvNumber('MOSS_CONTEXT_KEEP_LAST_ASSISTANTS'),
    softTrimRatio: parseEnvNumber('MOSS_CONTEXT_SOFT_TRIM_RATIO'),
    hardClearRatio: parseEnvNumber('MOSS_CONTEXT_HARD_CLEAR_RATIO'),
    minPrunableToolChars: base.minPrunableToolChars,
  };
}

export function resolvePruningSettings(
  raw?: Partial<ContextPruningSettings>
): ContextPruningSettings {
  const d = DEFAULT_CONTEXT_PRUNING_SETTINGS;
  const envSettings = resolveEnvPruningSettings(d);
  const source = {
    ...envSettings,
    ...(raw ?? {}),
  };
  return {
    maxHistoryShare: clampShare(source.maxHistoryShare ?? d.maxHistoryShare, d.maxHistoryShare),
    keepLastAssistants: clampPositiveInt(source.keepLastAssistants, d.keepLastAssistants),
    softTrimRatio: clampShare(source.softTrimRatio ?? d.softTrimRatio, d.softTrimRatio),
    hardClearRatio: clampShare(source.hardClearRatio ?? d.hardClearRatio, d.hardClearRatio),
    minPrunableToolChars: clampPositiveInt(source.minPrunableToolChars, d.minPrunableToolChars),
    softTrim: {
      maxChars: clampPositiveInt(source.softTrim?.maxChars, d.softTrim.maxChars),
      headChars: clampPositiveInt(source.softTrim?.headChars, d.softTrim.headChars),
      tailChars: clampPositiveInt(source.softTrim?.tailChars, d.softTrim.tailChars),
    },
    hardClear: {
      enabled: source.hardClear?.enabled ?? d.hardClear.enabled,
      placeholder: source.hardClear?.placeholder ?? d.hardClear.placeholder,
    },
    tools: source.tools ?? d.tools,
  };
}



function cloneMessage(message: Message, content: Message['content']): Message {
  return { ...message, content };
}















function softTrimToolResultBlock(
  block: ContentBlock,
  settings: ContextPruningSettings['softTrim'],
  isPrunable: (toolName: string) => boolean
): { block: ContentBlock; trimmed: boolean } {
  if (block.type !== 'tool_result') {
    return { block, trimmed: false };
  }

  if (block.name && !isPrunable(block.name)) {
    return { block, trimmed: false };
  }

  const raw = typeof block.content === 'string' ? block.content : '';
  const rawLen = raw.length;
  if (rawLen <= settings.maxChars) {
    return { block, trimmed: false };
  }

  const headChars = Math.max(0, settings.headChars);
  const tailChars = Math.max(0, settings.tailChars);
  if (headChars + tailChars >= rawLen) {
    return { block, trimmed: false };
  }

  const head = raw.slice(0, headChars);
  const tail = raw.slice(rawLen - tailChars);
  const trimmedText = `${head}\n...\n${tail}\n\n[Tool result trimmed: kept first ${headChars} chars and last ${tailChars} chars of ${rawLen} chars.]`;

  return {
    block: { ...block, content: trimmedText },
    trimmed: true,
  };
}

function applySoftTrim(
  messages: Message[],
  settings: ContextPruningSettings,
  isPrunable: (toolName: string) => boolean
): { messages: Message[]; trimmedToolResults: number; savedChars: number } {
  let trimmedToolResults = 0;
  let savedChars = 0;
  const output: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      output.push(msg);
      continue;
    }

    let didChange = false;
    const nextBlocks: ContentBlock[] = [];
    for (const block of msg.content) {
      const result = softTrimToolResultBlock(block, settings.softTrim, isPrunable);
      if (result.trimmed) {
        trimmedToolResults += 1;
        didChange = true;
        const beforeLen = typeof block.content === 'string' ? block.content.length : 0;
        const afterLen =
          typeof result.block.content === 'string' ? result.block.content.length : 0;
        savedChars += Math.max(0, beforeLen - afterLen);
      }
      nextBlocks.push(result.block);
    }

    output.push(didChange ? cloneMessage(msg, nextBlocks) : msg);
  }

  return { messages: output, trimmedToolResults, savedChars };
}






function countPrunableToolChars(
  messages: Message[],
  isPrunable: (toolName: string) => boolean
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      if (block.name && !isPrunable(block.name)) continue;
      const text = typeof block.content === 'string' ? block.content : '';
      total += text.length;
    }
  }
  return total;
}







function applyHardClear(
  messages: Message[],
  settings: ContextPruningSettings,
  isPrunable: (toolName: string) => boolean,
  charWindow: number,
  currentChars: number
): { messages: Message[]; hardClearedToolResults: number; savedChars: number } {
  if (!settings.hardClear.enabled) {
    return { messages, hardClearedToolResults: 0, savedChars: 0 };
  }

  let totalChars = currentChars;
  const ratio = totalChars / charWindow;

  if (ratio < settings.hardClearRatio) {
    return { messages, hardClearedToolResults: 0, savedChars: 0 };
  }

  const prunableChars = countPrunableToolChars(messages, isPrunable);
  if (prunableChars < settings.minPrunableToolChars) {
    return { messages, hardClearedToolResults: 0, savedChars: 0 };
  }

  let hardClearedToolResults = 0;
  let savedChars = 0;
  const output: Message[] = [];

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      output.push(msg);
      continue;
    }

    let didChange = false;
    const nextBlocks: ContentBlock[] = [];

    for (const block of msg.content) {
      if (
        block.type === 'tool_result' &&
        typeof block.content === 'string' &&
        block.content.length > 0
      ) {
        const canPrune = !block.name || isPrunable(block.name);

        if (canPrune) {
          const currentRatio = totalChars / charWindow;
          if (currentRatio < settings.hardClearRatio) {
            nextBlocks.push(block);
            continue;
          }

          const beforeLen = block.content.length;
          const clearedBlock: ContentBlock = {
            ...block,
            content: settings.hardClear.placeholder,
          };
          nextBlocks.push(clearedBlock);
          const blockSaved = beforeLen - settings.hardClear.placeholder.length;
          totalChars -= blockSaved;
          savedChars += Math.max(0, blockSaved);
          hardClearedToolResults += 1;
          didChange = true;
          continue;
        }
      }

      nextBlocks.push(block);
    }

    output.push(didChange ? cloneMessage(msg, nextBlocks) : msg);
  }

  return { messages: output, hardClearedToolResults, savedChars };
}









function findAssistantCutoffIndex(messages: Message[], keepLastAssistants: number): number | null {
  if (keepLastAssistants <= 0) return messages.length;
  let remaining = keepLastAssistants;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'assistant') continue;
    remaining -= 1;
    if (remaining === 0) return i;
  }
  return null;
}






function sliceWithinBudget(
  messages: Message[],
  budgetChars: number,
  estimateOptions?: { includeThinking?: boolean }
): Message[] {
  const kept: Message[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const chars = estimateMessageChars(msg, estimateOptions);
    if (used + chars > budgetChars && kept.length > 0) break;
    kept.push(msg);
    used += chars;
  }
  kept.reverse();
  return kept;
}

function collectToolUseIds(msg: Message): string[] {
  if (typeof msg.content === 'string') return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_use' && block.id) ids.push(block.id);
  }
  return ids;
}

function collectToolResultIds(msg: Message): string[] {
  if (typeof msg.content === 'string') return [];
  const ids: string[] = [];
  for (const block of msg.content) {
    if (block.type === 'tool_result' && block.tool_use_id) ids.push(block.tool_use_id);
  }
  return ids;
}

export function expandKeptWithToolRoundtrips(messages: Message[], kept: Message[]): Message[] {
  const keptSet = new Set(kept);
  const toolUseMessageById = new Map<string, Message>();
  const toolResultMessageById = new Map<string, Message>();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const id of collectToolUseIds(msg)) {
        if (!toolUseMessageById.has(id)) toolUseMessageById.set(id, msg);
      }
    } else if (msg.role === 'user') {
      for (const id of collectToolResultIds(msg)) {
        if (!toolResultMessageById.has(id)) toolResultMessageById.set(id, msg);
      }
    }
  }

  let changed = false;
  for (const msg of [...kept]) {
    for (const id of collectToolResultIds(msg)) {
      const parent = toolUseMessageById.get(id);
      if (parent && !keptSet.has(parent)) {
        keptSet.add(parent);
        changed = true;
      }
    }
    for (const id of collectToolUseIds(msg)) {
      const result = toolResultMessageById.get(id);
      if (result && !keptSet.has(result)) {
        keptSet.add(result);
        changed = true;
      }
    }
  }

  return changed ? messages.filter((msg) => keptSet.has(msg)) : kept;
}

function isCompactionSummaryMessage(message: Message): boolean {
  if (message.role !== 'user') return false;
  if (typeof message.content === 'string') {
    return message.content.trimStart().startsWith(COMPACTION_SUMMARY_PREFIX);
  }
  return message.content.some(
    (block) =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trimStart().startsWith(COMPACTION_SUMMARY_PREFIX)
  );
}

function protectLatestCompactionSummary(messages: Message[], kept: Message[]): Message[] {
  let latestSummary: Message | undefined;
  for (const message of messages) {
    if (isCompactionSummaryMessage(message)) {
      latestSummary = message;
    }
  }
  if (!latestSummary || kept.includes(latestSummary)) {
    return kept;
  }
  const keptSet = new Set(kept);
  keptSet.add(latestSummary);
  return messages.filter((message) => keptSet.has(message));
}









export function pruneContextMessages(params: {
  messages: Message[];
  contextWindowTokens: number;
  systemPromptTokens?: number;
  
  charsPerTokenUnit?: number;
  
  includeThinking?: boolean;
  settings?: Partial<ContextPruningSettings>;
}): PruneResult {
  const settings = resolvePruningSettings(params.settings);
  const estimateOptions = { includeThinking: params.includeThinking };

  const contextWindowTokensAll = Math.max(1, Math.floor(params.contextWindowTokens));
  const systemTokensRaw = Math.max(0, params.systemPromptTokens ?? 0);

  
  const minMsgTokenFloor = Math.min(
    MIN_MESSAGE_HISTORY_TOKEN_UNITS,
    Math.max(512, Math.floor(contextWindowTokensAll * 0.2))
  );
  const cappedSystemTokens = Math.min(
    systemTokensRaw,
    Math.max(0, contextWindowTokensAll - minMsgTokenFloor)
  );
  
  const contextTokens = Math.max(minMsgTokenFloor, contextWindowTokensAll - cappedSystemTokens);

  const charsPerUnit = Math.max(1, params.charsPerTokenUnit ?? CHARS_PER_TOKEN_ESTIMATE);
  const charWindow = contextTokens * charsPerUnit;
  const budgetChars = Math.max(1, Math.floor(charWindow * settings.maxHistoryShare));
  const isPrunable = makeToolPrunablePredicate(settings.tools);

  let current = params.messages;
  let trimmedToolResults = 0;
  let hardClearedToolResults = 0;

  const totalChars = estimateMessagesChars(current, estimateOptions);
  let afterSoftTrimChars = totalChars;
  const ratio = totalChars / charWindow;
  if (ratio > settings.softTrimRatio) {
    const trimResult = applySoftTrim(current, settings, isPrunable);
    current = trimResult.messages;
    trimmedToolResults = trimResult.trimmedToolResults;
    afterSoftTrimChars = totalChars - trimResult.savedChars;
  }

  let afterClearChars = afterSoftTrimChars;
  const afterSoftTrimRatio = afterSoftTrimChars / charWindow;
  if (afterSoftTrimRatio > settings.hardClearRatio) {
    const clearResult = applyHardClear(
      current,
      settings,
      isPrunable,
      charWindow,
      afterSoftTrimChars
    );
    current = clearResult.messages;
    hardClearedToolResults = clearResult.hardClearedToolResults;
    afterClearChars = afterSoftTrimChars - clearResult.savedChars;
  }

  if (afterClearChars <= budgetChars) {
    return {
      messages: current,
      droppedMessages: [],
      trimmedToolResults,
      hardClearedToolResults,
      totalChars: afterClearChars,
      keptChars: afterClearChars,
      droppedChars: 0,
      budgetChars,
    };
  }

  const cutoffIndex = findAssistantCutoffIndex(current, settings.keepLastAssistants);
  const protectedIndex = cutoffIndex ?? 0;
  const protectedMessages = current.slice(protectedIndex);
  const protectedChars = estimateMessagesChars(protectedMessages, estimateOptions);

  let kept: Message[];
  if (protectedChars > budgetChars) {
    kept = sliceWithinBudget(current, budgetChars, estimateOptions);
  } else {
    kept = [...protectedMessages];
    let remaining = budgetChars - protectedChars;
    for (let i = protectedIndex - 1; i >= 0; i--) {
      const msg = current[i];
      const msgChars = estimateMessageChars(msg, estimateOptions);
      if (msgChars > remaining) break;
      kept.unshift(msg);
      remaining -= msgChars;
    }
    if (kept.length === 0) {
      kept = sliceWithinBudget(current, budgetChars, estimateOptions);
    }
  }
  kept = protectLatestCompactionSummary(current, kept);
  kept = expandKeptWithToolRoundtrips(current, kept);

  const keptSet = new Set(kept);
  const droppedMessages = current.filter((msg) => !keptSet.has(msg));
  const keptChars = estimateMessagesChars(kept, estimateOptions);
  const droppedChars = Math.max(0, afterClearChars - keptChars);

  return {
    messages: kept,
    droppedMessages,
    trimmedToolResults,
    hardClearedToolResults,
    totalChars: afterClearChars,
    keptChars,
    droppedChars,
    budgetChars,
  };
}
