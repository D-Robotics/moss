/**
 * TUI render bridge: converts MossAgentEvent streams into transcript rows and
 * run-state updates. Kept pure (no ink imports) so specs can drive it
 * directly.
 */
import type { MossAgentEvent } from '../../core/agent/moss-agent-types.js';
import {
  formatCostEstimate,
  priceSourceLine,
  quoteUsage,
  unknownPriceMessage,
} from '../model-pricing.js';
import type { ModelPrice, UsageSlice } from '../model-pricing.js';
import { noteToolForVerifyHint, type VerifyHintState } from '../verify-hint.js';
import {
  chatInterruptNoticeLine,
  interruptNoticeLine,
  isStructuredUserAbort,
  isTuiZh,
  isUserAbortErrorText,
  localizeAbortActor,
  tui,
} from './copy.js';
import { nextStreamCommit } from './stream-commit.js';
import { toolLabel } from './transcript.js';
import { summarizeToolCompletion } from './tool-summary.js';
import { userFacingAssistantText, userFacingToolResult } from '../user-facing-text.js';

/**
 * The row keeps the result; the PROJECTION decides how much of it to show
 * (compact = 3 lines + a `ctrl+o` marker, verbose = everything). Truncating
 * here as well would make the verbose view unable to reveal more.
 */
const RESULT_ROW_MAX_CHARS = 4000;

function resultBody(result: string, toolName?: string): string {
  const text = userFacingToolResult(result ?? '', toolName)
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
  /** How long the model reasoned before this row (the `thought for 4s` line). */
  thinkingMs?: number;
  /** Set when the row is a tool's completion (`tool_end`). */
  tool?: ToolRowMeta;
  /** Later block of an answer that already has its ⏺ row. */
  continuation?: boolean;
}

export interface TuiRunState {
  running: boolean;
  /**
   * Reasoning stream (thinking). Kept OUT of `streamingText`: thinking is
   * activity only, and merging the two put the model's inner monologue inside
   * the final answer row that the canvas then shows as the answer.
   */
  thinkingText: string;
  /** When the current reasoning stream started, and how long it lasted once it ended. */
  thinkingStartedAt?: number;
  thinkingMs?: number;
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
  /** Every prose segment committed to the transcript this run (turn end, tool boundary). */
  flushed?: string[];
  /** This run edited a JS/TS file and has not run a test or diagnostics tool. */
  editedJsTs?: boolean;
  ranTests?: boolean;
  /** In-flight device_* tool-call ids. The live region says "waiting for device", not "gateway". */
  deviceCallIds?: Set<string>;
  /** This run is /goal or moss task, so Esc may mention `/goal resume`. */
  resumeHint?: boolean;
  /**
   * Index of the first transcript row that belongs to this run. Final-answer
   * dedupe looks only at rows from here on, so a short later reply that happens
   * to be a substring of an earlier run ("30 fps", "OK", "完成。") is still shown.
   */
  rowStart?: number;
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
  /** Per-call slices for session cost. */
  slices: UsageSlice[];
  /** Configured session model, used when a usage event omits one. */
  sessionModel?: string;
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
    run: {
      running: false,
      thinkingText: '',
      streamingText: '',
      toolInputs: new Map(),
      deviceCallIds: new Set(),
    },
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
      slices: [],
    },
    nextId: 1,
    version: 0,
  };
}

function noteInterrupt(store: TuiStore): void {
  const line = store.run.resumeHint ? interruptNoticeLine() : chatInterruptNoticeLine();
  if (store.rows.some((row) => row.kind === 'summary' && row.text === line)) return;
  appendRow(store, 'summary', line);
}

