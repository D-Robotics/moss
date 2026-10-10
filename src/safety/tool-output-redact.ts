/**
 * One egress path for secret-like text. Reads and shell commands are not
 * blocked. Pattern redaction cannot stop xxd, od -c, hexdump, base64, rev,
 * fold, or a model that reassembles a secret character by character. The
 * main defenses are known-value exact match and the structured rules below
 * (PEM blocks, assignment values, netrc / docker / kube fields). Redaction
 * is defense in depth.
 *
 * Ordinary source keeps identifiers, calls, types, and numbers. A password
 * key (`password`, `passwd`, `passphrase`, `credential`, or a suffix segment
 * `ssh_pass` / `DB_PWD`) redacts a quoted literal. Unquoted values use the
 * shape rule: provider prefix, JWT, PEM, URL userinfo, length ≥ 8 with
 * letters and digits, or length ≥ 20. Bare `pass` / `pwd` are not keys
 * (`PWD=`, `PASS=0`, `pass: 3` stay). Fixture labels (`ALPHA-7741`) stay.
 *
 * Credential files (`.env*`, `.netrc`, `*.credentials`, key files) and reads
 * that target them set `strictSecrets`. There, every secret-named key
 * redacts any non-empty value except a syntactic placeholder or env
 * reference (`<...>`, `${VAR}`, `$VAR`, `***`, `xxx`). The same pass redacts
 * short `user:pass@` and ≥20-character high-entropy values on ordinary
 * names (`SESSION=`). Exact match of known secret values still applies.
 *
 * Moss credential files are still read. `.apikey-key` bytes are withheld
 * entirely. Property-access chains (`req.headers.authorization`), `${...}`
 * expressions, and bare letter-only identifiers are source text, not secrets.
 * Writing the `[REDACTED]` placeholder back into a file is rejected separately.
 */
import path from 'node:path';
import { knownSecretPrefixCut, redactKnownSecretValues } from './known-secrets.js';
import {
  commandMentionsMossCredential,
  isMossCredentialPath,
  resolveReadPath,
} from './read-scope.js';
import { sanitizeSecrets } from './secret-sanitizer.js';

const REDACTED = '[REDACTED]';
const REDACTED_SENTINEL = '\u0000R\u0000';

const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

const STANDALONE_SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|enc:[A-Za-z0-9+/=]{20,})\b/g;

/**
 * Real newlines and JSON `\n` / `\r\n` escapes both separate fields. Session
 * files are redacted after JSON.stringify, so the escape form has to count.
 * `_` counts as a boundary so `SERVICE_TOKEN=` and `ssh_pass:` match.
 */
const FIELD_BOUNDARY = String.raw`(?<=\\r\\n|\\n|^|[^A-Za-z0-9])`;

/**
 * Longer names come first so `pass` does not eat `password` / `passphrase`.
 * Bare `pass` and `pwd` are not keys. Only a suffix segment matches
 * (`ssh_pass`, `DB_PWD`), via the lookbehind in {@link ASSIGNED_SECRET}.
 */
const SECRET_FIELD_NAMES =
  'aws_secret_access_key|aws_access_key_id|client-key-data|client_key_data|api[_-]?key|access[_-]?key|private[_-]?key|secret|token|passphrase|password|passwd|credential|authorization|bearer';

const ASSIGNED_VALUE = '([^\\s"\',}\\\\;)]+)';
const ASSIGNED_SEP = '(["\']?[ \\t]*[:=][ \\t]*["\']?)';

/** Group 1 is a full field name. Group 2 is `pass`/`pwd` only after `_`. */
const ASSIGNED_SECRET = new RegExp(
  '(?:' +
    FIELD_BOUNDARY +
    '(' +
    SECRET_FIELD_NAMES +
    ')|(?<=_)(pwd|pass))' +
    ASSIGNED_SEP +
    ASSIGNED_VALUE,
  'gi'
);

/** Password-kind keys. `pass` / `pwd` arrive here only as suffix captures. */
const PASSWORD_FIELD = /^(?:passphrase|password|passwd|credential|pwd|pass)$/i;

