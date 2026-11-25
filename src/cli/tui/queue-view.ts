/**
 * The input queue's pure projection: the rows printed above the composer
 * rule, the `/queue` argument parser, and the ↑ / Alt+↑ recall.
 *
 * The shell owns the array of waiting inputs (`queueRef`). Everything that
 * decides what the user SEES for that array lives here, so it can be checked
 * without a terminal (scripts/verify/tui-interaction.mjs).
 */
import { tui } from './copy.js';
import { clip, line, type TuiLine } from './text.js';
import { TONE } from './theme.js';

/** One input waiting for the current run to finish. */
export interface QueuedInput {
  /** What the user typed: the composer line ↑ / Alt+↑ puts back. */
  display: string;
  /** What gets submitted. */
  text: string;
  internal?: boolean;
}

/** Queued rows shown before the rest folds into one `+N more` line. */
export const QUEUE_PREVIEW_LIMIT = 5;

export interface QueueChromeOptions {
  width: number;
  /** A run is in flight, so the follow-ups wait for it. */
  running: boolean;
  /** `/queue pause`: the queue keeps its rows but nothing drains. */
  paused: boolean;
  limit?: number;
}

/** One queued row on one line: collapsed whitespace, at most 72 characters. */
export function queuePreview(display: string): string {
  return display.replace(/\s+/g, ' ').trim().slice(0, 72);
}

/** Rows printed above the composer rule while the queue is not empty. */
export function renderQueueChrome(
  queue: readonly QueuedInput[],
  options: QueueChromeOptions
): TuiLine[] {
  if (queue.length === 0) return [];
  const limit = Math.max(1, options.limit ?? QUEUE_PREVIEW_LIMIT);
  const out: TuiLine[] = [];
  if (options.paused) {
    out.push(
      line(clip(`  ${tui('Queue paused — /queue resume')}`, options.width), { color: TONE.warn })
    );
  }
  queue.slice(0, limit).forEach((item, index) => {
    out.push(
      line(
        clip(
          tui('  queued {n}. {text}', { n: index + 1, text: queuePreview(item.display) }),
          options.width
        ),
        { dim: true }
      )
    );
  });
  const hidden = queue.length - Math.min(queue.length, limit);
  if (hidden > 0) {
    out.push(
      line(
        clip(
          `  ${tui('… +{count} more queued — /queue to list', { count: hidden })}`,
          options.width
        ),
        { dim: true }
      )
    );
  }
  out.push(
    line(clip(`  ${tui('Alt+↑ edits the newest · ↑ when the composer is empty')}`, options.width), {
      dim: true,
    })
  );
  if (options.running) {
    out.push(
      line(clip(`  ${tui('queued — applies when this run finishes')}`, options.width), {
        dim: true,
      })
    );
  }
  return out;
}

/** What `/queue …` asks for. The five subcommand words are reserved. */
export type QueueCommand =
  | { kind: 'list' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'drop' }
  | { kind: 'clear' }
  | { kind: 'enqueue'; text: string };

function queueSubcommand(word: string): 'pause' | 'resume' | 'drop' | 'clear' | undefined {
  return word === 'pause' || word === 'resume' || word === 'drop' || word === 'clear'
    ? word
    : undefined;
}

/**
 * `/queue` arguments. Anything after the command that is not a subcommand is
 * a follow-up to queue, so `/queue fix the tests` never needs a verb.
 */
export function parseQueueCommand(args: string): QueueCommand {
  const trimmed = args.trim();
  const head = (trimmed.split(/\s+/, 1)[0] ?? '').toLowerCase();
  if (!trimmed || head === 'list') return { kind: 'list' };
  const sub = queueSubcommand(head);
  return sub ? { kind: sub } : { kind: 'enqueue', text: trimmed };
}

/** A recalled line above the draft being typed; trailing whitespace on the draft is dropped. */
function aboveDraft(recalled: string, draft: string): string {
  const typed = draft.replace(/\s+$/, '');
  return typed ? `${recalled}\n${typed}` : recalled;
}

/**
 * Take the newest queued input back into the composer. A draft being typed
 * stays below the recalled line, so nothing typed is lost. Mutates `queue`.
 */
export function recallQueuedInput(queue: QueuedInput[], draft: string): string | undefined {
  const last = queue.pop();
  if (!last) return undefined;
  return aboveDraft(last.display, draft);
}

/**
 * Esc while a run is in flight: every queued line goes back into the
 * composer, oldest first, with the draft last. Mutates `queue` (empties it).
 * An empty queue leaves the draft alone.
 */
export function returnQueueToDraft(queue: QueuedInput[], draft: string): string {
  const returned = queue.map((item) => item.display).join('\n');
  queue.length = 0;
  return returned ? aboveDraft(returned, draft) : draft;
}
