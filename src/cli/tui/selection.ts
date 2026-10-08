/** Plain text covered by a drag selection on viewport lines. */
export interface SelectionPoint {
  x: number;
  y: number;
}

export function selectionText(
  lines: readonly string[],
  anchor: SelectionPoint,
  head: SelectionPoint
): string {
  if (lines.length === 0) return '';
  const start = anchor.y <= head.y ? anchor : head;
  const end = anchor.y <= head.y ? head : anchor;
  const top = Math.max(0, Math.min(start.y, lines.length - 1));
  const bottom = Math.max(0, Math.min(end.y, lines.length - 1));
  if (top === bottom) {
    const line = lines[top] ?? '';
    const from = Math.min(start.x, end.x, line.length);
    const to = Math.max(start.x, end.x, from);
    return line.slice(from, to);
  }
  const parts: string[] = [];
  parts.push((lines[top] ?? '').slice(Math.max(0, start.x)));
  for (let row = top + 1; row < bottom; row += 1) parts.push(lines[row] ?? '');
  parts.push((lines[bottom] ?? '').slice(0, Math.max(0, end.x)));
  return parts.join('\n');
}