/** `.netrc` uses `password <value>`, not `password=`. */
const NETRC_PASSWORD = /(^|[^\w]|\\r\\n|\\n)(password)([ \t]+)(?![=:])([^\s\\]+)/gi;

const DOCKER_AUTH = /((?:\\"|")auth(?:\\"|")\s*:\s*(?:\\"|"))([^"\\]+)((?:\\"|"))/gi;

const PLACEHOLDER =
  /^(?:process\.env(?:\.[A-Za-z0-9_]+)?|undefined|null|true|false|string|number|boolean|your[-_ ]?(?:api[-_ ]?)?key|changeme|placeholder|todo|xxx+|redacted|\[REDACTED\])$/i;

const PROPERTY_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\[[^\]]+\])?$/;
const INDEX_ACCESS = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\[[^\]]+\]$/;
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z_$]*$/;

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDER.test(value)) return true;
  if (/^[<(]/.test(value)) return true;
  if (/^[A-Za-z_][A-Za-z0-9_.]*\(/.test(value)) return true;
  return false;
}

/** Source expressions the model must be able to round-trip unchanged. */
function isSourceExpression(value: string): boolean {
  if (value.includes('${')) return true;
  if (PROPERTY_CHAIN.test(value)) return true;
  if (INDEX_ACCESS.test(value)) return true;
  return false;
}

/**
 * Letter-only identifiers are code, even when they are long
 * (`hashedPasswordValue`, `someLongIdentifierName`). A letter-only value is
 * secret-like only when it is long and high-entropy (a random password), not
 * when it is a word or a camelCase name.
 */
function alreadyRedactedQueryValue(value: string): boolean {
  const parts = value.split('&');
  if (parts[0] !== REDACTED) return false;
  return parts.every((part, index) => {
    if (index === 0) return true;
    if (/^[A-Za-z0-9_.-]+=\[REDACTED\]$/.test(part)) return true;
    const eq = part.indexOf('=');
    // `password=[REDACTED]&Zq9fK2mP7xW4vB8n` has no `=` in the second
    // fragment. That fragment is still a secret; treating it as already
    // redacted lets sanitizeSecrets turn it into `pass***8n`.
    if (eq <= 0) return false;
    // A later high-entropy secret still redacts. `page=1` does not.
    return !shouldRedactAssignedValue(part.slice(eq + 1));
  });
}

/**
 * Known provider token prefixes. The prefix alone is not a secret; at least
 * four payload characters must follow it (`sk-abcd`, `AKIA` + 4, `ghp_` + 4).
 * Real keys are longer; the floor only rejects a bare label.
 */
const CREDENTIAL_PREFIX =
  /^(?:sk-|sk_(?:live|test)_|pk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|AIza|xai-|gsk_|npm_|pypi-|dckr_pat_|vercel_|enc:)[A-Za-z0-9+/_.=-]{4,}$/;

const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/;

/** Assigned values at least this long with letters and digits are credentials. */
const MIN_MIXED_LENGTH = 8;
/** Any other non-identifier at least this long is treated as secret material. */
const MIN_OPAQUE_LENGTH = 20;
/** Ordinary `KEY=` values in a credential file. Shannon bits per character. */
const HIGH_ENTROPY_BITS = 3.5;

function hasCredentialPrefix(value: string): boolean {
  return CREDENTIAL_PREFIX.test(value);
}

function isJwtValue(value: string): boolean {
  return JWT_VALUE.test(value);
}

function isPemValue(value: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

/** `user:password@host` or `scheme://user:password@host`, including an empty user. */
function containsUrlUserinfo(value: string): boolean {
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s:@]{4,}@/i.test(value)) return true;
  return /^[^/\s:@]+:[^/\s:@]{4,}@/.test(value);
}

/** Bench fixture labels (`ALPHA-7741`). Not a credential shape. */
function isFixtureLabel(value: string): boolean {
  return /^[A-Z]+-\d+$/.test(value);
}

