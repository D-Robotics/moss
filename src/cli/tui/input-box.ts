/**
 * Bracketed-paste capture for the TUI input. Terminals wrap pasted text in
 * ESC[200~ … ESC[201~; a multi-line paste must become ONE queued message with
 * a visible confirmation instead of N accidental turns (the v0.13 readline
 * REPL failure mode this TUI fixes).
 */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

export interface PasteCaptureState {
  active: boolean;
  buffer: string;
  /** Completed pastes waiting for confirmation, newest last. */
  pending: string[];
}

export function createPasteCapture(): PasteCaptureState {
  return { active: false, buffer: '', pending: [] };
}

export interface ChunkDisposition {
  /** Data consumed by the paste capture (not for the line editor). */
  consumed: boolean;
  /** True the moment a paste completes (drives the confirm flash). */
  completed: boolean;
}

/**
 * Feed one stdin chunk. When a paste is active everything is buffered until
 * the end marker; when not active, a start marker begins one.
 */
export function feedChunk(state: PasteCaptureState, chunk: string): ChunkDisposition {
  if (state.active) {
    const endIdx = chunk.indexOf(PASTE_END);
    if (endIdx === -1) {
      state.buffer += chunk;
      return { consumed: true, completed: false };
    }
    state.buffer += chunk.slice(0, endIdx);
    state.pending.push(state.buffer);
    state.buffer = '';
    state.active = false;
    const rest = chunk.slice(endIdx + PASTE_END.length);
    if (rest) feedChunk(state, rest);
    return { consumed: true, completed: true };
  }
  const startIdx = chunk.indexOf(PASTE_START);
  if (startIdx === -1) return { consumed: false, completed: false };
  const before = chunk.slice(0, startIdx);
  state.active = true;
  const after = chunk.slice(startIdx + PASTE_START.length);
  const result = feedChunk(state, after);
  return { consumed: before.length === 0 || result.consumed, completed: result.completed };
}

/** Confirm the newest pending paste as a single message. */
export function confirmPendingPaste(state: PasteCaptureState): string | undefined {
  return state.pending.shift();
}
