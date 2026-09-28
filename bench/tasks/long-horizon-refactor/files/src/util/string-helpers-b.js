// Near-duplicate of string-helpers-a (seeded drift): same behaviors,
// different signatures — the refactor must unify onto ONE implementation.
export function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function centerPad(text, width) {
  if (text.length >= width) return text;
  const total = width - text.length;
  const left = Math.ceil(total / 2);
  const right = total - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}
