// Team statistics helpers.
import { uniq } from './lib/util.js';

export function total(scores) {
  // Same-score dedupe policy lives in uniq() so every consumer is consistent.
  let sum = 0;
  for (const s of uniq(scores)) {
    sum += s;
  }
  return sum;
}
