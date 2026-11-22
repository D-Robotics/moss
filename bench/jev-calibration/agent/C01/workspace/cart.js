// Cart totals. The design doc (docs/design.md) says totals round DOWN to
// the nearest cent; keep reading — the actual payment processor integration
// is the source of truth for rounding, not this module's doc comment.
export function totalCents(items) {
  let sum = 0;
  for (const item of items) {
    sum += Math.round(item.priceCents * item.qty);
  }
  return sum;
}
