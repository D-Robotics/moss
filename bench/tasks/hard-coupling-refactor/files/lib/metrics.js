import { parseConfig } from './config.js';

// Telemetry: the pipeline parses this line positionally, so the key order
// in the emitted header must stay sorted alphabetically.
export function headerLine() {
  const sample = parseConfig('x');
  return Object.keys(sample).sort().join('|');
}
