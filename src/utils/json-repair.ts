/**
 * JSON repair — ported from Pi's `utils/json-parse.ts` (v0.80.3).
 *
 * LLMs sometimes produce JSON with raw control characters inside string
 * literals (e.g. a literal newline in a tool-call argument) or invalid escape
 * sequences (e.g. `\x` or `\d`). Standard `JSON.parse` rejects these, causing
 * tool-call parsing to fail. `repairJson` normalizes the string before parse:
 *
 * - Escapes raw control characters (U+0000–U+001F) inside string literals.
 * - Doubles backslashes before invalid escape characters (so `\d` → `\\d`).
 *
 * Zero dependencies. The `parseStreamingJson` function from Pi (which uses the
 * `partial-json` library for incomplete-JSON parsing) is NOT ported — moss has
 * its own `tryParsePartialArgsString` for that use case.
 */

const VALID_JSON_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't', 'u']);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000'}`;
  }
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 *
 * Only modifies content inside string literals (between unescaped double
 * quotes). Structural JSON (keys, braces, brackets, numbers) is untouched.
 */
export function repairJson(json: string): string {
  let repaired = '';
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    const char = json[index];

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === '\\') {
      const nextChar = json[index + 1];
      if (nextChar === undefined) {
        repaired += '\\\\';
        continue;
      }

      if (nextChar === 'u') {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }

      // 'u' is in VALID_JSON_ESCAPES but an invalid \u (non-hex digits after)
      // must NOT be treated as a valid escape — it would pass through unchanged
      // and JSON.parse would reject it with "Bad Unicode escape". Exclude 'u'
      // from the fallthrough so invalid \u sequences reach the doubling branch.
      if (nextChar !== 'u' && VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }

      // Invalid escape (e.g. \x, \d) — double the backslash so JSON.parse
      // treats it as a literal backslash followed by the char.
      repaired += '\\\\';
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}

/**
 * Parse JSON, attempting repair if the initial parse fails.
 * Returns `null` if the JSON cannot be parsed even after repair.
 */
export function parseJsonLoose(text: string): unknown | null {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairJson(text));
    } catch {
      return null;
    }
  }
}
