import stringWidth from 'string-width';
import { sanitizePromptEditorText, sanitizeRenderableText } from './terminal-text.js';

export function editorPreviewLines(value: string, placeholder: string, maxLines = 8): string[] {
  if (!value) return [placeholder];
  const normalized = sanitizeRenderableText(value).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length <= maxLines) return lines;
  return [`... ${lines.length - maxLines} earlier input lines ...`, ...lines.slice(-maxLines)];
}

export interface PromptEditState {
  value: string;
  cursor: number;
}

export type PromptEditIntent =
  | { type: 'insert'; text: string }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'killBefore' }
  | { type: 'killAfter' }
  | { type: 'deletePreviousWord' };

export function clampPromptCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.trunc(cursor)));
}

interface GraphemeSegment {
  index: number;
  segment: string;
}

type GraphemeSegmenter = {
  segment(input: string): Iterable<GraphemeSegment>;
};

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' }
) => GraphemeSegmenter;

export const NativeSegmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenterConstructor })
  .Segmenter;
const graphemeSegmenter = NativeSegmenter
  ? new NativeSegmenter(undefined, { granularity: 'grapheme' })
  : null;

export function codePointSegments(value: string): GraphemeSegment[] {
  const segments: GraphemeSegment[] = [];
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    const length = codePoint && codePoint > 0xffff ? 2 : 1;
    segments.push({ index, segment: value.slice(index, index + length) });
    index += length;
  }
  return segments;
}

export function graphemeSegments(value: string): GraphemeSegment[] {
  if (!value) return [];
  return graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value))
    : codePointSegments(value);
}

export function previousGraphemeStart(value: string, cursor: number): number {
  const index = clampPromptCursor(value, cursor);
  if (index <= 0) return 0;
  let previous = 0;
  for (const segment of graphemeSegments(value)) {
    if (segment.index >= index) break;
    previous = segment.index;
  }
  return previous;
}

export function nextGraphemeEnd(value: string, cursor: number): number {
  const index = clampPromptCursor(value, cursor);
  if (index >= value.length) return value.length;
  for (const segment of graphemeSegments(value)) {
    const end = segment.index + segment.segment.length;
    if (end > index) return end;
  }
  return value.length;
}

export function previousWordStart(value: string, cursor: number): number {
  let index = clampPromptCursor(value, cursor);
  while (index > 0 && /\s/.test(value[index - 1] || '')) index -= 1;
  while (index > 0 && !/\s/.test(value[index - 1] || '')) index -= 1;
  return index;
}

