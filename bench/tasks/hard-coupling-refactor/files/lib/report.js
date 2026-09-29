import { parseConfig } from './config.js';
import { auditContract } from './audit.js';

// The audit gate runs on every parse; the app crashes if the contract drifts.
export function render(raw) {
  const result = parseConfig(raw);
  if (!auditContract(result, ['ok', 'value'])) {
    throw new Error('config contract violated');
  }
  return result.ok ? `value=${result.value}` : 'invalid';
}
