/**
 * Atomic paste tokens for the composer.
 *
 * A short paste is inserted at the caret. A longer paste becomes one
 * indivisible label (`[Pasted text #n +N lines]`) whose body is expanded only
 * when the message is sent to the model. The transcript keeps the label.
 */
import {
  composerDelete,
  composerInsert,
  composerKill,
  composerMove,
  type ComposerDeleteUnit,
  type ComposerMotion,
  type ComposerState,
} from './composer.js';

export const INLINE_PASTE_MAX_LINES = 2;
export const INLINE_PASTE_MAX_CHARS = 800;
export const LARGE_PASTE_CHARS = 100_000;

export interface PasteToken {
  id: number;
  /** Inclusive UTF-16 offset of the label in the composer value. */
  start: number;
  /** Exclusive UTF-16 offset. */
  end: number;
  /** Original paste, sent to the model on submit. */
  body: string;
  lines: number;
  large: boolean;
}

export interface PasteDoc {
  state: ComposerState;
  tokens: PasteToken[];
}

export function emptyPasteDoc(value = ''): PasteDoc {
  return { state: { value, caret: value.length }, tokens: [] };
}

/** Visual lines: a trailing newline does not add an empty line. */
export function pasteVisualLines(text: string): number {
  if (text.length === 0) return 0;
  const parts = text.split('\n');
  return parts[parts.length - 1] === '' ? Math.max(1, parts.length - 1) : parts.length;
}

export function pasteLabel(id: number, lines: number, large: boolean, chars: number): string {
  const size = large ? ` · LARGE ${Math.round(chars / 1000)}k chars` : '';
  return `[Pasted text #${id} +${lines} lines${size}]`;
}

export function expandPasteTokens(value: string, tokens: readonly PasteToken[]): string {
  const ordered = [...tokens].sort((a, b) => b.start - a.start);
  let out = value;
  for (const token of ordered) {
    if (token.start < 0 || token.end > out.length || token.start > token.end) continue;
    out = `${out.slice(0, token.start)}${token.body}${out.slice(token.end)}`;
  }
  return out;
}

function shiftTokens(tokens: readonly PasteToken[], at: number, delta: number): PasteToken[] {
  if (delta === 0) return [...tokens];
  return tokens.map((token) =>
    token.start >= at ? { ...token, start: token.start + delta, end: token.end + delta } : token
  );
}

function covering(tokens: readonly PasteToken[], from: number, to: number): PasteToken[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  return tokens.filter((token) => token.end > start && token.start < end);
}

function deleteRange(doc: PasteDoc, from: number, to: number): PasteDoc {
  let start = Math.min(from, to);
  let end = Math.max(from, to);
  const hit = covering(doc.tokens, start, end);
  for (const token of hit) {
    start = Math.min(start, token.start);
    end = Math.max(end, token.end);
  }
  const removed = new Set(hit.map((token) => token.id));
  const value = doc.state.value.slice(0, start) + doc.state.value.slice(end);
  const delta = start - end;
  const tokens = doc.tokens
    .filter((token) => !removed.has(token.id))
    .map((token) =>
      token.start >= end ? { ...token, start: token.start + delta, end: token.end + delta } : token
    );
  return { state: { value, caret: start }, tokens };
}

function snapCaretToEdge(doc: PasteDoc): PasteDoc {
  const inside = doc.tokens.find(
    (token) => doc.state.caret > token.start && doc.state.caret < token.end
  );
  if (!inside) return doc;
  return { ...doc, state: { ...doc.state, caret: inside.end } };
}

export function insertText(doc: PasteDoc, text: string): PasteDoc {
  const snapped = snapCaretToEdge(doc);
  const next = composerInsert(snapped.state, text);
  return {
    state: next,
    tokens: shiftTokens(snapped.tokens, snapped.state.caret, text.length),
  };
}

