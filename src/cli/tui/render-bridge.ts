/**
 * TUI render bridge: converts MossAgentEvent streams into transcript rows and
 * run-state updates. Kept pure (no ink imports) so specs can drive it
 * directly.
 */
import type { MossAgentEvent } from '../../core/agent/moss-agent-types.js';
import { noteToolForVerifyHint, type VerifyHintState } from '../verify-hint.js';
import { tui } from './copy.js';
import { nextStreamCommit } from './stream-commit.js';
import { toolLabel } from './transcript.js';
import { summarizeToolCompletion } from './tool-summary.js';

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

/**
 * Completion metadata attached to a tool's `result` row: the one-line human
 * summary (`Read 14 lines`), how long the call took, and how it ended. The
 * transcript renders this as the `⎿` headline above the output preview.
 */
export interface ToolRowMeta {
  name: string;
  summary?: string;
  durationMs?: number;
  isError?: boolean;
  abortedBy?: 'user' | 'timeout';
}

export interface TranscriptRow {
  id: number;
  kind: TranscriptRowKind;
  text: string;
  /** Reasoning that produced this row (verbose view reveals it). */
  reasoning?: string;
  /** Set when the row is a tool's completion (`tool_end`). */
  tool?: ToolRowMeta;
  /** Later block of an answer that already has its ⏺ row. */
  continuation?: boolean;
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
  /** Inputs of in-flight tool calls, keyed by call id (tool_end summarizes). */
  toolInputs: Map<string, Record<string, unknown>>;
  /** Latest provider retry notice (shown in the live region until progress). */
  retry?: { attempt: number; error: string };
  /** Last event time — the live region flags a stream that has gone quiet. */
  lastEventAt?: number;
  /** Assistant text already committed from this prose segment. */
  committedText?: string;
  /** This run edited a JS/TS file and has not run a test or diagnostics tool. */
  editedJsTs?: boolean;
  ranTests?: boolean;
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
  /** The model name reported by the latest provider usage event, when available. */
  lastModel?: string;
  /** Session-cumulative prompt-cache hits (llm_usage.cacheReadTokens). */
  cacheReadTokens: number;
  /** Compactions seen this session (the transcript announces them). */
  compactions: number;
  /** Completed runs (turns) this session. */
  runs: number;
  /** Sum of provider-reported generation times (actual API work). */
  apiMs: number;
  /** time-to-first-token samples (ms) for the latency average. */
  ttftSamples: number[];
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
    run: { running: false, thinkingText: '', streamingText: '', toolInputs: new Map() },
    todos: [],
    usage: {
      tokensIn: 0,
      tokensOut: 0,
      runTokensIn: 0,
      runTokensOut: 0,
      contextUsed: 0,
      contextTotal: 0,
      cacheReadTokens: 0,
      compactions: 0,
      runs: 0,
      apiMs: 0,
      ttftSamples: [],
    },
    nextId: 1,
    version: 0,
  };
}

