import stringWidth from 'string-width';

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
