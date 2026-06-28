import React, { useMemo, useState } from 'react';
import { Box } from 'ink';








export interface VirtualListProps<T> {
  items: T[];
  viewportHeight: number;
  renderItem: (item: T, index: number) => React.ReactElement;
  estimateHeight?: (item: T, index: number) => number;
  scroll: number;
  overscan?: number;
  keyPrefix?: string;
}


function computeOffsets<T>(
  items: T[],
  estimateHeight: (item: T, index: number) => number
): number[] {
  const offsets: number[] = new Array(items.length);
  let y = 0;
  for (let i = 0; i < items.length; i++) {
    offsets[i] = y;
    y += estimateHeight(items[i]!, i);
  }
  return offsets;
}


function findVisibleRange(
  itemCount: number,
  offsets: number[],
  scroll: number,
  viewportHeight: number,
  estimateHeight: (index: number) => number,
  overscan: number
): [number, number] {
  let start = 0;
  for (let i = 0; i < itemCount; i++) {
    const bottom = offsets[i]! + estimateHeight(i);
    if (bottom > scroll) {
      start = Math.max(0, i - overscan);
      break;
    }
  }
  const scrollEnd = scroll + viewportHeight;
  let end = itemCount;
  for (let i = start; i < itemCount; i++) {
    if (offsets[i]! >= scrollEnd) {
      end = Math.min(itemCount, i + overscan);
      break;
    }
  }
  return [start, end];
}

export function VirtualList<T>({
  items,
  viewportHeight,
  renderItem,
  estimateHeight = () => 1,
  scroll,
  overscan = 5,
  keyPrefix = 'vl',
}: VirtualListProps<T>): React.ReactElement {
  
  const offsets = useMemo(() => computeOffsets(items, estimateHeight), [items, estimateHeight]);

  const estimateHeightByIdx = (idx: number) => estimateHeight(items[idx]!, idx);

  const [start, end] = useMemo(
    () =>
      findVisibleRange(
        items.length,
        offsets,
        scroll,
        viewportHeight,
        estimateHeightByIdx,
        overscan
      ),
    [items.length, offsets, scroll, viewportHeight, overscan]
  );

  const topSpacerHeight = start > 0 ? offsets[start]! : 0;

  return React.createElement(
    Box,
    { flexDirection: 'column', height: viewportHeight, overflow: 'hidden' },
    
    topSpacerHeight > 0
      ? React.createElement(Box, { key: `${keyPrefix}-top`, height: topSpacerHeight })
      : null,
    
    ...Array.from({ length: end - start }, (_, i) => {
      const idx = start + i;
      return React.createElement(
        Box,
        { key: `${keyPrefix}-${idx}`, flexDirection: 'column', flexShrink: 0 },
        renderItem(items[idx]!, idx)
      );
    }),
    
    React.createElement(Box, { key: `${keyPrefix}-bottom`, flexGrow: 1 })
  );
}





export function useVirtualScroll(
  totalHeight: number,
  viewportHeight: number
): [number, (delta: number) => void, (s: number) => void] {
  const [scroll, setScrollState] = useState(0);
  const maxScroll = Math.max(0, totalHeight - viewportHeight);

  const scrollBy = (delta: number) => {
    setScrollState((prev) => Math.min(Math.max(0, prev + delta), maxScroll));
  };

  const setScroll = (s: number) => {
    setScrollState(Math.min(Math.max(0, s), maxScroll));
  };

  return [scroll, scrollBy, setScroll];
}





export function parseSgrMouse(buf: string): {
  events: Array<{ kind: 'click' | 'wheel-up' | 'wheel-down'; col: number; row: number }>;
  rest: string;
} {
  
  // eslint-disable-next-line no-control-regex -- SGR mouse sequences begin with a literal ESC (\x1b)
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  const events: Array<{ kind: 'click' | 'wheel-up' | 'wheel-down'; col: number; row: number }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    last = re.lastIndex;
    const btn = Number(m[1]);
    const col = Number(m[2]);
    const row = Number(m[3]);
    const press = m[4] === 'M';
    if (btn === 64) events.push({ kind: 'wheel-up', col, row });
    else if (btn === 65) events.push({ kind: 'wheel-down', col, row });
    else if ((btn & 0b11) === 0 && !press) events.push({ kind: 'click', col, row });
  }
  const tail = buf.indexOf('\x1b', last);
  const rest = tail >= 0 && buf.length - tail < 32 ? buf.slice(tail) : '';
  return { events, rest };
}
