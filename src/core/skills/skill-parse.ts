/**
 * SKILL.md parsing: a deliberately small YAML subset.
 *
 * The previous parser split each frontmatter line on the first `:` and called it
 * a day. That silently broke on the shapes real skills use: multi-line
 * descriptions (`description: |`), inline lists (`allowed-tools: [read_file, exec]`),
 * block lists (`globs:\n  - src/**`), and the spec's `metadata:` map. A broken
 * description means the model sees an empty skill in the catalog, so this file
 * parses those shapes and reports anything it cannot represent instead of
 * guessing.
 *
 * Not supported (reported as `unsupported-yaml`, never fatal): nested maps deeper
 * than one level, anchors/aliases, multi-document files, tabs for indentation.
 */

export interface FrontmatterIssue {
  code: 'malformed-frontmatter' | 'unsupported-yaml';
  message: string;
}

export interface ParsedFrontmatter {
  /** Scalar strings; lists joined with ", "; maps are not included. Compatibility view. */
  flat: Record<string, string>;
  /** Typed view used by the skill loader. */
  fields: Record<string, string | string[] | Record<string, string>>;
  body: string;
  issues: FrontmatterIssue[];
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** `[a, b]` → ['a','b']; `[a]` → ['a']; anything else → undefined. */
function parseInlineList(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined;
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((item) => unquote(item))
    .filter((item) => item.length > 0);
}

/**
 * Parse `---`-delimited frontmatter and the body after it. Lenient: a malformed
 * header returns an empty field map plus an issue; the body still loads.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const issues: FrontmatterIssue[] = [];
  if (!normalized.startsWith('---\n') && normalized.trimStart() !== normalized) {
    // leading whitespace before the delimiter: tolerate but note it
  }
  const start = normalized.indexOf('---');
  if (start !== 0) {
    return { flat: {}, fields: {}, body: normalized, issues };
  }
  const close = normalized.indexOf('\n---', 3);
  if (close === -1) {
    issues.push({
      code: 'malformed-frontmatter',
      message: 'frontmatter starts with "---" but has no closing "---" line',
    });
    return { flat: {}, fields: {}, body: normalized, issues };
  }
  const header = normalized.slice(3, close).replace(/^\n/, '');
  const body = normalized.slice(close + 4).replace(/^\n+/, '');

  const flat: Record<string, string> = {};
  const fields: Record<string, string | string[] | Record<string, string>> = {};
  const lines = header.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    index += 1;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) {
      issues.push({
        code: 'unsupported-yaml',
        message: `unexpected indented line without a parent key: ${line.trim().slice(0, 80)}`,
      });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      issues.push({
        code: 'malformed-frontmatter',
        message: `frontmatter line is not "key: value": ${line.trim().slice(0, 80)}`,
      });
      continue;
    }
    const key = line.slice(0, colon).trim();
    const rawValue = line.slice(colon + 1);

    // Block scalars: `|` (keep newlines) and `>` (fold to spaces).
    const blockMarker = rawValue.trim();
    if (blockMarker === '|' || blockMarker === '>') {
      const collected: string[] = [];
      while (
        index < lines.length &&
        (/^\s/.test(lines[index] ?? '') || !(lines[index] ?? '').trim())
      ) {
        collected.push((lines[index] ?? '').replace(/^\s{1,4}/, ''));
        index += 1;
      }
      const textValue =
        blockMarker === '|'
          ? collected.join('\n').trim()
          : collected.join(' ').replace(/\s+/g, ' ').trim();
      fields[key] = textValue;
      flat[key] = textValue;
      continue;
    }

    // One level of nested map (`metadata:` then indented `k: v`).
    if (!rawValue.trim()) {
      const nested: Record<string, string> = {};
      let sawItem = false;
      while (index < lines.length) {
        const next = lines[index] ?? '';
        if (!/^\s/.test(next)) break;
        index += 1;
        const nestedLine = next.trim();
        if (!nestedLine || nestedLine.startsWith('#')) continue;
        if (nestedLine.startsWith('- ')) {
          issues.push({
            code: 'unsupported-yaml',
            message: `list under "${key}" is not supported (only globs/allowed-tools take lists)`,
          });
          continue;
        }
        const nestedColon = nestedLine.indexOf(':');
        if (nestedColon <= 0) {
          issues.push({
            code: 'malformed-frontmatter',
            message: `nested line under "${key}" is not "k: v": ${nestedLine.slice(0, 80)}`,
          });
          continue;
        }
        const nestedKey = nestedLine.slice(0, nestedColon).trim();
        const nestedValue = unquote(nestedLine.slice(nestedColon + 1));
        nested[nestedKey] = nestedValue;
        sawItem = true;
      }
      if (sawItem) fields[key] = nested;
      continue;
    }

    const inlineList = parseInlineList(rawValue);
    if (inlineList) {
      fields[key] = inlineList;
      flat[key] = inlineList.join(', ');
      continue;
    }

    const scalar = unquote(rawValue);
    // Block list: a key with an empty value followed by "- item" lines is
    // handled by the branch above only when it is a map; lists start with "- ".
    fields[key] = scalar;
    flat[key] = scalar;
  }

  // Block lists written as `key:\n  - a\n  - b` were captured as nested unsupported
  // lines; detect and parse them here instead (globs/allowed-tools use this form).
  for (const match of header.matchAll(/^([a-zA-Z0-9_-]+):\s*\n((?:[ \t]+-[^\n]*\n?)+)/gm)) {
    const key = match[1];
    if (!key) continue;
    const items = (match[2] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => unquote(line.slice(2)));
    if (items.length > 0 && (fields[key] === undefined || Array.isArray(fields[key]))) {
      fields[key] = items;
      flat[key] = items.join(', ');
      // remove the spurious issue recorded while reading the list lines
      for (let i = issues.length - 1; i >= 0; i -= 1) {
        if (issues[i]?.message.includes(`under "${key}"`)) issues.splice(i, 1);
      }
    }
  }

  return { flat, fields, body, issues };
}

export function asString(
  value: string | string[] | Record<string, string> | undefined
): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(' ');
  return undefined;
}

export function asStringList(
  value: string | string[] | Record<string, string> | undefined
): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value;
  return [];
}
