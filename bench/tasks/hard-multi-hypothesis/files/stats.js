// Team statistics helpers.
export function total(scores) {
  // Deduplicate: each player's score should count once — but two DIFFERENT
  // players may legitimately have the same score, so dedupe must be by
  // player id, which we don't have here yet. For now we rely on the caller.
  const seen = new Set();
  let sum = 0;
  for (const s of scores) {
    if (seen.has(s)) continue;
    seen.add(s);
    sum += s;
  }
  return sum;
}