export function appendRow(
  store: TuiStore,
  kind: TranscriptRowKind,
  text: string,
  extra: {
    reasoning?: string;
    thinkingMs?: number;
    tool?: ToolRowMeta;
    continuation?: boolean;
  } = {}
): void {
  store.rows.push({
    id: store.nextId++,
    kind,
    text,
    ...(extra.reasoning ? { reasoning: extra.reasoning } : {}),
    ...(extra.thinkingMs ? { thinkingMs: extra.thinkingMs } : {}),
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
 * Reasoning is not transcript content. It used to be flushed into scrollback in
 * 360-char slices, which buried the answer under pages of dim text. It now stays
 * in one bounded buffer: the spinner reports "Thinking…", ctrl+o shows the tail,
 * and the answer row keeps it as its hidden `reasoning`.
 */
const THINKING_KEEP_CHARS = 6000;

/** Reasoning (and how long it took) to attach to the row being committed; resets the stream. */
export function takeReasoning(store: TuiStore): { reasoning?: string; thinkingMs?: number } {
  const reasoning = store.run.thinkingText.trim() ? store.run.thinkingText : undefined;
  const thinkingMs =
    store.run.thinkingMs ??
    (store.run.thinkingStartedAt !== undefined
      ? Date.now() - store.run.thinkingStartedAt
      : undefined);
  store.run.thinkingText = '';
  store.run.thinkingStartedAt = undefined;
  store.run.thinkingMs = undefined;
  return {
    ...(reasoning ? { reasoning } : {}),
    ...(reasoning && thinkingMs ? { thinkingMs } : {}),
  };
}

/** The reasoning stream ends the moment the answer or a tool call begins. */
function closeThinking(store: TuiStore): void {
  if (store.run.thinkingStartedAt !== undefined && store.run.thinkingMs === undefined) {
    store.run.thinkingMs = Date.now() - store.run.thinkingStartedAt;
  }
}

function capThinking(text: string): string {
  if (text.length <= THINKING_KEEP_CHARS) return text;
  const tail = text.slice(text.length - THINKING_KEEP_CHARS);
  const space = tail.indexOf(' ');
  return space > 0 && space < 80 ? tail.slice(space + 1) : tail;
}

/**
 * Commit the pending answer prose as its own transcript row (a finished assistant
 * message). Shared by the tool boundary, the provider retry and the turn end, so
 * two messages never share one buffer.
 */
function rememberFlushed(store: TuiStore, text: string): void {
  if (!text.trim()) return;
  store.run.flushed = [...(store.run.flushed ?? []), text];
}

export function flushProse(store: TuiStore): void {
  const visible = userFacingAssistantText(store.run.streamingText);
  if (visible.trim()) {
    appendRow(store, 'assistant', visible, {
      ...(store.run.committedText ? { continuation: true } : {}),
      ...takeReasoning(store),
    });
    // Closed blocks were remembered when text_delta committed them. This is
    // only the still-open tail, after internal lines have been filtered out.
    rememberFlushed(store, visible);
    store.version++;
  }
  store.run.streamingText = '';
  store.run.committedText = '';
}

function normalizeShown(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * First sentence of the final answer, when it is long enough to be an opening
 * rather than a short later reply ("30 fps", "Done.", "OK.").
 */
function answerOpening(want: string): string {
  const match = /.{8,}?[.。！!?？]/.exec(want);
  if (match?.[0]) return match[0];
  return want.length >= 8 ? want : '';
}

/**
 * The run window already contains the final answer, and its opening sentence
 * shows up again after that copy. `includes` alone treats that as "already
 * shown" and leaves the second copy on screen.
 */
function openingShownAgain(shown: string, want: string): boolean {
  const opening = answerOpening(want);
  if (!opening || !shown.includes(want)) return false;
  const first = shown.indexOf(opening);
  if (first === -1) return false;
  return shown.indexOf(opening, first + opening.length) !== -1;
}

/** Assistant text already committed for this run (rows, or the flush memory). */
function shownAssistantText(store: TuiStore): string {
  const runRows = store.rows.slice(store.run.rowStart ?? 0);
  const fromRows = normalizeShown(
    runRows
      .filter((row) => row.kind === 'assistant')
      .map((row) => row.text)
      .join(' ')
  );
  const fromFlushed = normalizeShown((store.run.flushed ?? []).join(' '));
  return fromRows.length >= fromFlushed.length ? fromRows : fromFlushed;
}

/**
 * The on-screen answer is a truncated or divergent prefix of the final
 * response. Put the response in the first assistant row and drop the copies.
 */
function replaceRunAssistantRows(store: TuiStore, text: string): boolean {
  const start = store.run.rowStart ?? 0;
  const head = store.rows.slice(0, start);
  const kept: TranscriptRow[] = [];
  let replaced = false;
  for (const row of store.rows.slice(start)) {
    if (row.kind !== 'assistant') {
      kept.push(row);
      continue;
    }
    if (!replaced) {
      kept.push({ ...row, text });
      replaced = true;
    }
  }
  if (!replaced) return false;
  store.rows = [...head, ...kept];
  store.run.flushed = [text];
  store.run.streamingText = '';
  store.run.committedText = '';
  store.version++;
  return true;
}

/**
 * The provider's `done` response is the final answer. It is shown once: when the
 * same text was already committed at the turn boundary it is skipped; when the
 * stream carried nothing the response is the answer; when the live tail is a
 * truncated prefix (long answers) the full response replaces it (N-4). A
 * prefix that does not match the response replaces the rows already shown
 * instead of appending a second copy.
 */
export function reconcileFinalResponse(store: TuiStore, response: string | undefined): void {
  if (typeof response !== 'string' || !response.trim()) return;
  const visibleResponse = userFacingAssistantText(response);
  if (!visibleResponse.trim()) return;
  const want = normalizeShown(visibleResponse);
  const shown = shownAssistantText(store);
  const live = store.run.streamingText.trim()
    ? normalizeShown(userFacingAssistantText(store.run.streamingText))
    : '';
  const onScreen = normalizeShown(`${shown} ${live}`.trim());
  // One copy of the answer inside a doubled window still matches `includes`.
  // Collapse back to the provider response so the opening sentence is not painted twice.
  if (openingShownAgain(shown, want)) {
    replaceRunAssistantRows(store, visibleResponse);
    return;
  }
  if (onScreen && onScreen.includes(want)) {
    // Rows already hold the answer. Drop a live tail that only repeats it;
    // endRun would otherwise commit that tail as a second copy. A tail that
    // is the only copy of the ending stays, so endRun can commit it.
    if (shown.includes(want)) {
      store.run.streamingText = '';
      store.run.committedText = '';
    }
    return;
  }
  if (shown && replaceRunAssistantRows(store, visibleResponse)) return;
  if (!store.run.streamingText.trim()) {
    appendRow(store, 'assistant', visibleResponse);
    return;
  }
  store.run.streamingText = visibleResponse;
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
      closeThinking(store);
      store.run.retry = undefined;
      const buffered = store.run.streamingText + event.delta;
      const split = nextStreamCommit(buffered);
      if (split.commit) {
        const visible = userFacingAssistantText(split.commit);
        if (visible.trim()) {
          appendRow(store, 'assistant', visible, {
            continuation: Boolean(store.run.committedText),
          });
          store.run.committedText = `${store.run.committedText ?? ''}${visible}\n`;
          rememberFlushed(store, visible);
        }
        setStreaming(store, split.rest);
      } else {
        setStreaming(store, buffered);
      }
      break;
    }
    case 'thinking_delta': {
      store.run.thinkingStartedAt ??= Date.now();
      setThinking(store, capThinking(store.run.thinkingText + event.delta));
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
    case 'turn_end': {
      // An assistant turn that ends without a tool call is a finished message.
      // Commit its prose now: the next turn's text must start its own row (N7).
      flushProse(store);
      break;
    }
    case 'turn_start': {
      store.run.retry = undefined;
      store.version++;
      break;
    }
    case 'tool_start': {
      closeThinking(store);
      store.run.retry = undefined;
      // The call itself is transcript content (`⏺ Write(hello.txt)`), not just a
      // status line: it is what the user scrolls back to.
      store.run.toolLine = toolLabel(event.toolName, event.input);
      store.run.toolInputs.set(event.toolCallId, event.input);
      if (event.toolName.startsWith('device_')) {
        const ids = store.run.deviceCallIds ?? new Set<string>();
        ids.add(event.toolCallId);
        store.run.deviceCallIds = ids;
      }
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
      store.run.deviceCallIds?.delete(event.toolCallId);
      const abortedBy = event.aborted?.by;
      const abortNotice = isStructuredUserAbort(event);
      if (abortNotice) noteInterrupt(store);
      const completion = summarizeToolCompletion(
        event.toolName,
        input,
        event.result,
        Boolean(event.isError)
      );
      const summary = abortedBy
        ? tui('aborted ({by})', { by: localizeAbortActor(abortedBy) })
        : abortNotice
          ? undefined
          : completion.summary;
      // Edits and writes render as a diff gutter; everything else keeps the
      // raw result (the projection decides how much of it to show). A dialog
      // that already showed its answer gets its synthetic wrapper dropped.
      // An empty success body stays empty — the headline alone is the result.
      const body =
        abortNotice || completion.dropBody
          ? ''
          : (completion.diff ?? resultBody(event.result, event.toolName));
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
      const reading = surface?.userMessage;
      const message = reading
        ? reading.includes('\n')
          ? reading.replace('\n', `${actions}\n`)
          : `${reading}${actions}`
        : String(event.error ?? 'error');
      if (isUserAbortErrorText(message)) {
        noteInterrupt(store);
        break;
      }
      appendRow(store, 'error', message);
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
      const model = event.model?.trim() || store.usage.sessionModel;
      store.usage.slices.push({
        ...(model ? { model } : {}),
        inputTokens: Number(event.inputTokens ?? 0),
        outputTokens: Number(event.outputTokens ?? 0),
        cacheReadTokens: Number(event.cacheReadTokens ?? 0),
        cacheCreationTokens: Number(event.cacheCreationTokens ?? 0),
      });
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

export function beginRun(store: TuiStore, options: { resumeHint?: boolean } = {}): void {
  store.run = {
    running: true,
    thinkingText: '',
    streamingText: '',
    committedText: '',
    toolInputs: new Map(),
    deviceCallIds: new Set(),
    lastEventAt: Date.now(),
    rowStart: store.rows.length,
    resumeHint: options.resumeHint === true,
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
 * The `/usage` block: token split, run count, API time, and session cost.
 * Cost comes from the built-in price table (official vendor host only),
 * `pricing.models` in config, or MOSS_PRICE_IN / MOSS_PRICE_OUT. An unknown
 * model stays unpriced.
 */
export function usageBlock(
  usage: TuiUsageState,
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Readonly<Record<string, ModelPrice>>,
  baseUrl?: string
): string[] {
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
  const slices =
    usage.slices.length > 0
      ? usage.slices
      : [
          {
            ...(usage.sessionModel || usage.lastModel
              ? { model: usage.sessionModel ?? usage.lastModel }
              : {}),
            inputTokens: usage.tokensIn,
            outputTokens: usage.tokensOut,
            cacheReadTokens: usage.cacheReadTokens,
          },
        ];
  const zh = isTuiZh();
  const quote = quoteUsage(slices, {
    env,
    ...(overrides ? { overrides } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(usage.sessionModel || usage.lastModel
      ? { fallbackModel: usage.sessionModel ?? usage.lastModel }
      : {}),
  });
  if (quote.amount !== null && quote.currency) {
    lines.push(`cost        ${formatCostEstimate(quote.amount, quote.currency, zh)}`);
    const source = priceSourceLine(quote, zh);
    if (source) lines.push(source);
  } else {
    lines.push(unknownPriceMessage(quote.unknownModel ?? usage.lastModel, zh));
  }
  return lines;
}

export function endRun(store: TuiStore, halted: boolean): void {
  const visible = userFacingAssistantText(store.run.streamingText);
  if (visible.trim()) {
    const shown = normalizeShown(shownAssistantText(store));
    const want = normalizeShown(visible);
    // This run's rows already contain the live tail (often the whole answer
    // after a paragraph commit). Appending it paints the opening sentence again.
    if (!(shown && shown.includes(want))) {
      appendRow(store, 'assistant', visible, {
        ...(store.run.committedText ? { continuation: true } : {}),
        ...takeReasoning(store),
      });
    }
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
