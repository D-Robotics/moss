/**
 * TUI render bridge: converts MossAgentEvent streams into transcript rows and
 * run-state updates. Kept pure (no ink imports) so specs can drive it
 * directly.
 */
import type { MossAgentEvent } from '../../core/agent/moss-agent-types.js';
import { toolLabel } from './transcript.js';

/**
 * The row keeps the result; the PROJECTION decides how much of it to show
 * (compact = 3 lines + a `ctrl+o` marker, verbose = everything). Truncating
 * here as well would make the verbose view unable to reveal more.
 */
const RESULT_ROW_MAX_CHARS = 4000;

function resultBody(result: string): string {
  const text = (result ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  return text.length > RESULT_ROW_MAX_CHARS ? `${text.slice(0, RESULT_ROW_MAX_CHARS - 1)}…` : text;
}

export type TranscriptRowKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'result'
  | 'detail'
  | 'summary'
  | 'system'
  | 'error'
  | 'banner';

export interface TranscriptRow {
  id: number;
  kind: TranscriptRowKind;
  text: string;
  /** Reasoning that produced this row (verbose view reveals it). */
  reasoning?: string;
}

export interface TuiRunState {
  running: boolean;
  /**
   * Reasoning stream (thinking). Kept OUT of `streamingText`: the loop's own
   * bridge (cli/loop-tui-events.ts) treats thinking as activity only, and
   * merging the two put the model's inner monologue inside the final answer
   * row that the canvas then shows as the answer.
   */
  thinkingText: string;
  /** Live tail of the streaming assistant response. */
  streamingText: string;
  toolLine?: string;
  halted?: boolean;
}

export interface TuiUsageState {
  /** Session-cumulative tokens from llm_usage events. */
  tokensIn: number;
  tokensOut: number;
  /** Tokens of the CURRENT (or most recent) run. */
  runTokensIn: number;
  runTokensOut: number;
  /**
   * Prompt tokens of the latest model call and the model's context window, so
   * the status line can show how full the context is. 0 when the provider does
   * not report a window.
   */
  contextUsed: number;
  contextTotal: number;
  /** Compactions seen this session (the transcript announces them). */
  compactions: number;
}

export interface TuiTodo {
  content: string;
  status: string;
}

export interface TuiStore {
  rows: TranscriptRow[];
  run: TuiRunState;
  usage: TuiUsageState;
  /** Latest `todo_write` list — rendered as a live checklist by the shell. */
  todos: TuiTodo[];
  nextId: number;
  version: number;
}

export function createTuiStore(): TuiStore {
  return {
    rows: [],
    run: { running: false, thinkingText: '', streamingText: '' },
    todos: [],
    usage: {
      tokensIn: 0,
      tokensOut: 0,
      runTokensIn: 0,
      runTokensOut: 0,
      contextUsed: 0,
      contextTotal: 0,
      compactions: 0,
    },
    nextId: 1,
    version: 0,
  };
}

export function appendRow(
  store: TuiStore,
  kind: TranscriptRowKind,
  text: string,
  extra: { reasoning?: string } = {}
): void {
  store.rows.push({
    id: store.nextId++,
    kind,
    text,
    ...(extra.reasoning ? { reasoning: extra.reasoning } : {}),
  });
  store.version++;
}

function setStreaming(store: TuiStore, text: string): void {
  store.run.streamingText = text;
  store.version++;
}

function setThinking(store: TuiStore, text: string): void {
  store.run.thinkingText = text;
  store.version++;
}

function tail(text: string, max = 400): string {
  return text.length > max ? text.slice(-max) : text;
}

/**
 * Feed one MossAgentEvent into the store. Mirrors the REPL renderer's shape:
 * text deltas stream into a live tail, tool calls surface as one system line,
 * errors surface as error rows.
 */
export function applyAgentEvent(store: TuiStore, event: MossAgentEvent): void {
  switch (event.type) {
    case 'text_delta': {
      setStreaming(store, tail(store.run.streamingText + event.delta));
      break;
    }
    case 'thinking_delta': {
      setThinking(store, tail(store.run.thinkingText + event.delta));
      break;
    }
    case 'tool_start': {
      // The call itself is transcript content (`⏺ Write(hello.txt)`), not just a
      // status line: it is what the user scrolls back to.
      store.run.toolLine = toolLabel(event.toolName, event.input);
      if (event.toolName === 'todo_write' && Array.isArray(event.input.todos)) {
        store.todos = toTodos(event.input.todos);
      }
      appendRow(store, 'tool', store.run.toolLine);
      store.version++;
      break;
    }
    case 'tool_end': {
      // The todo checklist is rendered as a live panel, so echoing its full
      // formatted list here would print the same three lines twice.
      if (event.toolName === 'todo_write' && store.todos.length > 0) {
        const done = store.todos.filter((todo) => todo.status === 'completed').length;
        appendRow(store, 'result', `${done}/${store.todos.length} done`);
        store.run.toolLine = undefined;
        store.version++;
        break;
      }
      const preview = resultBody(event.result);
      const body = event.isError ? `FAILED${preview ? ` — ${preview}` : ''}` : preview || 'ok';
      appendRow(store, 'result', body);
      store.run.toolLine = undefined;
      store.version++;
      break;
    }
    case 'error': {
      appendRow(store, 'error', String(event.error ?? 'error'));
      break;
    }
    case 'llm_usage': {
      store.usage.tokensIn += Number(event.inputTokens ?? 0);
      store.usage.tokensOut += Number(event.outputTokens ?? 0);
      store.usage.runTokensIn += Number(event.inputTokens ?? 0);
      store.usage.runTokensOut += Number(event.outputTokens ?? 0);
      if (event.contextTokens && event.contextTokens > 0) {
        store.usage.contextTotal = event.contextTokens;
        store.usage.contextUsed =
          Number(event.inputTokens ?? 0) +
          Number(event.cacheReadTokens ?? 0) +
          Number(event.cacheCreationTokens ?? 0);
      }
      store.version++;
      break;
    }
    case 'compaction': {
      // Compaction changes the context size under the user's feet; the
      // transcript says so instead of silently shrinking.
      store.usage.compactions += 1;
      appendRow(
        store,
        'summary',
        `compacted ${event.droppedMessages} earlier messages${
          event.tokensAfter !== undefined ? ` · now ~${event.tokensAfter} tokens` : ''
        }`
      );
      store.version++;
      break;
    }
    default:
      break;
  }
}

/** Normalise the todo tool's input into the rows the checklist renders. */
export function toTodos(raw: readonly unknown[]): TuiTodo[] {
  const out: TuiTodo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as { content?: unknown; status?: unknown };
    if (typeof record.content !== 'string' || !record.content.trim()) continue;
    out.push({
      content: record.content.trim(),
      status: typeof record.status === 'string' ? record.status : 'pending',
    });
  }
  return out;
}

export function beginRun(store: TuiStore): void {
  store.run = { running: true, thinkingText: '', streamingText: '' };
  store.usage.runTokensIn = 0;
  store.usage.runTokensOut = 0;
  store.version++;
}

export function formatUsage(usage: TuiUsageState): string {
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
  return `${fmt(usage.runTokensIn + usage.runTokensOut)} in run / ${fmt(
    usage.tokensIn + usage.tokensOut
  )} session`;
}

export function endRun(store: TuiStore, halted: boolean): void {
  if (store.run.streamingText.trim()) {
    appendRow(store, 'assistant', store.run.streamingText, {
      ...(store.run.thinkingText.trim() ? { reasoning: store.run.thinkingText } : {}),
    });
  }
  store.run = { running: false, thinkingText: '', streamingText: '', halted: halted || undefined };
  store.version++;
}

/** Rows visible in the transcript window, newest at the bottom. */
export function visibleRows(
  store: TuiStore,
  height: number,
  scrollOffset: number
): TranscriptRow[] {
  if (height <= 0) return store.rows.slice(-10);
  const start = Math.max(0, store.rows.length - height - scrollOffset);
  return store.rows.slice(start, start + height);
}
