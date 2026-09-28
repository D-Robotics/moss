export function clamp(n, lo, hi) {
  return n < lo ? hi : n > hi ? lo : n;
}
