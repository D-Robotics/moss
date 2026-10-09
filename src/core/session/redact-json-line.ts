import { redactEgress } from '../../safety/tool-output-redact.js';

/**
 * Whole-line redaction can match `Password=\S{8,}` across a JSON string
 * boundary. The result may still parse while dropping a later array element,
 * so keep it only when the shape is unchanged. String values may differ.
 */
function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameShape(item, b[i]));
  }
  if (a && b && typeof a === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) =>
      sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
  }
  if (typeof a === 'string') return true;
  return a === b;
}

/** Redact each string value, then the whole line; keep whole-line result only if the shape matches. */
export function redactJsonLine(value: unknown): string {
  const inner = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' ? redactEgress(item) : item
  );
  const outer = redactEgress(inner);
  if (outer === inner) return inner;
  try {
    return sameShape(JSON.parse(inner), JSON.parse(outer)) ? outer : inner;
  } catch {
    return inner;
  }
}
