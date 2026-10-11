/**
 * O99 — run progress for long tasks.
 *
 * Display-only: does not change tool scheduling, safety, or approvals.
 * Progress lines go to stderr (or a sink); stdout stays for the final answer.
 *
 * Sources (priority):
 *   1. tool start / end (name + file or command summary)
 *   2. long-running tool heartbeats (tool_progress)
 *   3. model thinking with no tool for ≥30s — 「正在推理，已等待 Ns」
 * Heartbeat: if nothing real for 60s, emit a thinking-wait line (never silent).
 */
import type { MossAgentEvent } from '../core/index.js';

export const THINKING_WAIT_INTERVAL_MS = 30_000;
export const HEARTBEAT_MAX_GAP_MS = 60_000;

export type ProgressLineKind =
  | 'tool_start'
  | 'tool_end'
  | 'tool_progress'
  | 'thinking_wait'
  | 'done'
  | 'unfinished';

export interface ProgressLine {
  kind: ProgressLineKind;
  text: string;
  at: number;
}

export interface RunProgressSink {
  write(line: string): void;
}

export interface RunProgressClock {
  now(): number;
  setInterval(handler: () => void, ms: number): { clear(): void };
}

export interface CreateRunProgressTrackerOptions {
  sink: RunProgressSink;
  zh?: boolean;
  /** When false, tool_start / tool_end are not written (caller already prints them). */
  emitToolBoundaries?: boolean;
  thinkingWaitIntervalMs?: number;
  heartbeatMaxGapMs?: number;
  clock?: RunProgressClock;
}

const EXEC_LIKE = new Set(['exec', 'device_exec', 'docker_exec', 'exec_background']);

