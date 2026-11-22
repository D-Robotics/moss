// Team statistics helpers.
export function total(scores) {
  let sum = 0;
  for (const s of scores) {
    sum += s;
  }
  return sum;
}
