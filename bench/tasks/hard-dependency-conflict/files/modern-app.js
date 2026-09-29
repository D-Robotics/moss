// Written against v2.
import { KIND, describe } from './vendor/types-v2.js';
export function modernGreeting(rec) {
  return `${describe(KIND.USER)}: ${rec.name}`;
}