function shannonEntropy(value: string): number {
  if (!value) return 0;
  const freq = new Map<string, number>();
  for (const ch of value) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of freq.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * `SESSION=aB3kL9mN2pQ7rT5wX8zY` in a credential file. Paths and URLs are not
 * tokens. Letter-only words usually sit under the entropy line.
 */
function isHighEntropyToken(value: string): boolean {
  if (value.length < MIN_OPAQUE_LENGTH) return false;
  if (isPlaceholder(value) || isSourceExpression(value)) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (!/^[A-Za-z0-9+/=_.~-]{20,}$/.test(value)) return false;
  return shannonEntropy(value) >= HIGH_ENTROPY_BITS;
}

/**
 * Shape rule for token, key, secret, auth, and unquoted password values.
 *
 * - a known provider prefix (`sk-`, `ghp_`, `github_pat_`, `glpat-`, `xox*`,
 *   `AKIA`, `ASIA`, `AIza`, and the other prefixes in {@link CREDENTIAL_PREFIX})
 * - a JWT, a PEM private-key header, or URL userinfo
 * - length ≥ 8 and both letters and digits (`api_key: abc123def456`)
 * - length ≥ 20 and not a bare identifier
 *
 * Identifiers, calls, types, keywords, numbers, and `ALPHA-7741` stay.
 * Exact-match redaction of known secret values is separate.
 */
function shouldRedactAssignedValue(value: string): boolean {
  if (isPlaceholder(value)) return false;
  // A JWT matches the property-chain shape (`a.b.c`). Recognize credential
  // shapes before that exemption so the token is not left for a partial mask.
  if (
    hasCredentialPrefix(value) ||
    isJwtValue(value) ||
    isPemValue(value) ||
    containsUrlUserinfo(value)
  ) {
    return true;
  }
  if (isSourceExpression(value)) return false;
  // `credential=[REDACTED]&sig=[REDACTED]` is one assignment because `&` is
  // a legal value character. The query values are already redacted; folding
  // them again would drop the later keys. A secret before the first
  // `[REDACTED]` still redacts.
  if (alreadyRedactedQueryValue(value)) return false;
  if (value.length < MIN_MIXED_LENGTH) return false;
  if (BARE_IDENTIFIER.test(value)) return false;
  if (isFixtureLabel(value)) return false;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return value.length >= MIN_OPAQUE_LENGTH;
}

/**
 * URL userinfo and sensitive query values are credentials by position.
 * A short mixed password (`p4ssw0rdXYZ`, `sig9valueXY`) still redacts here.
 * Placeholders, source expressions, and letter-only identifiers do not.
 * Key-name assignments use {@link shouldRedactAssignedValue} instead, so a
 * fixture such as `token: ALPHA-7741` is not treated as a URL secret.
 */
function shouldRedactUrlSecret(value: string): boolean {
  if (value.length < 8) return false;
  if (isPlaceholder(value) || isSourceExpression(value)) return false;
  if (alreadyRedactedQueryValue(value)) return false;
  if (BARE_IDENTIFIER.test(value)) return false;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  if (shouldRedactAssignedValue(value)) return true;
  return value.length >= 20;
}

/**
 * Syntactic placeholders and env references. `changeme` and `your-api-key`
 * are real values on a password key and do not match.
 * The assignment regex stops at `}`, so `${DB_PASS}` is seen as `${DB_PASS`.
 */
function isSyntacticSecretPlaceholder(value: string): boolean {
  if (/^<[^>\n]*>$/.test(value)) return true;
  if (value.startsWith('${')) return true;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return true;
  if (/^(?:\*{3,}|x{3,})$/i.test(value)) return true;
  if (value === REDACTED) return true;
  return false;
}

/**
 * Credential-file rule. Any non-empty value is a secret. Syntactic
 * placeholders and env references stay. `changeme` does not.
 */
function shouldRedactPasswordValue(value: string): boolean {
  if (!value) return false;
  if (isSyntacticSecretPlaceholder(value) || isSourceExpression(value)) return false;
  if (alreadyRedactedQueryValue(value)) return false;
  return true;
}

/** Quoted password literal in ordinary source. Keywords and `${VAR}` stay. */
function shouldRedactQuotedLiteral(value: string): boolean {
  if (!value) return false;
  if (isSyntacticSecretPlaceholder(value)) return false;
  if (isPlaceholder(value) || isSourceExpression(value)) return false;
  if (alreadyRedactedQueryValue(value)) return false;
  return true;
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1));
  const from = start === -1 ? 0 : start + 1;
  const end = text.indexOf('\n', index);
  return text.slice(from, end === -1 ? text.length : end).trim();
}