export function appendRow(
  store: TuiStore,
  kind: TranscriptRowKind,
  text: string,
  extra: { reasoning?: string; tool?: ToolRowMeta; continuation?: boolean } = {}
): void {
  store.rows.push({
    id: store.nextId++,
    kind,
    text,
    ...(extra.reasoning ? { reasoning: extra.reasoning } : {}),
    ...(extra.tool ? { tool: extra.tool } : {}),
    ...(extra.continuation ? { continuation: true } : {}),
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

/**
 * Feed one MossAgentEvent into the store. Mirrors the REPL renderer's shape:
 * text deltas stream into a live tail, tool calls surface as one system line,
 * errors surface as error rows.
 */
export function applyAgentEvent(store: TuiStore, event: MossAgentEvent): void {
  store.run.lastEventAt = Date.now();
  switch (event.type) {
    case 'text_delta': {
      store.run.retry = undefined;
      const buffered = store.run.streamingText + event.delta;
      const split = nextStreamCommit(buffered);
      if (split.commit) {
        appendRow(store, 'assistant', split.commit, {
          continuation: Boolean(store.run.committedText),
        });
        store.run.committedText = `${store.run.committedText ?? ''}${split.commit}\n`;
        setStreaming(store, split.rest);
      } else {
        setStreaming(store, buffered);
      }
      break;
    }
    case 'thinking_delta': {
      setThinking(store, store.run.thinkingText + event.delta);
      break;
    }
    case 'retry': {
      // The provider is retrying a failed call: surface it in the live region
      // AND leave a transcript marker — when the retried call regenerates, the
      // re-streamed text must read as a deliberate retry, not a glitchy echo
      // of the partial output above.
      store.run.retry = { attempt: event.attempt, error: event.error };
      appendRow(
        store,
        'summary',
        tui('↻ provider retry {attempt} — {error}', {
          attempt: event.attempt,
          error: event.error.replace(/\s+/g, ' ').trim(),
        })
      );
      store.version++;
      break;
    }
    case 'turn_start': {
      store.run.retry = undefined;
      store.version++;
      break;
    }
    case 'tool_start': {
      store.run.retry = undefined;
      // The call itself is transcript content (`⏺ Write(hello.txt)`), not just a
      // status line: it is what the user scrolls back to.
      store.run.toolLine = toolLabel(event.toolName, event.input);
      store.run.toolInputs.set(event.toolCallId, event.input);
      noteToolForVerifyHint(store.run as VerifyHintState, event.toolName, event.input);
      if (event.toolName === 'todo_write' && Array.isArray(event.input.todos)) {
        store.todos = toTodos(event.input.todos);
      }
      appendRow(store, 'tool', store.run.toolLine, { tool: { name: event.toolName } });
      store.version++;
      break;
    }
    case 'tool_end': {
      // The todo checklist is rendered as a live panel, so echoing its full
      // formatted list here would print the same three lines twice. The count
      // IS the summary headline, so the row body stays empty. A failed or
      // aborted todo_write must NOT read as progress — it falls through to the
      // generic error/abort summary below.
      if (
        event.toolName === 'todo_write' &&
        !event.isError &&
        !event.aborted &&
        store.todos.length > 0
      ) {
        const done = store.todos.filter((todo) => todo.status === 'completed').length;
        appendRow(store, 'result', '', {
          tool: {
            name: event.toolName,
            summary: tui('{done}/{total} done', { done, total: store.todos.length }),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          },
        });
        store.run.toolLine = undefined;
        store.version++;
        break;
      }
      const input = store.run.toolInputs.get(event.toolCallId) ?? {};
      store.run.toolInputs.delete(event.toolCallId);
      const abortedBy = event.aborted?.by;
      const completion = summarizeToolCompletion(
        event.toolName,
        input,
        event.result,
        Boolean(event.isError)
      );
      const summary = abortedBy ? tui('aborted ({by})', { by: abortedBy }) : completion.summary;
      // Edits and writes render as a diff gutter; everything else keeps the
      // raw result (the projection decides how much of it to show). A dialog
      // that already showed its answer gets its synthetic wrapper dropped.
      // An empty success body stays empty — the headline alone is the result.
      const body = completion.dropBody ? '' : (completion.diff ?? resultBody(event.result));
      appendRow(store, 'result', body, {
        tool: {
          name: event.toolName,
          ...(summary ? { summary } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.isError ? { isError: true } : {}),
          ...(abortedBy ? { abortedBy } : {}),
        },
      });
      store.run.toolLine = undefined;
      store.version++;
      break;
    }
    case 'error': {
      // The loop classifies provider failures into a sanitized surface
      // (`userMessage` + suggested `actions`). The raw error string is for
      // logs; the transcript gets the human reading plus the action hints.
      const surface = event.errorSurface;
      const actions =
        surface?.actions && surface.actions.length > 0
          ? ` (${surface.actions.map((a) => a.label).join(' · ')})`
          : '';
      appendRow(
        store,
        'error',
        surface?.userMessage ? `${surface.userMessage}${actions}` : String(event.error ?? 'error')
      );
      break;
    }
    case 'llm_usage': {
      store.usage.tokensIn += Number(event.inputTokens ?? 0);
      store.usage.tokensOut += Number(event.outputTokens ?? 0);
      store.usage.runTokensIn += Number(event.inputTokens ?? 0);
      store.usage.runTokensOut += Number(event.outputTokens ?? 0);
      store.usage.cacheReadTokens += Number(event.cacheReadTokens ?? 0);
      if (event.generationMs !== undefined && event.generationMs > 0) {
        store.usage.apiMs += event.generationMs;
      }
      if (event.ttftMs !== undefined && event.ttftMs > 0) {
        store.usage.ttftSamples.push(event.ttftMs);
      }
      if (event.contextTokens && event.contextTokens > 0) {
        store.usage.contextTotal = event.contextTokens;
        store.usage.contextUsed =
          Number(event.inputTokens ?? 0) +
          Number(event.cacheReadTokens ?? 0) +
          Number(event.cacheCreationTokens ?? 0);
      }
      if (event.model?.trim()) store.usage.lastModel = event.model.trim();
      store.version++;
      break;
    }
    case 'microcompact': {
      // The loop silently compressed old tool results; say so (the REPL does).
      const saved =
        event.savedTokens > 0
          ? tui(' · saved ~{count} tokens', {
              count:
                event.savedTokens >= 1000
                  ? `${Math.round(event.savedTokens / 100) / 10}k`
                  : event.savedTokens,
            })
          : '';
      appendRow(
        store,
        'summary',
        `${tui(
          event.compressedCount === 1
            ? 'compressed {count} old tool result'
            : 'compressed {count} old tool results',
          { count: event.compressedCount }
        )}${saved}`
      );
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
        `${tui('compacted {count} earlier messages', { count: event.droppedMessages })}${
          event.tokensAfter !== undefined
            ? tui(' · now ~{count} tokens', { count: event.tokensAfter })
            : ''
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
  store.run = {
    running: true,
    thinkingText: '',
    streamingText: '',
    committedText: '',
    toolInputs: new Map(),
    lastEventAt: Date.now(),
  };
  store.usage.runTokensIn = 0;
  store.usage.runTokensOut = 0;
  store.version++;
}

export function formatUsage(usage: TuiUsageState): string {
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
  const cache =
    usage.cacheReadTokens > 0 ? ` · ${fmt(usage.cacheReadTokens)} prompt-cache hits` : '';
  return `${fmt(usage.runTokensIn + usage.runTokensOut)} in run / ${fmt(
    usage.tokensIn + usage.tokensOut
  )} session${cache}`;
}

function fmtDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 6000) / 10}min`;
  if (ms >= 1000) return `${Math.round(ms / 100) / 10}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * The `/usage` block (A11.83): token split with cache hits, run count,
 * provider-reported API time and first-token latency, compactions — and a
 * cost line ONLY when the user configured pricing (USD per 1M tokens via
 * MOSS_PRICE_IN / MOSS_PRICE_OUT). Moss deliberately does not guess model
 * prices: a wrong number is worse than none.
 */
export function usageBlock(usage: TuiUsageState, env: NodeJS.ProcessEnv = process.env): string[] {
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));
  const lines: string[] = [
    `tokens      ${fmt(usage.tokensIn + usage.tokensOut)} session · ↑ ${fmt(usage.tokensIn)} in · ↓ ${fmt(usage.tokensOut)} out` +
      (usage.cacheReadTokens > 0 ? ` · ${fmt(usage.cacheReadTokens)} cache hits` : ''),
  ];
  const ttftAvg =
    usage.ttftSamples.length > 0
      ? usage.ttftSamples.reduce((a, b) => a + b, 0) / usage.ttftSamples.length
      : undefined;
  lines.push(
    `runs        ${usage.runs} · api ${fmtDuration(usage.apiMs)}` +
      (ttftAvg !== undefined ? ` · avg first-token ${fmtDuration(ttftAvg)}` : '')
  );
  if (usage.compactions > 0) lines.push(`compactions ${usage.compactions}`);
  const priceIn = Number(env.MOSS_PRICE_IN);
  const priceOut = Number(env.MOSS_PRICE_OUT);
  if (Number.isFinite(priceIn) && priceIn > 0 && Number.isFinite(priceOut) && priceOut > 0) {
    const cost =
      ((usage.tokensIn + usage.cacheReadTokens) / 1e6) * priceIn +
      (usage.tokensOut / 1e6) * priceOut;
    lines.push(
      `cost        ~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)} (MOSS_PRICE_IN/OUT)`
    );
  } else {
    lines.push(
      'cost        unknown — set MOSS_PRICE_IN / MOSS_PRICE_OUT (USD per 1M tokens) to enable'
    );
  }
  return lines;
}

export function endRun(store: TuiStore, halted: boolean): void {
  if (store.run.streamingText.trim()) {
    appendRow(store, 'assistant', store.run.streamingText, {
      ...(store.run.committedText ? { continuation: true } : {}),
      ...(store.run.thinkingText.trim() ? { reasoning: store.run.thinkingText } : {}),
    });
  }
  store.run = {
    running: false,
    thinkingText: '',
    streamingText: '',
    committedText: '',
    toolInputs: new Map(),
    halted: halted || undefined,
  };
  store.usage.runs += 1;
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
