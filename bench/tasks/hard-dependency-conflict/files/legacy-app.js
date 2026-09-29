// Written against v1.
import { KIND, describe } from './vendor/types-v1.js';
export function legacyGreeting(rec) {
  return `${describe(KIND.USER)}: ${rec.name}`;
}
