/**
 * PEM private-key spans. A block keeps one output line per source line so a
 * `read_file` gutter (`     12\t`) does not shift the following line numbers.
 * Unclosed keys stop at the last base64 / armor line: a code fence, a blank
 * line before a non-key line, or other prose ends the span.
 */
const REDACTED = '[REDACTED]';

const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const NUMBERED_READ_LINE = /^(\s*\d+\t)(.*)$/;
/** Optional one-character diff / quote prefix: `+`, `-`, context space, or `>`. */
const PEM_HEADER_LINE = /^[ \t]*(?:[+\- >][ \t]*)?-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END_MARK = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_ARMOR_LINE = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/;
const PEM_END_LINE = /^-----END [A-Z0-9 ]*PRIVATE KEY-----$/;
const KEY_MATERIAL_LINE = /^[A-Za-z0-9+/=:-]+$/;
/** RFC 1421 encapsulation header, only valid before the first base64 line. */
const RFC1421_HEADER = /^[A-Za-z][A-Za-z0-9-]*:\s?\S.*$/;
const PEM_LINE_OPEN =
  /(?:^|\n)[ \t]*(?:\d+\t)?[ \t]*(?:[+\- >][ \t]*)?-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;

export function redactPemBlocks(text: string): string {
  return text.replace(PEM_PRIVATE_KEY, (block) => redactPemLines(block));
}

function splitReadLine(line: string): { gutter: string; body: string } {
  const numbered = NUMBERED_READ_LINE.exec(line);
  if (!numbered) return { gutter: '', body: line };
  return { gutter: numbered[1] ?? '', body: numbered[2] ?? '' };
}

/**
 * Drop one leading diff marker (`+`, `-`, space, `>`) so `+-----BEGIN` and
 * `+b3Blbn…` classify as armor and base64. Armor that already starts with
 * `-----` keeps its hyphens.
 */
function pemLineBody(body: string): string {
  let text = body.trim();
  if (!text.startsWith('-----BEGIN ') && !text.startsWith('-----END ')) {
    const mark = text[0];
    if (mark === '+' || mark === '-' || mark === '>') text = text.slice(1).trim();
  }
  return text;
}

function isCodeFenceLine(body: string): boolean {
  const trimmed = pemLineBody(body);
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

function isKeyMaterialLine(body: string): boolean {
  const trimmed = pemLineBody(body);
  if (!trimmed) return false;
  if (PEM_ARMOR_LINE.test(trimmed) || PEM_END_LINE.test(trimmed)) return true;
  return KEY_MATERIAL_LINE.test(trimmed);
}

function isRfc1421HeaderLine(body: string): boolean {
  return RFC1421_HEADER.test(pemLineBody(body));
}

function privateKeyEndLine(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && PEM_END_MARK.test(splitReadLine(line).body)) return i;
  }
  return -1;
}

/**
 * Lines of an unclosed key, starting at the BEGIN line. Before the first
 * base64 line, RFC 1421 headers (`Proc-Type: 4,ENCRYPTED`) and the blank line
 * that separates them from the body stay inside. After that, the span stops
 * before a code fence, a non-empty line that is not base64 or PEM armor, or a
 * blank line followed by either of those. A single leading diff marker is
 * ignored. Trailing blanks after the last key line stay outside the span.
 */
function unclosedKeySpanLength(lines: readonly string[], start: number): number {
  let last = start;
  let inHeader = true;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) break;
    const body = splitReadLine(line).body;
    if (pemLineBody(body) === '') {
      let next = i + 1;
      while (next < lines.length) {
        const ahead = lines[next];
        if (ahead === undefined || pemLineBody(splitReadLine(ahead).body) !== '') break;
        next += 1;
      }
      const ahead = lines[next];
      if (ahead === undefined) break;
      const nextBody = splitReadLine(ahead).body;
      if (isCodeFenceLine(nextBody)) break;
      if (inHeader && isRfc1421HeaderLine(nextBody)) continue;
      if (!isKeyMaterialLine(nextBody)) break;
      continue;
    }
    if (isCodeFenceLine(body)) break;
    if (inHeader && isRfc1421HeaderLine(body)) {
      last = i;
      continue;
    }
    if (!isKeyMaterialLine(body)) break;
    inHeader = false;
    last = i;
  }
  return last - start + 1;
}

function redactLineRange(lines: string[], start: number, count: number): void {
  const redacted = redactPemLines(lines.slice(start, start + count).join('\n')).split('\n');
  for (let j = 0; j < count; j += 1) {
    const line = redacted[j];
    if (line !== undefined) lines[start + j] = line;
  }
}

/**
 * A line-start private-key header with no matching END. `-1` when every
 * opener is closed. The index is the start of that line, gutter included.
 */
export function unclosedPrivateKeyLineStart(text: string): number {
  let holdAt = -1;
  for (const match of text.matchAll(PEM_LINE_OPEN)) {
    const at = match.index ?? 0;
    const lineStart = text[at] === '\n' ? at + 1 : at;
    if (!/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(text.slice(lineStart))) holdAt = lineStart;
  }
  return holdAt;
}

function redactPemLines(block: string): string {
  return block
    .split('\n')
    .map((line) => {
      if (line === '') return '';
      const numbered = NUMBERED_READ_LINE.exec(line);
      return `${numbered?.[1] ?? ''}${REDACTED}`;
    })
    .join('\n');
}

/**
 * Line-start `BEGIN … PRIVATE KEY` with no END, optionally prefixed by one
 * diff marker. Closed blocks are handled by {@link redactPemBlocks}.
 */
export function redactUnclosedPrivateKey(text: string): string {
  if (!text.includes('PRIVATE KEY-----')) return text;
  const lines = text.split('\n');
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line !== undefined && PEM_HEADER_LINE.test(splitReadLine(line).body)) {
      const endAt = privateKeyEndLine(lines, i + 1);
      const count = endAt === -1 ? unclosedKeySpanLength(lines, i) : endAt - i + 1;
      redactLineRange(lines, i, count);
      changed = true;
      i += count;
      continue;
    }
    i += 1;
  }
  return changed ? lines.join('\n') : text;
}

/**
 * `read_file` prefixes every line with a gutter. Redact each body on its own
 * so a multi-line match cannot swallow the next gutter. PEM blocks keep one
 * output line per source line.
 */
export function redactNumberedText(text: string, redactBody: (body: string) => string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const { gutter, body } = splitReadLine(line);
    if (PEM_HEADER_LINE.test(body)) {
      const endAt = privateKeyEndLine(lines, i + 1);
      const count = endAt === -1 ? unclosedKeySpanLength(lines, i) : endAt - i + 1;
      redactLineRange(lines, i, count);
      i += count;
      continue;
    }
    lines[i] = line === '' ? '' : `${gutter}${redactBody(body)}`;
    i += 1;
  }
  return lines.join('\n');
}
