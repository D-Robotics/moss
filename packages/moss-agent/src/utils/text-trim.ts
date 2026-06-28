




export function truncateLine(text: string, max: number): string {
  const oneLine = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return oneLine.length > max ? `${oneLine.slice(0, max).trim()}…` : oneLine;
}