export function insertPaste(doc: PasteDoc, raw: string, id: number): PasteDoc {
  const lines = pasteVisualLines(raw);
  const inline = lines <= INLINE_PASTE_MAX_LINES && raw.length <= INLINE_PASTE_MAX_CHARS;
  if (inline) return insertText(doc, raw);
  const large = raw.length > LARGE_PASTE_CHARS;
  const label = pasteLabel(id, lines, large, raw.length);
  const snapped = snapCaretToEdge(doc);
  const at = snapped.state.caret;
  const next = composerInsert(snapped.state, label);
  const token: PasteToken = {
    id,
    start: at,
    end: at + label.length,
    body: raw,
    lines,
    large,
  };
  return {
    state: next,
    tokens: [...shiftTokens(snapped.tokens, at, label.length), token].sort(
      (a, b) => a.start - b.start
    ),
  };
}

export function deleteText(doc: PasteDoc, unit: ComposerDeleteUnit): PasteDoc {
  const { value, caret } = doc.state;
  if (unit === 'backward') {
    const token = doc.tokens.find((entry) => caret > entry.start && caret <= entry.end);
    if (token) return deleteRange(doc, token.start, token.end);
    const next = composerDelete(doc.state, 'backward');
    if (next.caret === caret) return doc;
    return deleteRange(doc, next.caret, caret);
  }
  if (unit === 'forward') {
    const token = doc.tokens.find((entry) => caret >= entry.start && caret < entry.end);
    if (token) return deleteRange(doc, token.start, token.end);
    const next = composerDelete(doc.state, 'forward');
    if (next.value === value) return doc;
    return deleteRange(doc, caret, caret + (value.length - next.value.length));
  }
  if (unit === 'word-backward') {
    const moved = moveCaret(doc, 'word-left');
    if (moved.state.caret === caret) return doc;
    return deleteRange(doc, moved.state.caret, caret);
  }
  if (unit === 'line-start' || unit === 'line-end') {
    const moved = composerDelete(doc.state, unit);
    if (moved.value === value) return doc;
    const from = Math.min(moved.caret, caret);
    const to = from + (value.length - moved.value.length);
    return deleteRange(doc, from, to);
  }
  return doc;
}

export function killText(
  doc: PasteDoc,
  unit: 'word-backward' | 'line-start' | 'line-end'
): { doc: PasteDoc; killed: string } {
  if (unit === 'word-backward') {
    const moved = moveCaret(doc, 'word-left');
    const killed = doc.state.value.slice(moved.state.caret, doc.state.caret);
    return { doc: deleteRange(doc, moved.state.caret, doc.state.caret), killed };
  }
  const killed = composerKill(doc.state, unit).killed;
  const next = deleteText(doc, unit);
  return { doc: next, killed };
}

export function moveCaret(doc: PasteDoc, motion: ComposerMotion, width = 80): PasteDoc {
  const { caret } = doc.state;
  if (motion === 'left') {
    const token = doc.tokens.find((entry) => caret > entry.start && caret <= entry.end);
    if (token) return { ...doc, state: { ...doc.state, caret: token.start } };
    return { ...doc, state: composerMove(doc.state, 'left', width) };
  }
  if (motion === 'right') {
    const token = doc.tokens.find((entry) => caret >= entry.start && caret < entry.end);
    if (token) return { ...doc, state: { ...doc.state, caret: token.end } };
    return { ...doc, state: composerMove(doc.state, 'right', width) };
  }
  if (motion === 'word-left' || motion === 'word-right') {
    const next = composerMove(doc.state, motion, width);
    const from = Math.min(caret, next.caret);
    const to = Math.max(caret, next.caret);
    const hit = covering(doc.tokens, from, to);
    if (hit.length === 0) return { ...doc, state: next };
    const edge =
      motion === 'word-left'
        ? Math.min(...hit.map((token) => token.start))
        : Math.max(...hit.map((token) => token.end));
    return { ...doc, state: { ...doc.state, caret: edge } };
  }
  return { ...doc, state: composerMove(doc.state, motion, width) };
}
