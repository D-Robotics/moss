/**
 * TUI render bridge: converts MossAgentEvent streams into transcript rows and
 * run-state updates. Kept pure (no ink imports) so specs can drive it
 * directly.
 */
import type { MossAgentEvent } from '../../core/agent/moss-agent-types.js';

export type TranscriptRowKind = 'user' | 'assistant' | 'system' | 'error' | 'banner';

export interface TranscriptRow {
  id: number;
  kind: TranscriptRowKind;
  text: string;
}

export interface TuiRunState {
  running: boolean;
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
}

export interface TuiStore {
  rows: TranscriptRow[];
  run: TuiRunState;
  usage: TuiUsageState;
  nextId: number;
  version: number;
}

export function createTuiStore(): TuiStore {
  return {
    rows: [],
    run: { running: false, streamingText: '' },
    usage: { tokensIn: 0, tokensOut: 0, runTokensIn: 0, runTokensOut: 0 },
    nextId: 1,
    version: 0,
  };
}

export function appendRow(store: TuiStore, kind: TranscriptRowKind, text: string): void {
  store.rows.push({ id: store.nextId++, kind, text });
  store.version++;
}

function setStreaming(store: TuiStore, text: string): void {
  store.run.streamingText = text;
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
      setStreaming(store, tail(store.run.streamingText + event.delta));
      break;
    }
    case 'tool_start': {
      store.run.toolLine = `${event.toolName} …`;
      store.version++;
      break;
    }
    case 'tool_end': {
      const ok = event.isError ? 'FAILED' : 'ok';
      appendRow(store, 'system', `⎿ ${event.toolName} (${ok})`);
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
      store.version++;
      break;
    }
    default:
      break;
  }
}

export function beginRun(store: TuiStore): void {
  store.run = { running: true, streamingText: '' };
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
    appendRow(store, 'assistant', store.run.streamingText);
  }
  store.run = { running: false, streamingText: '', halted: halted || undefined };
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
