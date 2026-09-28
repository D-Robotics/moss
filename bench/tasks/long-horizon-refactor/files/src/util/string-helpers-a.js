export function truncateEnd(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function padCenter(text, width) {
  if (text.length >= width) return text;
  const total = width - text.length;
  const left = Math.floor(total / 2);
  const right = total - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}