/** A netrc field, not prose (`Enter your password below`). */
function isNetrcPasswordLine(line: string): boolean {
  const trimmed = line.trim();
  if (/^password\s+\S+$/i.test(trimmed)) return true;
  return /\b(?:machine|login)\s+\S+/i.test(trimmed) && /\bpassword\s+\S+/i.test(trimmed);
}

function assignedName(core: string | undefined, suffix: string | undefined): string {
  return core || suffix || '';
}

function shouldRedactAssignment(
  name: string,
  sep: string,
  value: string,
  strictFile: boolean
): boolean {
  if (strictFile) return shouldRedactPasswordValue(value);
  // A quote after `:` / `=` is a literal (`password: "sunrise"`). A suffix
  // segment (`acceptance_pass: 'Acceptance passed'`) is not a password key
  // assignment; the shape rule still applies.
  const quotedValue = /[:=][ \t]*['"]/.test(sep);
  if (PASSWORD_FIELD.test(name) && !/^(?:pwd|pass)$/i.test(name) && quotedValue) {
    return shouldRedactQuotedLiteral(value);
  }
  return shouldRedactAssignedValue(value);
}

const NUMBERED_READ_LINE = /^(\s*\d+\t)(.*)$/;
/** Optional one-character diff / quote prefix: `+`, `-`, context space, or `>`. */
const PEM_HEADER_LINE = /^[ \t]*(?:[+\- >][ \t]*)?-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_END_MARK = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const PEM_ARMOR_LINE = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/;
const PEM_END_LINE = /^-----END [A-Z0-9 ]*PRIVATE KEY-----$/;
const KEY_MATERIAL_LINE = /^[A-Za-z0-9+/=:-]+$/;
/** RFC 1421 encapsulation header, only valid before the first base64 line. */
const RFC1421_HEADER = /^[A-Za-z][A-Za-z0-9-]*:\s?\S.*$/;

/**
 * Replace a PEM block without collapsing lines. A `read_file` gutter
 * (`     12\t`) that sits on a line inside the block stays put, so later
 * line numbers do not jump.
 */
function redactPemBlocks(text: string): string {
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
    // A context-line space is already gone via trim. `+`, `-`, and `>` stay.
    if (mark === '+' || mark === '-' || mark === '>') text = text.slice(1).trim();
  }
  return text;
}