function defaultClock(): RunProgressClock {
  return {
    now: () => Date.now(),
    setInterval(handler, ms) {
      const id = setInterval(handler, ms);
      // Do not keep the Node process alive solely for progress heartbeats
      // (oneshot/tests that forget dispose would otherwise hang).
      if (typeof (id as NodeJS.Timeout).unref === 'function') {
        (id as NodeJS.Timeout).unref();
      }
      return { clear: () => clearInterval(id) };
    },
  };
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** File path / command / pattern summary for a tool call. */
export function summarizeToolTarget(toolName: string, input: Record<string, unknown> = {}): string {
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  if (
    toolName === 'read_file' ||
    toolName === 'write_file' ||
    toolName === 'edit_file' ||
    toolName === 'move_file' ||
    toolName === 'apply_patch'
  ) {
    return clip(pick('path', 'filePath', 'file_path', 'source', 'destination'), 72);
  }
  if (toolName === 'multi_edit' && Array.isArray(input.edits)) {
    const paths = (input.edits as Array<Record<string, unknown>>)
      .map((e) => (typeof e.path === 'string' ? e.path : ''))
      .filter(Boolean);
    if (paths.length === 1) return clip(paths[0]!.replace(/\\/g, '/'), 72);
    if (paths.length > 1) {
      return clip(`${paths[0]} +${paths.length - 1} more`.replace(/\\/g, '/'), 72);
    }
  }
  if (EXEC_LIKE.has(toolName)) {
    const command = pick('command');
    return command ? clip(command, 72) : '';
  }
  if (toolName === 'search_code' || toolName === 'search_files') {
    return clip(pick('pattern', 'query'), 40);
  }
  if (toolName === 'web_fetch') return clip(pick('url'), 60);
  return clip(pick('path', 'file_path', 'command', 'pattern', 'query', 'goal', 'url'), 72);
}

export function formatToolProgressLabel(
  toolName: string,
  input: Record<string, unknown> = {}
): string {
  const target = summarizeToolTarget(toolName, input);
  return target ? `${toolName}(${target})` : toolName;
}

/** Bucket elapsed ms into 30s steps (30, 60, 90, …). Minimum 30. */
export function thinkingWaitSeconds(elapsedMs: number, stepMs = THINKING_WAIT_INTERVAL_MS): number {
  const step = Math.max(1, stepMs);
  const n = Math.floor(elapsedMs / step) * (step / 1000);
  return Math.max(step / 1000, n);
}

export function formatThinkingWaitLine(elapsedMs: number, zh: boolean): string {
  const n = thinkingWaitSeconds(elapsedMs);
  return zh ? `正在推理，已等待 ${n}s` : `Still reasoning, waited ${n}s`;
}

export function formatToolStartLine(
  toolName: string,
  input: Record<string, unknown>,
  zh: boolean
): string {
  const label = formatToolProgressLabel(toolName, input);
  return zh ? `正在调用 ${label}` : `Calling ${label}`;
}

export function formatToolEndLine(
  toolName: string,
  input: Record<string, unknown>,
  zh: boolean,
  isError: boolean
): string {
  const label = formatToolProgressLabel(toolName, input);
  if (zh) return isError ? `调用失败 ${label}` : `已完成 ${label}`;
  return isError ? `Failed ${label}` : `Finished ${label}`;
}

export function formatToolRunningLine(
  toolName: string,
  input: Record<string, unknown>,
  elapsedSec: number,
  zh: boolean
): string {
  const label = formatToolProgressLabel(toolName, input);
  const sec = Math.max(0, Math.round(elapsedSec));
  return zh ? `正在跑 ${label} · 已 ${sec}s` : `Running ${label} · ${sec}s`;
}

export function formatUnfinishedLine(reason: string, zh: boolean): string {
  const detail = reason.replace(/\s+/g, ' ').trim() || (zh ? '任务未完成' : 'task unfinished');
  return zh ? `未完成：${detail}` : `Unfinished: ${detail}`;
}

export function formatDoneLine(zh: boolean): string {
  return zh ? '已完成' : 'Done';
}

export function unfinishedReasonFromStop(
  stopReason: string | undefined,
  zh: boolean
): string | undefined {
  if (!stopReason) return undefined;
  if (stopReason === 'max_turns_reached' || stopReason === 'tool_followup_cap_reached') {
    return zh ? '已到回合上限，任务暂停未完成' : 'hit the turn limit before finishing';
  }
  if (stopReason === 'tool_budget_reached') {
    return zh ? '工具预算用尽，任务未完成' : 'tool budget reached before finishing';
  }
  if (stopReason?.startsWith('budget_')) {
    return zh ? '运行预算用尽，任务未完成' : 'run budget exceeded before finishing';
  }
  if (stopReason === 'output_limit' || stopReason === 'max_tokens' || stopReason === 'length') {
    return zh ? '输出长度上限，回答不完整' : 'output limit reached; answer is incomplete';
  }
  if (stopReason === 'aborted_by_user') {
    return zh ? '用户中断' : 'interrupted by user';
  }
  if (stopReason === 'error') {
    return zh ? '执行出错，任务未完成' : 'error during execution';
  }
  return undefined;
}

export interface RunProgressTracker {
  onEvent(event: MossAgentEvent): void;
  /** Record activity without emitting (e.g. when another renderer already printed the tool line). */
  noteActivity(at?: number): void;
  dispose(): void;
  /** Test helper: emitted lines in order. */
  lines(): readonly ProgressLine[];
}

/**
 * Tracks silence and emits thinking-wait / tool-progress lines.
 * Empty slogans (`working…` / rotating verbs) are never emitted.
 */
export function createRunProgressTracker(
  options: CreateRunProgressTrackerOptions
): RunProgressTracker {
  const zh = options.zh === true;
  const emitToolBoundaries = options.emitToolBoundaries !== false;
  const waitInterval = options.thinkingWaitIntervalMs ?? THINKING_WAIT_INTERVAL_MS;
  const maxGap = options.heartbeatMaxGapMs ?? HEARTBEAT_MAX_GAP_MS;
  const clock = options.clock ?? defaultClock();
  const emitted: ProgressLine[] = [];

  let lastEmitAt = clock.now();
  let thinkingSince: number | undefined;
  let lastThinkingBucket = 0;
  let activeTool:
    | { toolCallId: string; toolName: string; input: Record<string, unknown> }
    | undefined;
  let disposed = false;
  let timer: { clear(): void } | undefined;

  function emit(kind: ProgressLineKind, text: string, at = clock.now()): void {
    // Dedup: never stack the exact same progress text ≥3 times in a row.
    const recent = emitted.slice(-2);
    if (recent.length === 2 && recent.every((line) => line.text === text)) {
      return;
    }
    emitted.push({ kind, text, at });
    lastEmitAt = at;
    options.sink.write(text);
  }

  function beginThinking(at = clock.now()): void {
    if (thinkingSince === undefined) {
      thinkingSince = at;
      lastThinkingBucket = 0;
    }
  }

  function endThinking(): void {
    thinkingSince = undefined;
    lastThinkingBucket = 0;
  }

  function maybeEmitThinkingWait(at = clock.now()): void {
    if (activeTool) return;
    if (thinkingSince === undefined) return;
    const elapsed = at - thinkingSince;
    if (elapsed < waitInterval) return;
    const bucket = thinkingWaitSeconds(elapsed, waitInterval);
    if (bucket === lastThinkingBucket) {
      // Still force a heartbeat if we have been silent too long.
      if (at - lastEmitAt < maxGap) return;
    }
    lastThinkingBucket = bucket;
    emit('thinking_wait', formatThinkingWaitLine(elapsed, zh), at);
  }

  function tick(): void {
    if (disposed) return;
    const at = clock.now();
    if (activeTool) {
      // Tool heartbeats come from tool_progress events; only fill a 60s gap.
      if (at - lastEmitAt >= maxGap) {
        emit(
          'tool_progress',
          formatToolRunningLine(
            activeTool.toolName,
            activeTool.input,
            Math.round((at - lastEmitAt) / 1000),
            zh
          ),
          at
        );
      }
      return;
    }
    if (thinkingSince === undefined) beginThinking(at);
    maybeEmitThinkingWait(at);
    if (at - lastEmitAt >= maxGap) {
      maybeEmitThinkingWait(at);
      if (at - lastEmitAt >= maxGap) {
        const elapsed = thinkingSince !== undefined ? at - thinkingSince : maxGap;
        emit('thinking_wait', formatThinkingWaitLine(elapsed, zh), at);
      }
    }
  }

  timer = clock.setInterval(tick, Math.min(waitInterval, maxGap, 5_000));

  return {
    noteActivity(at = clock.now()) {
      lastEmitAt = at;
    },
    onEvent(event: MossAgentEvent) {
      if (disposed) return;
      const at = clock.now();
      switch (event.type) {
        case 'turn_start':
          activeTool = undefined;
          beginThinking(at);
          // Do not emit empty "working…" — wait for a real tool or the 30s wait.
          break;
        case 'thinking_delta':
          beginThinking(at);
          lastEmitAt = at; // deltas count as activity for the 60s gap, but no line spam
          break;
        case 'text_delta':
          endThinking();
          lastEmitAt = at;
          break;
        case 'tool_start': {
          endThinking();
          activeTool = {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.input,
          };
          if (emitToolBoundaries) {
            emit('tool_start', formatToolStartLine(event.toolName, event.input, zh), at);
          } else {
            lastEmitAt = at;
          }
          break;
        }
        case 'tool_progress': {
          const input = activeTool?.input ?? {};
          emit(
            'tool_progress',
            formatToolRunningLine(event.toolName, input, event.elapsedSec, zh),
            at
          );
          break;
        }
        case 'tool_end': {
          const input = activeTool?.input ?? {};
          if (emitToolBoundaries) {
            emit('tool_end', formatToolEndLine(event.toolName, input, zh, event.isError), at);
          } else {
            lastEmitAt = at;
          }
          activeTool = undefined;
          beginThinking(at);
          break;
        }
        case 'retry':
          endThinking();
          beginThinking(at);
          lastEmitAt = at;
          break;
        case 'error': {
          endThinking();
          activeTool = undefined;
          if (emitToolBoundaries) {
            emit(
              'unfinished',
              formatUnfinishedLine(
                event.errorSurface?.userMessage?.trim() ||
                  (typeof event.error === 'string' ? event.error : '') ||
                  (zh ? '执行出错' : 'error'),
                zh
              ),
              at
            );
          } else {
            lastEmitAt = at;
          }
          break;
        }
        case 'done': {
          activeTool = undefined;
          endThinking();
          if (!emitToolBoundaries) {
            lastEmitAt = at;
            break;
          }
          const unfinished = unfinishedReasonFromStop(event.result?.stopReason, zh);
          if (unfinished) {
            emit('unfinished', formatUnfinishedLine(unfinished, zh), at);
          } else {
            emit('done', formatDoneLine(zh), at);
          }
          break;
        }
        default:
          break;
      }
    },
    dispose() {
      disposed = true;
      timer?.clear();
      timer = undefined;
    },
    lines() {
      return emitted;
    },
  };
}