export function applyPromptEdit(state: PromptEditState, intent: PromptEditIntent): PromptEditState {
  const value = state.value;
  const cursor = clampPromptCursor(value, state.cursor);
  switch (intent.type) {
    case 'insert': {
      const text = intent.text.replace(/\r\n?/g, '\n');
      return {
        value: `${value.slice(0, cursor)}${text}${value.slice(cursor)}`,
        cursor: cursor + text.length,
      };
    }
    case 'left':
      return { value, cursor: previousGraphemeStart(value, cursor) };
    case 'right':
      return { value, cursor: nextGraphemeEnd(value, cursor) };
    case 'home':
      return { value, cursor: 0 };
    case 'end':
      return { value, cursor: value.length };
    case 'backspace':
      if (cursor === 0) return { value, cursor };
      {
        // Check if the cursor is right after an attachment token like [Image #1] or @[file.ts]
        // and delete the whole token atomically instead of char-by-char.
        const beforeCursor = value.slice(0, cursor);
        const attachTokenMatch = beforeCursor.match(/(\[(?:Image|File)\s+#\d+\]|@\[[^\]]+\])\s*$/);
        if (attachTokenMatch) {
          const tokenStart = cursor - attachTokenMatch[0].length;
          return {
            value: `${value.slice(0, tokenStart)}${value.slice(cursor)}`,
            cursor: tokenStart,
          };
        }
        const start = previousGraphemeStart(value, cursor);
        return { value: `${value.slice(0, start)}${value.slice(cursor)}`, cursor: start };
      }
    case 'delete':
      if (cursor >= value.length) return { value, cursor };
      return {
        value: `${value.slice(0, cursor)}${value.slice(nextGraphemeEnd(value, cursor))}`,
        cursor,
      };
    case 'killBefore':
      return { value: value.slice(cursor), cursor: 0 };
    case 'killAfter':
      return { value: value.slice(0, cursor), cursor };
    case 'deletePreviousWord': {
      const start = previousWordStart(value, cursor);
      return { value: `${value.slice(0, start)}${value.slice(cursor)}`, cursor: start };
    }
  }
}

export function shouldPromptReturnInsertNewline(key: { shift?: boolean; ctrl?: boolean }): boolean {
  return Boolean(key.shift);
}

interface EditorPreviewLine {
  text: string;
  /** Terminal display cells from line start to cursor, not a UTF-16 index. */
  cursorColumn: number | null;
}

interface LineViewportResult {
  text: string;
  cursorColumn: number;
}

interface DisplaySegment {
  segment: string;
  startColumn: number;
  endColumn: number;
}

export function displaySegments(value: string): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  let column = 0;
  for (const { segment } of graphemeSegments(value)) {
    const width = stringWidth(segment);
    segments.push({ segment, startColumn: column, endColumn: column + width });
    column += width;
  }
  return segments;
}

export function lineViewportAroundCursor(
  text: string,
  cursorColumn: number,
  maxWidth?: number
): LineViewportResult {
  if (!maxWidth || !Number.isFinite(maxWidth)) return { text, cursorColumn };
  const width = Math.max(1, Math.trunc(maxWidth));
  const lineWidth = stringWidth(text);
  const safeCursor = Math.max(0, Math.min(lineWidth, cursorColumn));
  if (lineWidth <= width) return { text, cursorColumn: safeCursor };

  const startTarget = safeCursor > width ? safeCursor - width : 0;
  const segments = displaySegments(text);
  let startIndex = segments.findIndex((segment) => segment.startColumn >= startTarget);
  if (startIndex < 0) startIndex = Math.max(0, segments.length - 1);
  const visibleStart = segments[startIndex]?.startColumn ?? 0;
  let visibleWidth = 0;
  let visibleText = '';
  for (const segment of segments.slice(startIndex)) {
    const segmentWidth = segment.endColumn - segment.startColumn;
    if (visibleText && visibleWidth + segmentWidth > width) break;
    if (!visibleText && segmentWidth > width) break;
    visibleText += segment.segment;
    visibleWidth += segmentWidth;
  }

  return {
    text: visibleText,
    cursorColumn: Math.max(0, Math.min(width, safeCursor - visibleStart)),
  };
}

export function editorPreviewLinesWithCursor(
  value: string,
  _placeholder: string,
  cursor: number,
  maxLines = 8,
  maxLineWidth?: number
): EditorPreviewLine[] {
  if (!value) return [{ text: '', cursorColumn: 0 }];
  const normalized = sanitizePromptEditorText(value).replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const normalizedCursor = clampPromptCursor(value, cursor);
  const normalizedBeforeCursor = sanitizePromptEditorText(value.slice(0, normalizedCursor)).replace(
    /\r\n?/g,
    '\n'
  );
  const cursorLineIndex = normalizedBeforeCursor.split('\n').length - 1;
  const cursorColumn = stringWidth(
    normalizedBeforeCursor.slice(normalizedBeforeCursor.lastIndexOf('\n') + 1)
  );
  const fitLine = (line: string, lineCursorColumn: number | null): EditorPreviewLine => {
    const viewport = lineViewportAroundCursor(
      line,
      lineCursorColumn ?? stringWidth(line),
      maxLineWidth
    );
    return {
      text: viewport.text,
      cursorColumn: lineCursorColumn === null ? null : viewport.cursorColumn,
    };
  };
  if (lines.length <= maxLines) {
    return lines.map((line, index) =>
      fitLine(line, index === cursorLineIndex ? cursorColumn : null)
    );
  }
  const hiddenCount = lines.length - maxLines;
  return [
    { text: `... ${hiddenCount} earlier input lines ...`, cursorColumn: null },
    ...lines.slice(-maxLines).map((line, index) => {
      const originalIndex = hiddenCount + index;
      return fitLine(line, originalIndex === cursorLineIndex ? cursorColumn : null);
    }),
  ];
}