/** A markdown fence (` ``` ` or `~~~`, optional info string) cannot be key body. */
function isCodeFenceLine(body: string): boolean {
  const trimmed = pemLineBody(body);
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

/**
 * Base64 / PEM armor. Spaces between words, or any character outside
 * `[A-Za-z0-9+/=:-]`, are not key body. RFC 1421 headers are not base64;
 * they are allowed only while the header section is still open.
 */
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

const PEM_LINE_OPEN =
  /(?:^|\n)[ \t]*(?:\d+\t)?[ \t]*(?:[+\- >][ \t]*)?-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * A line-start private-key header with no matching END. `-1` when every
 * opener is closed. The index is the start of that line, gutter included.
 */
function unclosedPrivateKeyLineStart(text: string): number {
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
 * diff marker: redact from that line through the last base64 or PEM-armor
 * line. RFC 1421 headers before the first base64 line, and the blank line
 * before the body, stay inside. A code fence or other non-key line ends the
 * span; a blank line before such a line ends it too. A mention in the middle
 * of a sentence is left alone. Empty lines stay empty so the line count does
 * not change. Closed blocks are already gone.
 */
function redactUnclosedPrivateKey(text: string): string {
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
 * `read_file` prefixes every line with a gutter. Redact each line's body on
 * its own so a multi-line match cannot swallow the next gutter. A private-key
 * block keeps one output line per source line.
 */
function redactNumberedToolOutput(
  text: string,
  env: NodeJS.ProcessEnv,
  strictFile: boolean
): string {
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
    lines[i] =
      line === '' ? '' : `${gutter}${redactEgress(body, env, { strictSecrets: strictFile })}`;
    i += 1;
  }
  return lines.join('\n');
}

function redactAssignments(text: string, strictFile: boolean): string {
  return text.replace(
    ASSIGNED_SECRET,
    (full, core: string | undefined, suffix: string | undefined, sep: string, value: string) => {
      const name = assignedName(core, suffix);
      if (!name || !shouldRedactAssignment(name, sep, value, strictFile)) return full;
      return `${name}${sep}${REDACTED}`;
    }
  );
}

function redactNetrcPasswords(text: string, strictFile: boolean): string {
  return text.replace(
    NETRC_PASSWORD,
    (full, lead: string, name: string, sep: string, value: string, offset: number) => {
      const netrcLine = isNetrcPasswordLine(lineAt(text, offset));
      const redact =
        strictFile || netrcLine
          ? shouldRedactPasswordValue(value)
          : shouldRedactAssignedValue(value);
      if (!redact) return full;
      return `${lead}${name}${sep}${REDACTED}`;
    }
  );
}

function redactDockerAuth(text: string): string {
  return text.replace(DOCKER_AUTH, (full, prefix: string, value: string, suffix: string) => {
    if (!shouldRedactAssignedValue(value)) return full;
    return `${prefix}${REDACTED}${suffix}`;
  });
}

function redactStandalone(text: string): string {
  return text.replace(STANDALONE_SECRET, REDACTED);
}

/** Stop a URL secret at the next delimiter so source like `);` stays put. */
const URL_VALUE_END = '[^@&#\\s\'"`)\\]]+';

/** `scheme://user:password@host` and `scheme://:password@host` (empty username). */
const URL_USERINFO_PASSWORD = new RegExp(
  `([a-z][a-z0-9+.-]*:\\/\\/[^/\\s:@]*):(${URL_VALUE_END})@`,
  'gi'
);

/**
 * Query keys whose name ends in signature, credential, token, or sig
 * (`X-Amz-Signature`, `X-Goog-Signature`, CloudFront `Signature`).
 * Longer suffixes come first so `sig` does not eat `signature`.
 */
const SENSITIVE_QUERY = new RegExp(
  `([?&][A-Za-z0-9_.-]*(?:signature|credential|token|sig)=)(${URL_VALUE_END})`,
  'gi'
);

function redactUrlSecrets(text: string): string {
  return text
    .replace(URL_USERINFO_PASSWORD, (full, user: string, secret: string) =>
      shouldRedactUrlSecret(secret) ? `${user}:${REDACTED}@` : full
    )
    .replace(SENSITIVE_QUERY, (full, key: string, secret: string) =>
      shouldRedactUrlSecret(secret) ? `${key}${REDACTED}` : full
    );
}

/**
 * LiteLLM and similar gateways quote a fragment and a hash
 * (`Received API Key = sk-…`, `Key Hash (Token) =f00d…`).
 */
function redactGatewayKeyForms(text: string): string {
  let out = text.replace(/(\bReceived\s+API\s+Key\s*=\s*)([^\s,;]+)/gi, `$1${REDACTED}`);
  out = out.replace(/(\bKey\s+Hash(?:\s*\([^)\n]{0,40}\))?\s*=\s*)([^\s,;]+)/gi, `$1${REDACTED}`);
  out = out.replace(/\bsk-(?:[A-Za-z0-9_-]|\.{2,}){4,}/g, REDACTED);
  return out;
}

/**
 * Gateway bodies quote the key and a hash (`Received API Key = sk-…`,
 * `Key Hash (Token) = 2c58…`). `redactEgress` catches full secrets; this also
 * strips the short fragments those messages keep.
 */
export function redactGatewayText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  let out = redactEgress(text, env);
  out = out.replace(
    /((?:api[\s_-]*key|key[\s_-]*hash)(?:\s*\([^)]{0,40}\))?\s*[:=]\s*)([^\s,;]+)/gi,
    `$1${REDACTED}`
  );
  out = out.replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, REDACTED);
  return out;
}

