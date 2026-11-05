export function add(a: number, b: number): number {
  // The return type says number but the expression is a string.
  return String(a + b);
}

export function average(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}
