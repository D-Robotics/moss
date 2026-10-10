/**
 * Shared redaction literals. This module imports nothing from the redactor,
 * so streaming can read the field list without a cycle through `redactEgress`.
 */

export const REDACTED = '[REDACTED]';

/**
 * Real newlines and JSON `\n` / `\r\n` escapes both separate fields. Session
 * files are redacted after JSON.stringify, so the escape form has to count.
 * `_` counts as a boundary so `SERVICE_TOKEN=` and `ssh_pass:` match.
 */
export const FIELD_BOUNDARY = String.raw`(?<=\\r\\n|\\n|^|[^A-Za-z0-9])`;

/**
 * Longer names come first so `pgpass` does not eat `pgpassword`. Bare `pass`
 * and `pwd` are not keys. `cookie` is a secret field. `authorization` /
 * `bearer` accept a scheme prefix (`Bearer`, `Basic`, `Token`, `Digest`).
 */
export const SECRET_FIELD_SOURCE =
  'pgpassword|mysql_pwd|aws_secret_access_key|aws_access_key_id|client-key-data|client_key_data|api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passphrase|password|passwd|pgpass|dbpass|credential|cookie|authorization|bearer';

/** Unfinished provider-token tail held back from a live stream. */
export const OPEN_SECRET_PREFIX = 'sk-|github_pat_|ghp_|glpat-|xox[baprs]-|AKIA|AIza|enc:';

/**
 * `Authorization: Bearer <token>` keeps the scheme and the next token together.
 * Group 1 is that token, so `<base64>` stays a placeholder. Callers that need
 * the rest of a header line extend past this token themselves.
 */
export const AUTH_SCHEME_VALUE = /^(?:Bearer|Basic|Token|Digest)[ \t]+(\S+)/i;

/**
 * Even count of the same quote on this line (escapes skipped) means `openAt`
 * starts a value. An odd count means the key itself sits inside a string
 * (`prompt='Password: '`, `"Password: " + name`) and this quote closes it.
 */
export function quoteOpensValue(text: string, openAt: number): boolean {
  const quote = text[openAt];
  if (quote !== '"' && quote !== "'") return false;
  const lineStart = text.lastIndexOf('\n', Math.max(0, openAt - 1)) + 1;
  let count = 0;
  for (let i = lineStart; i < openAt; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === quote) count += 1;
  }
  return count % 2 === 0;
}