/**
 * `sanitizeSecrets` masks quoted credential values and any `Password=<8+ chars>`
 * (the Azure connection-string rule). A password we kept on purpose — `<...>`,
 * `${VAR}`, `$VAR` — must not be rewritten. `[REDACTED]` is hidden too, so a
 * value we already replaced is not rewritten as `hunt***er`.
 */
function sanitizeWithoutTouchingPlaceholders(text: string): string {
  const spans: string[] = [];
  ASSIGNED_SECRET.lastIndex = 0;
  const shielded = text.replace(
    ASSIGNED_SECRET,
    (full, _core: string | undefined, _suffix: string | undefined, _sep: string, value: string) => {
      if (!isSyntacticSecretPlaceholder(value)) return full;
      const token = `\u0000S${spans.length}\u0000`;
      spans.push(full);
      return token;
    }
  );
  const protectedText = shielded.split(REDACTED).join(REDACTED_SENTINEL);
  const sanitized = sanitizeSecrets(protectedText).split(REDACTED_SENTINEL).join(REDACTED);
  return sanitized.replace(/\u0000S(\d+)\u0000/g, (full, index: string) => {
    const span = spans[Number(index)];
    return span ?? full;
  });
}

/**
 * Redact one string before it leaves the process: tool results, live exec
 * output, background buffers, assistant text, SDK events, evidence files,
 * and session logs.
 */
export interface RedactEgressOptions {
  /**
   * The text came from a `.env*` / credentials-like file, or a tool read that
   * targets one. Secret-named keys use the password rule. Short URL userinfo
   * and high-entropy ordinary assignments are redacted too.
   */
  strictSecrets?: boolean;
}

export function redactEgress(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  options?: RedactEgressOptions
): string {
  if (!text) return text;
  const strictFile = options?.strictSecrets === true;
  let out = redactUnclosedPrivateKey(redactPemBlocks(text));
  out = redactKnownSecretValues(out, env);
  out = redactUrlSecrets(out);
  if (strictFile) out = redactStrictCredentialShapes(out);
  out = redactAssignments(out, strictFile);
  out = redactNetrcPasswords(out, strictFile);
  out = redactDockerAuth(out);
  out = redactStandalone(out);
  out = redactGatewayKeyForms(out);
  return sanitizeWithoutTouchingPlaceholders(out);
}

/** @deprecated Use `redactEgress`. Kept so existing callers stay on the one path. */
export function redactToolOutput(text: string, env?: NodeJS.ProcessEnv): string {
  return redactEgress(text, env);
}

const CREDENTIAL_WITHHELD = 'Moss credential values withheld.\n';

/** `.env`, `.env.local`, `service.credentials`, `.netrc`, `id_ed25519`, `.pgpass`. */
export function isCredentialLikePath(filePath: string): boolean {
  const base = path.posix.basename(filePath.replace(/\\/g, '/')).toLowerCase();
  if (base === '.env' || base.startsWith('.env.') || base.startsWith('.env_')) return true;
  if (base === '.netrc' || base === '_netrc' || base === '.pgpass') return true;
  if (base === 'credentials' || base.startsWith('credentials.') || base.endsWith('.credentials')) {
    return true;
  }
  if (base.includes('credential')) return true;
  return base === 'id_rsa' || base === 'id_ed25519' || base === 'id_ecdsa' || base === 'id_dsa';
}

function pathTargetsCredentialFile(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return (
    isCredentialLikePath(normalized) ||
    normalized.split('/').some((part) => isCredentialLikePath(part))
  );
}

/**
 * A shell word that names a credential file. The bare search term
 * `credentials` (`grep -rn credentials src`) does not.
 */
function commandTokenIsCredentialFile(token: string): boolean {
  const normalized = token.replace(/\\/g, '/').replace(/[:=,]+$/, '');
  if (!normalized || normalized.startsWith('-')) return false;
  const base = normalized.split('/').pop() ?? normalized;
  if (!isCredentialLikePath(base)) return false;
  if (normalized.includes('/')) return true;
  if (base.startsWith('.') || base.includes('.')) return true;
  return base !== 'credentials';
}

