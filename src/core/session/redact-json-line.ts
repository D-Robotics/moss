import { redactEgress } from '../../safety/tool-output-redact.js';

/** Redact each string value, then the whole line; keep whole-line result only if it still parses. */
export function redactJsonLine(value: unknown): string {
  const inner = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' ? redactEgress(item) : item
  );
  const outer = redactEgress(inner);
  if (outer === inner) return inner;
  try {
    JSON.parse(outer);
    return outer;
  } catch {
    return inner;
  }
}
