/**
 * 领域消息模型 —— 全仓库共享内核。
 * 从 core/session/session-jsonl-types.ts 与 core/tools/tool-types.ts 归位而来，
 * 内容逐字保留（含 JSDoc），仅调整 import。
 */

export type ToolResultOutcome = 'ok' | 'error' | 'denied' | 'blocked' | 'replayed' | 'suppressed';

export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; alt?: string }
  | { type: 'resource'; uri: string; name?: string; mimeType?: string; text?: string };

export interface Message {
  role: 'user' | 'assistant';

  content: string | ContentBlock[];

  timestamp: number;

  thinking?: string[];
}

export interface ContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';

  text?: string;

  data?: string;

  mimeType?: string;

  filename?: string;

  id?: string;

  name?: string;

  input?: Record<string, unknown>;

  tool_use_id?: string;

  content?: string;

  is_error?: boolean;

  outcome?: ToolResultOutcome;

  durationMs?: number;

  aborted?: { by: 'user' | 'timeout' };

  _synthetic?: 'missing_tool_result' | 'orphan_tool_use_repair';

  structuredContent?: ToolContentBlock[];
}

export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeaderEntry {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
  cwd?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
  type: 'message';
  message: Message;
}

export interface CompactionEntry extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
}

export type SessionEntry = MessageEntry | CompactionEntry;
export type SessionFileEntry = SessionHeaderEntry | SessionEntry;

export const COMPACTION_SUMMARY_PREFIX =
  'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
export const COMPACTION_SUMMARY_SUFFIX = '\n</summary>';

export function createCompactionSummaryMessage(
  summary: string,
  timestamp?: string | number
): Message {
  const resolvedTimestamp =
    typeof timestamp === 'string'
      ? new Date(timestamp).getTime()
      : typeof timestamp === 'number'
        ? timestamp
        : Date.now();
  return {
    role: 'user',
    content: `${COMPACTION_SUMMARY_PREFIX}${summary}${COMPACTION_SUMMARY_SUFFIX}`,
    timestamp: Number.isFinite(resolvedTimestamp) ? resolvedTimestamp : Date.now(),
  };
}