function commandTargetsCredentialFile(command: string): boolean {
  return command.split(/[\s"'`;|&<>()]+/).some(commandTokenIsCredentialFile);
}

function globTargetsCredentialFile(glob: string): boolean {
  return /(^|[\\/])\.env(\b|$)|credentials|id_rsa|id_ed25519|id_ecdsa|id_dsa|\.netrc|\.pgpass/.test(
    glob
  );
}

/** True when this tool result is the contents of a credential-like file. */
export function targetsCredentialFile(toolName: string, input: Record<string, unknown>): boolean {
  const target = typeof input.path === 'string' ? input.path : '';
  const glob = typeof input.glob === 'string' ? input.glob : '';
  if (toolName === 'read_file' || toolName === 'search_code') {
    if (pathTargetsCredentialFile(target)) return true;
    return glob !== '' && globTargetsCredentialFile(glob);
  }
  if (toolName === 'exec' || toolName === 'exec_background') {
    const command = typeof input.command === 'string' ? input.command : '';
    return command !== '' && commandTargetsCredentialFile(command);
  }
  return false;
}

/** Short `user:pass@` and high-entropy `KEY=` values. Credential files only. */
const LOOSE_USERINFO = /([^\s:='"]{1,128}):([^\s:@'"]+)@/g;
const PLAIN_ASSIGNMENT = /(\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*['"]?)([^\s#'"]+)/g;

function redactStrictCredentialShapes(text: string): string {
  const withUserinfo = text.replace(LOOSE_USERINFO, (full, user: string, secret: string) => {
    if (!secret || secret === REDACTED || isSyntacticSecretPlaceholder(secret)) return full;
    if (isPlaceholder(secret)) return full;
    return `${user}:${REDACTED}@`;
  });
  return withUserinfo.replace(PLAIN_ASSIGNMENT, (full, prefix: string, value: string) => {
    if (value.includes(REDACTED)) return full;
    return isHighEntropyToken(value) ? `${prefix}${REDACTED}` : full;
  });
}

/**
 * Tool result the model is allowed to see. Ordinary secrets are redacted.
 * Moss's own key file is replaced entirely so raw key bytes never appear.
 */
export function presentToolOutput(args: {
  toolName: string;
  input: Record<string, unknown>;
  text: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = args.env ?? process.env;
  const workspaceDir = args.workspaceDir || process.cwd();
  if (args.toolName === 'read_file') {
    const resolved = resolveReadPath(String(args.input.path ?? ''), workspaceDir, env);
    if (isMossCredentialPath(resolved, env) && path.basename(resolved) === '.apikey-key') {
      return CREDENTIAL_WITHHELD;
    }
  }
  const command =
    args.toolName === 'exec' || args.toolName === 'exec_background'
      ? String(args.input.command ?? '')
      : '';
  if (command && commandMentionsMossCredential(command) && /\.apikey-key\b/.test(command)) {
    return CREDENTIAL_WITHHELD;
  }
  const strictSecrets = targetsCredentialFile(args.toolName, args.input);
  if (args.toolName === 'read_file') return redactNumberedToolOutput(args.text, env, strictSecrets);
  return redactEgress(args.text, env, { strictSecrets });
}

/**
 * Text safe to paint while a stream is still open: every finished line, and
 * nothing from the current partial line or an unclosed line-start PEM block.
 * `flush` emits the tail; the unclosed key is then redacted only through the
 * last key-body line. While the stream is open, that span stays held.
 */
export function visibleStreamPrefix(raw: string, flush: boolean): string {
  if (flush) return raw;
  const holdAt = unclosedPrivateKeyLineStart(raw);
  if (holdAt !== -1) return raw.slice(0, holdAt);
  if (raw.endsWith('\n')) return raw;
  const nl = raw.lastIndexOf('\n');
  return nl === -1 ? '' : raw.slice(0, nl + 1);
}

const OPEN_ASSIGNMENT = new RegExp(
  `((?:${SECRET_FIELD_NAMES})|(?<=_)(?:pwd|pass))(["']?\\s*[:=]\\s*["']?)(\\S*)$`,
  'i'
);

const OPEN_STANDALONE =
  /(?:sk-|github_pat_|ghp_|glpat-|xox[baprs]-|AKIA|AIza|enc:)[A-Za-z0-9_+/=-]*$/;

/**
 * Paint an unfinished line except a secret that is still growing. A finished
 * value is already `[REDACTED]`. Ordinary prose, including a token stream with
 * no secret shape, is returned as-is so the live tail stays responsive.
 */
export function holdOpenSecretSuffix(line: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!line) return '';
  if (
    /^[ \t]*(?:[+\- >][ \t]*)?-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line) &&
    !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)
  ) {
    return '';
  }
  const redacted = redactEgress(line, env);
  let cut = knownSecretPrefixCut(redacted, env);
  const assign = OPEN_ASSIGNMENT.exec(redacted);
  if (assign && assign[3] !== '[REDACTED]') {
    const start = assign.index;
    const bounded = start === 0 || !/[A-Za-z0-9_]/.test(redacted.charAt(start - 1));
    if (bounded) cut = Math.min(cut, start);
  }
  const standalone = OPEN_STANDALONE.exec(redacted);
  if (standalone) cut = Math.min(cut, standalone.index);
  return redacted.slice(0, cut);
}

/**
 * Hold a trailing partial line (and an open PEM block) so a secret split
 * across chunks is redacted once the line is complete. `push` returns only
 * the newly safe suffix. `flush` emits the remainder. `reset` drops a held
 * tail without emitting it.
 */
export function createStreamingTextRedactor(): {
  push(chunk: string): string;
  flush(): string;
  reset(): void;
} {
  let raw = '';
  let emitted = '';
  const publish = (flush: boolean): string => {
    const redacted = redactEgress(visibleStreamPrefix(raw, flush));
    if (!redacted.startsWith(emitted)) return '';
    const more = redacted.slice(emitted.length);
    emitted = redacted;
    return more;
  };
  return {
    push(chunk: string) {
      if (!chunk) return '';
      raw += chunk;
      return publish(false);
    },
    flush() {
      const more = publish(true);
      raw = '';
      emitted = '';
      return more;
    },
    reset() {
      raw = '';
      emitted = '';
    },
  };
}

export function createRedactingChunkWriter(onChunk: ((text: string) => void) | undefined): {
  write(chunk: string): void;
  flush(): void;
} | null {
  if (!onChunk) return null;
  const redactor = createStreamingTextRedactor();
  return {
    write(chunk: string) {
      const more = redactor.push(chunk);
      if (more) onChunk(more);
    },
    flush() {
      const more = redactor.flush();
      if (more) onChunk(more);
    },
  };
}

export function placeholderCount(text: string): number {
  if (!text) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(REDACTED, from);
    if (at === -1) return count;
    count += 1;
    from = at + REDACTED.length;
  }
  return count;
}

const REDACTED_WRITE_MORE =
  'refusing to write [REDACTED] into a file that would then contain more of that placeholder than it already does. ' +
  'Edit the real text from read_file; do not write the redacted form back.';

/**
 * Reject file content whose `[REDACTED]` count is higher than the bytes
 * already on disk. A file that already mentions the placeholder can still
 * be rewritten, but not with additional placeholders.
 */
export function redactedPlaceholderWriteError(
  original: string | null,
  next: string
): string | null {
  const before = original === null ? 0 : placeholderCount(original);
  if (placeholderCount(next) <= before) return null;
  return REDACTED_WRITE_MORE;
}

/** edit_file / multi_edit: compare the replacement text with the matched text. */
export function redactedPlaceholderEditError(oldString: string, newString: string): string | null {
  return redactedPlaceholderWriteError(oldString, newString);
}

/** apply_patch: compare placeholders on added lines with those on removed lines. */
export function redactedPlaceholderPatchLineError(
  lines: readonly { op: string; text: string }[]
): string | null {
  let removed = 0;
  let added = 0;
  for (const line of lines) {
    if (line.op === '-') removed += placeholderCount(line.text);
    else if (line.op === '+') added += placeholderCount(line.text);
  }
  if (added <= removed) return null;
  return REDACTED_WRITE_MORE;
}
