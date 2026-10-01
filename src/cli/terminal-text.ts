import stringWidth from 'string-width';

export const ANSI_RE = new RegExp(
  String.raw`\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))`,
  'g'
);
export const CONTROL_CHAR_RE = new RegExp(
  String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`,
  'g'
);
export const LONG_TOKEN_RE = /[^\s]{33,}/g;
// CJK (incl. fullwidth punctuation) — these wrap naturally at every character,
// so the long-token breaker must leave them alone.
export const CJK_CHAR_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
export const COPY_SENSITIVE_TOKEN_RE =
  /^(?:https?:\/\/|file:\/\/|[A-Za-z]:\\|\/|\.\/|\.\.\/|[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+|[A-Za-z0-9_-]*_[A-Za-z0-9_-]*|\[[^\]\n]{1,160}\]\((?:https?:\/\/|file:\/\/)[^)]+\))/;
export const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

export function sanitizeTextForTerminal(
  text: string,
  options: { breakLongTokens: boolean }
): string {
  const withoutAnsi = text.includes('\x1B') ? text.replace(ANSI_RE, '') : text;
  const withoutControls = CONTROL_CHAR_RE.test(withoutAnsi)
    ? withoutAnsi.replace(CONTROL_CHAR_RE, '')
    : withoutAnsi;
  const binarySafe = withoutControls
    .split('\n')
    .map((line) => {
      const replacementCount = (line.match(/\uFFFD/g) ?? []).length;
      return replacementCount >= 12 && replacementCount / Math.max(1, line.length) > 0.2
        ? '[binary data omitted]'
        : line;
    })
    .join('\n');
  const tokenSafe = options.breakLongTokens
    ? binarySafe.replace(LONG_TOKEN_RE, (token) => {
        if (COPY_SENSITIVE_TOKEN_RE.test(token)) return token;
        // Chinese/Japanese/Korean prose contains no ASCII spaces, so whole
        // sentences match LONG_TOKEN_RE — injecting spaces every 24 chars
        // mangled them mid-word ("apply_pa tch", "read_f ile"). CJK has a
        // natural wrap point at every character; only space-free ASCII blobs
        // (base64, hashes, long URLs) actually need soft breaks.
        if (CJK_CHAR_RE.test(token)) return token;
        return token.replace(/(.{24})/g, '$1 ');
      })
    : binarySafe;
  return tokenSafe
    .split('\n')
    .map((line) => (RTL_RE.test(line) ? `\u2067${line}\u2069` : line))
    .join('\n');
}

export function sanitizeRenderableText(text: string): string {
  return sanitizeTextForTerminal(text, { breakLongTokens: true });
}

export function visibleText(text: string, maxLines = Number.POSITIVE_INFINITY): string {
  const clean = sanitizeRenderableText(text).trimEnd();
  if (!Number.isFinite(maxLines)) return clean;
  const lines = clean.split('\n');
  if (lines.length <= maxLines) return clean;
  return [
    `... ${lines.length - maxLines} earlier lines hidden ...`,
    ...lines.slice(-maxLines),
  ].join('\n');
}

/**
 * Terminal cell width of `text` (CJK/emoji are 2 cells, combining marks 0).
 * Any layout math in the CLI must go through this instead of `String.length`,
 * which counts UTF-16 code units and silently mis-measures CJK by 2x.
 */
export function displayWidth(text: string): number {
  return stringWidth(text);
}

export function truncateTerminalText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (stringWidth(text) <= maxWidth) return text;
  if (maxWidth === 1) return '…';
  let out = '';
  for (const ch of Array.from(text)) {
    if (stringWidth(`${out}${ch}…`) > maxWidth) break;
    out += ch;
  }
  return `${out}…`;
}
