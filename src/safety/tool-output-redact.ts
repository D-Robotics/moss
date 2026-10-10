/**
 * One egress path for secret-like text. Ordinary source keeps identifiers,
 * calls, types, and numbers. A password key redacts a quoted literal — the
 * whole span, including spaces and escapes. Unquoted values use the shape
 * rule (provider prefix, JWT, PEM, URL userinfo, length ≥ 8 with letters and
 * digits, or length ≥ 20). Bare `pass` / `pwd` are not keys. `ALPHA-7741` stays.
 *
 * `strictSecrets` is set for credential file names (`.env*`, `.netrc`,
 * `*.credentials`, key files), not for source/doc extensions or parent
 * directories. There, secret-named keys — including `PGPASSWORD`, `PGPASS`,
 * `DBPASS`, `MYSQL_PWD` — redact any non-empty value except `<...>`,
 * `${VAR}`, `$VAR`, `***`, `xxx`. Short `user:pass@` and ≥20-character
 * high-entropy values are redacted too. Grep / search hits are judged from
 * the `path:line:` prefix. A netrc password needs `machine` or `login` on
 * the same line. A quoted value stays on one line; an unclosed quote masks
 * through the end of that line, and up to three continuation lines are masked
 * when they hold the closer. Indent is measured after a line-number gutter.
 * Strict credential text also folds an unindented continuation. `.apikey-key` bytes are
 * withheld before that decision. `Authorization` and `cookie` headers mask
 * through the end of the line (`Bearer`, `Basic`, `Token`, `Digest`,
 * `Proxy-Authorization`, `Set-Cookie`). Command argv masks sshpass `-p`
 * (attached or spaced, including a prefix glued onto the command),
 * mysql/mariadb attached `-p`, curl/wget userinfo (a short cluster ending in
 * `-u`), `docker` / `podman login -p`, `--http-password`, and `--password` / `--passwd` /
 * `--pass`. A function word after a flag stays. Port flags stay. Nested quotes
 * and escapes stay.
 */
import {
  CREDENTIAL_WITHHELD,
  credentialGrepHit,
  isRawApiKeyFile,
  scrubRawApiKeyLines,
  targetsCredentialFile,
} from './credential-path.js';
import { redactConfigSecretFieldsInView, redactKnownSecretValues } from './known-secrets.js';
import { bindRedactEgress } from './redact-bind.js';
import {
  ATTACHED_P_PASSWORD,
  ATTACHED_USER_FLAG,
  AUTH_SCHEME_VALUE,
  commandTokenName,
  FIELD_BOUNDARY,
  PASSWORD_LONG_EQUALS,
  PASSWORD_LONG_FLAG,
  quoteOpensValue,
  REDACTED,
  SECRET_FIELD_SOURCE,
  USER_EQUALS_FLAG,
  USER_FLAG,
} from './redact-patterns.js';
import { redactNumberedText, redactPemBlocks, redactUnclosedPrivateKey } from './redact-pem.js';
import { resolveReadPath } from './read-scope.js';
import { maskIndentedQuoteContinuations, sanitizeSecrets } from './secret-sanitizer.js';

export { isCredentialLikePath, targetsCredentialFile } from './credential-path.js';
export { OPEN_SECRET_PREFIX, REDACTED, SECRET_FIELD_SOURCE } from './redact-patterns.js';

const REDACTED_SENTINEL = '\u0000R\u0000';

const SK_FRAGMENT = String.raw`sk-(?:[A-Za-z0-9_-]|\.{2,}){4,}`;

const STANDALONE_SECRET = new RegExp(
  String.raw`\b(?:github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|enc:[A-Za-z0-9+/=]{20,})\b`,
  'g'
);

const ASSIGNED_HEAD = new RegExp(
  '(?:' +
    FIELD_BOUNDARY +
    '(' +
    SECRET_FIELD_SOURCE +
    ')|(?<=_)(pwd|pass))' +
    '(["\']?[ \\t]*[:=])',
  'gi'
);

/** Password-kind keys. `pass` / `pwd` arrive here only as suffix captures. */
const PASSWORD_FIELD =
  /^(?:passphrase|password|passwd|credential|pwd|pass|pgpassword|pgpass|dbpass|mysql_pwd|sshpass)$/i;

/** `.netrc` uses `password <value>`, not `password=`. */
const NETRC_PASSWORD = /(^|[^\w]|\\r\\n|\\n)(password)([ \t]+)(?![=:])([^\s\\]+)/gi;

/** Type names and operators are not netrc secrets (`Password string`, `password !=`). */
const NETRC_TYPE_NAME =
  /^(?:string|str|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|byte|rune|bool|boolean|float|float32|float64|double|char|void|any|object|number|\[\]byte|\[\]string)$/i;

const DOCKER_AUTH = /((?:\\"|")auth(?:\\"|")\s*:\s*(?:\\"|"))([^"\\]+)((?:\\"|"))/gi;

const PLACEHOLDER =
  /^(?:process\.env(?:\.[A-Za-z0-9_]+)?|undefined|null|true|false|string|number|boolean|your[-_ ]?(?:api[-_ ]?)?key|changeme|placeholder|todo|xxx+|redacted|\[REDACTED\])$/i;

const PROPERTY_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\[[^\]]+\])?$/;
const INDEX_ACCESS = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\[[^\]]+\]$/;
const BARE_IDENTIFIER = /^[A-Za-z_$][A-Za-z_$]*$/;
const BARE_VALUE = /^[^\s"',}\\;)]+/;

/** `.pgpass` is `host:port:db:user:password`. Strict mode only. */
const PGPASS_LINE = /^([^:\s]+):(\d+):([^:\s]*):([^:\s]+):([^:\s]+)$/;

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

function alreadyRedactedQueryValue(value: string): boolean {
  const parts = value.split('&');
  if (parts[0] !== REDACTED) return false;
  return parts.every((part, index) => {
    if (index === 0) return true;
    if (/^[A-Za-z0-9_.-]+=\[REDACTED\]$/.test(part)) return true;
    const eq = part.indexOf('=');
    if (eq <= 0) return false;
    return !shouldRedactAssignedValue(part.slice(eq + 1));
  });
}

/**
 * Known provider token prefixes. At least four payload characters must follow
 * (`sk-abcd`, `AKIA` + 4, `ghp_` + 4). Real keys are longer.
 */
const CREDENTIAL_PREFIX =
  /^(?:sk-|sk_(?:live|test)_|pk_(?:live|test)_|rk_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AKIA|ASIA|AIza|xai-|gsk_|npm_|pypi-|dckr_pat_|vercel_|enc:)[A-Za-z0-9+/_.=-]{4,}$/;

const JWT_VALUE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/;

const MIN_MIXED_LENGTH = 8;
const MIN_OPAQUE_LENGTH = 20;
const HIGH_ENTROPY_BITS = 3.5;
const PEM_VALUE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const FIXTURE_LABEL = /^[A-Z]+-\d+$/;

/** `user:password@host` or `scheme://user:password@host`, including an empty user. */
function containsUrlUserinfo(value: string): boolean {
  if (/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s:@]{4,}@/i.test(value)) return true;
  return /^[^/\s:@]+:[^/\s:@]{4,}@/.test(value);
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

function isHighEntropyToken(value: string): boolean {
  if (value.length < MIN_OPAQUE_LENGTH) return false;
  if (isPlaceholder(value) || isSourceExpression(value)) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (!/^[A-Za-z0-9+/=_.~-]{20,}$/.test(value)) return false;
  return shannonEntropy(value) >= HIGH_ENTROPY_BITS;
}

/**
 * Shape rule for token, key, secret, auth, URL userinfo, and unquoted
 * password values. Identifiers, calls, types, keywords, numbers, and
 * `ALPHA-7741` stay. Exact-match redaction of known secret values is separate.
 */
function shouldRedactAssignedValue(value: string): boolean {
  const payload = AUTH_SCHEME_VALUE.exec(value)?.[1];
  if (payload && (isPlaceholder(payload) || isSyntacticSecretPlaceholder(payload))) return false;
  if (isPlaceholder(value)) return false;
  if (
    CREDENTIAL_PREFIX.test(value) ||
    JWT_VALUE.test(value) ||
    PEM_VALUE.test(value) ||
    containsUrlUserinfo(value)
  ) {
    return true;
  }
  if (isSourceExpression(value)) return false;
  if (alreadyRedactedQueryValue(value)) return false;
  if (value.length < MIN_MIXED_LENGTH) return false;
  if (BARE_IDENTIFIER.test(value)) return false;
  if (FIXTURE_LABEL.test(value)) return false;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return value.length >= MIN_OPAQUE_LENGTH;
}

/**
 * Syntactic placeholders and env references. `changeme` is a real value.
 * The unquoted scanner stops at `}`, so `${DB_PASS}` is seen as `${DB_PASS`.
 */
function isSyntacticSecretPlaceholder(value: string): boolean {
  if (!value) return false;
  if (/^<[^>\n]*>$/.test(value)) return true;
  if (value.startsWith('${') || value.startsWith('$')) {
    if (value.startsWith('${')) return true;
    if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return true;
  }
  if (/^(?:\*{3,}|x{3,})$/i.test(value)) return true;
  if (value === REDACTED) return true;
  return false;
}

/** Credential-file rule. Any non-empty value except a syntactic placeholder. */
function shouldRedactPasswordValue(value: string): boolean {
  if (!value) return false;
  if (isSyntacticSecretPlaceholder(value) || isSourceExpression(value)) return false;
  if (alreadyRedactedQueryValue(value)) return false;
  return true;
}

/** Quoted password literal. Keywords, types, and `${VAR}` stay. */
function shouldRedactQuotedLiteral(value: string): boolean {
  if (!shouldRedactPasswordValue(value)) return false;
  return !isPlaceholder(value);
}

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', Math.max(0, index - 1));
  const from = start === -1 ? 0 : start + 1;
  const end = text.indexOf('\n', index);
  return text.slice(from, end === -1 ? text.length : end).trim();
}

function isNetrcSecretValue(value: string): boolean {
  const word = value.replace(/[,;]+$/, '');
  if (!word) return false;
  if (/^(?:!=|!==|==|<=|>=)$/.test(word) || word.startsWith('!=')) return false;
  if (NETRC_TYPE_NAME.test(word)) return false;
  if (isPlaceholder(word) || isSourceExpression(word)) return false;
  return true;
}

/**
 * A netrc field, not a type or a sentence. `machine` / `login` must sit on
 * the same line. Real `.netrc` files are already strict by path.
 */
function isNetrcPasswordLine(line: string): boolean {
  if (!/\b(?:machine|login)[ \t]+\S+/i.test(line)) return false;
  const password = /\bpassword[ \t]+(?![=:])(\S+)/i.exec(line);
  const value = password?.[1];
  if (!value) return false;
  return isNetrcSecretValue(value);
}

function assignedName(core: string | undefined, suffix: string | undefined): string {
  return core || suffix || '';
}

interface AssignedSpan {
  end: number;
  value: string;
  sepExtra: string;
  quoted: boolean;
}

/** Index of the line break after `index`, or the end of the text. The break stays outside. */
function lineEndFrom(text: string, index: number): number {
  const nl = text.indexOf('\n', index);
  const end = nl === -1 ? text.length : nl;
  return end > index && text[end - 1] === '\r' ? end - 1 : end;
}

/**
 * Opening quote through the matching closer on the same line. A newline ends
 * the scan (`null`) so an unclosed quote cannot swallow the next lines.
 * Escapes (`\"`, `\\`) stay inside.
 */
function scanQuoted(text: string, openAt: number): { end: number; inner: string } | null {
  const quote = text[openAt];
  if ((quote !== '"' && quote !== "'") || !quoteOpensValue(text, openAt)) return null;
  let inner = '';
  for (let i = openAt + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n' || ch === '\r') return null;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined || next === '\n' || next === '\r') return null;
      inner += next;
      i += 1;
      continue;
    }
    if (ch === quote) return { end: i + 1, inner };
    inner += ch;
  }
  return null;
}

function isAuthField(name: string): boolean {
  return /^(?:authorization|bearer|cookie)$/i.test(name);
}

/** Shell and template expressions are code, not a header secret. */
function headerLooksLikeCode(value: string): boolean {
  if (value.includes('${') || value.includes('$(')) return true;
  return isSourceExpression(value) || isPlaceholder(value);
}

/**
 * The secret name is the header itself (`Authorization:`, `Set-Cookie:`,
 * `Proxy-Authorization:`), not a mention later in a sentence.
 */
function authHeaderAtLineStart(text: string, valueAt: number): boolean {
  const lineStart = text.lastIndexOf('\n', Math.max(0, valueAt - 1)) + 1;
  const prefix = text.slice(lineStart, valueAt);
  return (
    /^\s*(?:set-|proxy-)?$/i.test(prefix) ||
    /^\s*(?:set-|proxy-)?(?:authorization|bearer|cookie)[ \t]*[:=][ \t]*$/i.test(prefix)
  );
}

/** A real Authorization / Cookie header: mask through the end of the line. */
function headerLooksLikeSecret(value: string): boolean {
  if (!value || headerLooksLikeCode(value)) return false;
  return shouldRedactAssignedValue(value);
}

function readAssignedValue(text: string, at: number, name: string): AssignedSpan | null {
  let i = at;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  const ws = text.slice(at, i);
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    if (!quoteOpensValue(text, i)) return null;
    const quoted = scanQuoted(text, i);
    if (quoted) return { end: quoted.end, value: quoted.inner, sepExtra: ws, quoted: true };
    const end = lineEndFrom(text, i + 1);
    const value = text.slice(i + 1, end);
    if (!value) return null;
    return { end, value, sepExtra: ws, quoted: true };
  }
  if (isAuthField(name)) {
    const end = lineEndFrom(text, i);
    const header = text.slice(i, end);
    if (header && authHeaderAtLineStart(text, i) && headerLooksLikeSecret(header)) {
      return { end, value: header, sepExtra: ws, quoted: false };
    }
    const scheme = AUTH_SCHEME_VALUE.exec(header);
    if (scheme?.[0] && !headerLooksLikeCode(scheme[0])) {
      return { end: i + scheme[0].length, value: scheme[0], sepExtra: ws, quoted: false };
    }
  }
  const bare = BARE_VALUE.exec(text.slice(i));
  if (!bare?.[0]) return null;
  return { end: i + bare[0].length, value: bare[0], sepExtra: ws, quoted: false };
}

interface AssignmentHit {
  start: number;
  end: number;
  name: string;
  sep: string;
  value: string;
  quoted: boolean;
}

function forEachAssignment(
  text: string,
  visit: (hit: AssignmentHit) => string | undefined
): string {
  let out = '';
  let last = 0;
  ASSIGNED_HEAD.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNED_HEAD)) {
    const index = match.index ?? 0;
    if (index < last) continue;
    const sep = match[3] ?? '';
    const name = assignedName(match[1], match[2]);
    const span = readAssignedValue(text, index + match[0].length, name);
    if (!span || !name) continue;
    const replacement = visit({
      start: index,
      end: span.end,
      name,
      sep: sep + span.sepExtra,
      value: span.value,
      quoted: span.quoted,
    });
    if (replacement === undefined) continue;
    out += text.slice(last, index);
    out += replacement;
    last = span.end;
  }
  out += text.slice(last);
  return out;
}

/**
 * `SSHPASS`, `MYSQL_PWD`, and `PGPASSWORD` are passwords even when the value is
 * one character.
 */
function isPasswordEnvName(name: string): boolean {
  return /^(?:sshpass|mysql_pwd|pgpassword)$/i.test(name);
}

/** `$(cmd)`, `${VAR}`, `$VAR`, or a backtick command: the shell fetches the value. */
const SHELL_LOOKUP = /^(?:\$[({A-Za-z_]|`)/;

/**
 * `${NAME:-}`, `${NAME:?message}`, `${NAME:-$OTHER}`: a shell parameter
 * expansion reads the variable. The word after the operator is empty, an error
 * message, or another lookup, not a stored secret. A literal default
 * (`${NAME:-hunter2}`) still counts.
 */
function isParameterExpansionLookup(text: string, hit: AssignmentHit): boolean {
  if (hit.sep !== ':') return false;
  let at = hit.start;
  while (at > 0 && /[A-Za-z0-9_]/.test(text[at - 1] ?? '')) at -= 1;
  if (text.slice(at - 2, at) !== '${') return false;
  const op = hit.value[0] ?? '';
  if (op === '?') return true;
  if (!/^[-+=]?$/.test(op)) return false;
  const word = hit.value.slice(1);
  return !word || SHELL_LOOKUP.test(word);
}

/** Commands that read `SSHPASS`, `MYSQL_PWD`, or `PGPASSWORD` from the environment. */
const PASSWORD_ENV_COMMAND =
  /^(?:sshpass|mysql|mysqldump|mariadb|mariadb-dump|psql|pg_dump|pg_restore|pg_dumpall|ssh|scp|rsync|env|exec)$/;

function shouldRedactAssignment(hit: AssignmentHit, strictFile: boolean): boolean {
  // `export SSHPASS="$(security …)"` and `SSHPASS=`cat f`` fetch the password.
  // MYSQL_PWD / PGPASSWORD keep the general password-field rule below, so a
  // lookup is still masked as a whole (`[REDACTED]`) instead of falling through
  // to the partial `***` sanitizer, which the write guard does not recognise.
  const lookup = isPasswordEnvName(hit.name) && SHELL_LOOKUP.test(hit.value);
  if (lookup && /^sshpass$/i.test(hit.name)) return false;
  // `SSHPASS= sshpass -e ssh h` clears the variable; the next word is the command.
  if (
    isPasswordEnvName(hit.name) &&
    /^=[ \t]/.test(hit.sep) &&
    PASSWORD_ENV_COMMAND.test(hit.value)
  ) {
    return false;
  }
  if (strictFile) return shouldRedactPasswordValue(hit.value);
  // Short values count only in a plain shell assignment: not a `${NAME:-…}` default,
  // an empty value before a command, a spaced code assignment, or a `$(…)` lookup.
  if (!lookup && isPasswordEnvName(hit.name) && /^=["']?$/.test(hit.sep)) {
    if (isPlaceholder(hit.value) || isSourceExpression(hit.value)) return false;
    return shouldRedactPasswordValue(hit.value);
  }
  const quotedValue = hit.quoted || /[:=][ \t]*['"]/.test(hit.sep);
  if (PASSWORD_FIELD.test(hit.name) && !/^(?:pwd|pass)$/i.test(hit.name) && quotedValue) {
    return shouldRedactQuotedLiteral(hit.value);
  }
  return shouldRedactAssignedValue(hit.value);
}

function redactNumberedToolOutput(
  text: string,
  env: NodeJS.ProcessEnv,
  strictFile: boolean
): string {
  const continued = maskIndentedQuoteContinuations(text, { strict: strictFile });
  return redactNumberedText(continued, (body) =>
    redactEgress(body, env, { strictSecrets: strictFile })
  );
}

interface ArgvWord {
  start: number;
  end: number;
  value: string;
  /** Source index of each character in `value` (quotes and escapes are skipped). */
  valueMap: number[];
  /** The text `valueMap` points into. */
  source: string;
}

interface ArgvSep {
  sep: true;
}

type ArgvToken = ArgvWord | ArgvSep;

interface ArgvReplacement {
  start: number;
  end: number;
  text: string;
}

function isArgvWord(token: ArgvToken): token is ArgvWord {
  return !('sep' in token);
}

/** A closer on this line. Single quotes are literal; the others honor escapes. */
function quoteCloser(line: string, openAt: number): number {
  const quote = line[openAt];
  if (quote !== '"' && quote !== "'" && quote !== '`') return -1;
  for (let i = openAt + 1; i < line.length; i += 1) {
    if (line[i] === '\\' && quote !== "'") {
      i += 1;
      continue;
    }
    if (line[i] === quote) return i;
  }
  return -1;
}

/**
 * One shell line, or one echoed argv list. Commas separate words only inside
 * brackets, so a quoted list splits and an unquoted comma stays in the word.
 */
function tokenizeArgv(line: string): ArgvToken[] {
  const tokens: ArgvToken[] = [];
  let i = 0;
  let brackets = 0;
  while (i < line.length) {
    const ch = line[i] ?? '';
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '[') {
      brackets += 1;
      i += 1;
      continue;
    }
    if (ch === ']') {
      brackets = Math.max(0, brackets - 1);
      i += 1;
      continue;
    }
    if (ch === ',' && brackets > 0) {
      i += 1;
      continue;
    }
    if (ch === '&' && line[i + 1] === '&') {
      tokens.push({ sep: true });
      i += 2;
      continue;
    }
    if (ch === '|' && line[i + 1] === '|') {
      tokens.push({ sep: true });
      i += 2;
      continue;
    }
    if (ch === '|' || ch === ';' || ch === '&') {
      tokens.push({ sep: true });
      i += 1;
      continue;
    }
    const start = i;
    let value = '';
    const valueMap: number[] = [];
    let quote: '"' | "'" | '`' | null = null;
    while (i < line.length) {
      const c = line[i] ?? '';
      if (quote) {
        if (c === '\\' && quote !== "'" && i + 1 < line.length) {
          const next = line[i + 1] ?? '';
          if (next === quote || next === '\\') {
            value += next;
            valueMap.push(i + 1);
            i += 2;
            continue;
          }
        }
        if (c === quote) {
          quote = null;
          i += 1;
          continue;
        }
        value += c;
        valueMap.push(i);
        i += 1;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '|' || c === ';' || c === '&') break;
      if (c === ',' && brackets > 0) break;
      if (c === '[' || c === ']') break;
      const opensQuote =
        (c === '"' || c === "'" || c === '`') &&
        (i === start || line[i - 1] === '=') &&
        quoteCloser(line, i) >= 0;
      if (opensQuote) {
        quote = c;
        i += 1;
        continue;
      }
      value += c;
      valueMap.push(i);
      i += 1;
    }
    if (value) tokens.push({ start, end: i, value, valueMap, source: line });
  }
  return tokens;
}

function argvSegments(tokens: readonly ArgvToken[]): ArgvWord[][] {
  const segments: ArgvWord[][] = [];
  let current: ArgvWord[] = [];
  for (const token of tokens) {
    if (!isArgvWord(token)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function shouldMaskArg(value: string): boolean {
  if (!value || value.includes(REDACTED)) return false;
  // A list tokenizer splits `[REDACTED]` at the brackets; masking the word again
  // would grow `[[REDACTED]]` on every pass.
  if (value === REDACTED.slice(1, -1)) return false;
  // A flag separator (`--password` /) is not a secret. Real values have a letter or digit.
  if (!/[A-Za-z0-9]/.test(value)) return false;
  return !isSyntacticSecretPlaceholder(value);
}

/**
 * Last value index whose source bytes are contiguous with `from`, allowing an
 * in-string escape (`\\"`). A closing quote ends the run, so the bytes after it
 * (`\\"",` or `"}`) stay as written.
 */
function contiguousValueEnd(token: ArgvWord, from: number, to: number): number {
  let k = from;
  while (k < to) {
    const a = token.valueMap[k];
    const b = token.valueMap[k + 1];
    if (a === undefined || b === undefined) break;
    if (b === a + 1 || (b === a + 2 && token.source[a + 1] === '\\')) {
      k += 1;
      continue;
    }
    break;
  }
  return k;
}

function pushValueSlice(
  token: ArgvWord,
  valueIndex: number,
  length: number,
  replacements: ArgvReplacement[]
): void {
  let slice = token.value.slice(valueIndex, valueIndex + length);
  // An escaped quote (`\"admin:pw\"` in JSON or a nested shell string) is a
  // delimiter, not part of the password: keep it and everything after it.
  const lead = /^(?:\\+["'`])+/.exec(slice)?.[0] ?? '';
  if (lead) {
    valueIndex += lead.length;
    length -= lead.length;
    slice = slice.slice(lead.length);
  }
  const escapedQuote = slice.search(/\\+["'`](?![A-Za-z0-9])/);
  if (escapedQuote >= 0) {
    length = escapedQuote;
    slice = slice.slice(0, escapedQuote);
  }
  const trailing = /["'`)\]}]+$/.exec(slice)?.[0] ?? '';
  if (trailing && !/["'`(\[{]/.test(slice.slice(0, slice.length - trailing.length))) {
    length -= trailing.length;
  }
  if (length <= 0) return;
  // Judge a placeholder (`<PASSWORD>`) after the closing quote and brace are trimmed.
  if (isSyntacticSecretPlaceholder(token.value.slice(valueIndex, valueIndex + length))) return;
  const start = token.valueMap[valueIndex];
  const end = token.valueMap[contiguousValueEnd(token, valueIndex, valueIndex + length - 1)];
  if (start === undefined || end === undefined) return;
  replacements.push({ start, end: end + 1, text: REDACTED });
}

function maskColonPassword(
  token: ArgvWord,
  userinfo: string,
  replacements: ArgvReplacement[]
): void {
  const colon = userinfo.indexOf(':');
  if (colon < 0) return;
  const secret = userinfo.slice(colon + 1);
  if (!shouldMaskArg(secret)) return;
  const at = token.value.length - userinfo.length + colon + 1;
  pushValueSlice(token, at, secret.length, replacements);
}

/**
 * Closed-class words after a flag in a sentence (`Use --password to set it.`).
 * `sunrise` and `hunter2` are not in this set.
 */
const PROSE_FLAG_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'for',
  'of',
  'in',
  'on',
  'and',
  'or',
  'if',
  'is',
  'be',
  'as',
  'at',
  'by',
  'with',
  'from',
  'this',
  'that',
  'it',
  'its',
  'your',
  'you',
  'into',
  'via',
  'when',
  'then',
  'than',
  'not',
  'do',
  'can',
  'will',
  'just',
  'only',
  'also',
  'flag',
  'option',
]);

function isProseFlagValue(value: string): boolean {
  return PROSE_FLAG_WORDS.has(value.toLowerCase());
}

/** Long password flags on any command, with an equals sign or a following word. */
function redactLongPasswordFlags(
  segments: readonly ArgvWord[][],
  replacements: ArgvReplacement[]
): void {
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i += 1) {
      const word = segment[i];
      if (!word) continue;
      const equals = PASSWORD_LONG_EQUALS.exec(word.value);
      if (equals) {
        const secret = equals[1] ?? '';
        if (shouldMaskArg(secret)) {
          pushValueSlice(word, word.value.length - secret.length, secret.length, replacements);
        }
        continue;
      }
      if (!PASSWORD_LONG_FLAG.test(word.value)) continue;
      const next = segment[i + 1];
      if (!next || next.value.startsWith('-') || !shouldMaskArg(next.value)) continue;
      if (isProseFlagValue(next.value)) continue;
      pushValueSlice(next, 0, next.value.length, replacements);
    }
  }
}

/**
 * sshpass takes the short password attached or as the next word. Scanning stops
 * at the child command, so a later port flag stays.
 */
function redactSshpassArgv(segments: readonly ArgvWord[][], replacements: ArgvReplacement[]): void {
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i += 1) {
      const name = segment[i] ? commandTokenName(segment[i].value) : '';
      if (name !== 'sshpass') continue;
      for (let j = i + 1; j < segment.length; j += 1) {
        const arg = segment[j];
        if (!arg) break;
        if (arg.value === '-e' || arg.value === '-v') continue;
        if (arg.value === '-f' || arg.value === '-d' || arg.value === '-P') {
          j += 1;
          continue;
        }
        if (/^-[fdP].+$/.test(arg.value)) continue;
        if (arg.value === '-p') {
          const next = segment[j + 1];
          if (next && shouldMaskArg(next.value)) {
            pushValueSlice(next, 0, next.value.length, replacements);
          }
          break;
        }
        const attached = ATTACHED_P_PASSWORD.exec(arg.value);
        const payload = attached?.[1];
        if (payload && shouldMaskArg(payload)) {
          pushValueSlice(arg, arg.value.length - payload.length, payload.length, replacements);
        }
        break;
      }
    }
  }
}

/** mysql and mariadb mask only the attached short form. A bare short flag prompts. */
function redactMysqlArgv(segments: readonly ArgvWord[][], replacements: ArgvReplacement[]): void {
  for (const segment of segments) {
    const start = segment.findIndex((word) => {
      const name = commandTokenName(word.value);
      return name === 'mysql' || name === 'mariadb';
    });
    if (start < 0) continue;
    for (let j = start + 1; j < segment.length; j += 1) {
      const arg = segment[j];
      if (!arg) continue;
      const attached = ATTACHED_P_PASSWORD.exec(arg.value);
      const payload = attached?.[1];
      if (!payload || !shouldMaskArg(payload)) continue;
      pushValueSlice(arg, arg.value.length - payload.length, payload.length, replacements);
    }
  }
}

/**
 * A short cluster ending in the user flag uses the next word, or the glued
 * payload when there is one. Bare `-u` stays on the exact flag. `-U` does not.
 */
function clusteredCurlUser(value: string): { next: true } | { payload: string } | null {
  if (value.startsWith('--')) return null;
  const match = /^-([A-Za-z]*?)u(.*)$/.exec(value);
  if (!match || !match[1]) return null;
  const payload = match[2] ?? '';
  if (!payload) return { next: true };
  return { payload };
}

/** curl and wget user flags. The account stays; the secret after the colon does not. */
function redactUserinfoArgv(
  segments: readonly ArgvWord[][],
  replacements: ArgvReplacement[]
): void {
  for (const segment of segments) {
    const start = segment.findIndex((word) => {
      const name = commandTokenName(word.value);
      return name === 'curl' || name === 'wget';
    });
    if (start < 0) continue;
    for (let j = start + 1; j < segment.length; j += 1) {
      const arg = segment[j];
      if (!arg) continue;
      if (USER_FLAG.test(arg.value)) {
        const next = segment[j + 1];
        if (next) maskColonPassword(next, next.value, replacements);
        j += 1;
        continue;
      }
      const attached = ATTACHED_USER_FLAG.exec(arg.value);
      if (attached?.[1]) {
        maskColonPassword(arg, attached[1], replacements);
        continue;
      }
      const clustered = clusteredCurlUser(arg.value);
      if (clustered) {
        if ('payload' in clustered) {
          maskColonPassword(arg, clustered.payload, replacements);
          continue;
        }
        const next = segment[j + 1];
        if (next) maskColonPassword(next, next.value, replacements);
        j += 1;
        continue;
      }
      const equals = USER_EQUALS_FLAG.exec(arg.value);
      if (equals?.[1]) maskColonPassword(arg, equals[1], replacements);
    }
  }
}

/** `docker login -p` / `podman login -p` is a password. `docker run -p` publishes a port. */
function redactDockerLoginArgv(
  segments: readonly ArgvWord[][],
  replacements: ArgvReplacement[]
): void {
  for (const segment of segments) {
    for (let i = 0; i < segment.length; i += 1) {
      const name = segment[i] ? commandTokenName(segment[i].value) : '';
      if (name !== 'docker' && name !== 'podman') continue;
      const sub = segment[i + 1];
      if (!sub || commandTokenName(sub.value) !== 'login') continue;
      for (let j = i + 2; j < segment.length; j += 1) {
        const arg = segment[j];
        if (!arg) continue;
        if (arg.value === '-p') {
          const next = segment[j + 1];
          if (next && !next.value.startsWith('-') && shouldMaskArg(next.value)) {
            pushValueSlice(next, 0, next.value.length, replacements);
          }
          j += 1;
          continue;
        }
        const attached = ATTACHED_P_PASSWORD.exec(arg.value);
        const payload = attached?.[1];
        if (!payload || !shouldMaskArg(payload)) continue;
        pushValueSlice(arg, arg.value.length - payload.length, payload.length, replacements);
      }
    }
  }
}

const NESTED_ARGV_HINT =
  /sshpass|\bmysql\b|\bmariadb\b|\bcurl\b|\bwget\b|\bdocker\b|\bpodman\b|--http-password|--password|--passwd|--pass(?!phrase|word|ed|ive|port)/i;

function spansOverlap(a: ArgvReplacement, start: number, end: number): boolean {
  return a.start < end && a.end > start;
}

function redactNestedArgv(
  tokens: readonly ArgvToken[],
  replacements: ArgvReplacement[],
  depth: number
): void {
  for (const token of tokens) {
    if (!isArgvWord(token) || !/\s/.test(token.value)) continue;
    if (!NESTED_ARGV_HINT.test(token.value)) continue;
    const start = token.valueMap[0];
    const last = token.valueMap[token.valueMap.length - 1];
    if (start === undefined || last === undefined) continue;
    const end = last + 1;
    if (replacements.some((rep) => spansOverlap(rep, start, end))) continue;
    for (const rep of collectArgvReplacements(token.value, depth + 1)) {
      const from = token.valueMap[rep.start];
      const to = token.valueMap[contiguousValueEnd(token, rep.start, rep.end - 1)];
      if (from === undefined || to === undefined) continue;
      replacements.push({ start: from, end: to + 1, text: rep.text });
    }
  }
}

function applyArgvReplacements(line: string, replacements: readonly ArgvReplacement[]): string {
  const sorted = [...replacements].sort((a, b) => b.start - a.start || a.end - b.end);
  const used: Array<{ start: number; end: number }> = [];
  let out = line;
  for (const rep of sorted) {
    if (used.some((span) => spansOverlap(rep, span.start, span.end))) continue;
    out = out.slice(0, rep.start) + rep.text + out.slice(rep.end);
    used.push(rep);
  }
  return out;
}

function collectArgvReplacements(line: string, depth: number): ArgvReplacement[] {
  if (!line || depth > 6) return [];
  const tokens = tokenizeArgv(line);
  const segments = argvSegments(tokens);
  const replacements: ArgvReplacement[] = [];
  redactLongPasswordFlags(segments, replacements);
  redactSshpassArgv(segments, replacements);
  redactMysqlArgv(segments, replacements);
  redactUserinfoArgv(segments, replacements);
  redactDockerLoginArgv(segments, replacements);
  redactNestedArgv(tokens, replacements, depth);
  return replacements;
}

function redactArgvLine(line: string, depth: number): string {
  const replacements = collectArgvReplacements(line, depth);
  if (replacements.length === 0) return line;
  return applyArgvReplacements(line, replacements);
}

/**
 * Command-aware argv passwords. Shell text and a one-line echoed argv list
 * share this path. Port flags on ssh, scp, mysql, hdc, and adb stay visible.
 */
function redactCommandArgv(text: string): string {
  const lines = text.split('\n');
  return lines
    .map((line) => {
      const cr = line.endsWith('\r');
      const body = cr ? line.slice(0, -1) : line;
      const redacted = redactArgvLine(body, 0);
      return cr ? `${redacted}\r` : redacted;
    })
    .join('\n');
}

function redactAssignments(text: string, strictFile: boolean): string {
  const continued = maskIndentedQuoteContinuations(text, { strict: strictFile });
  return forEachAssignment(continued, (hit) => {
    if (isParameterExpansionLookup(continued, hit)) return undefined;
    if (!shouldRedactAssignment(hit, strictFile)) return undefined;
    return `${hit.name}${hit.sep}${REDACTED}`;
  });
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

function redactSkFragments(text: string): string {
  return text.replace(new RegExp(String.raw`\b` + SK_FRAGMENT, 'g'), REDACTED);
}

const URL_VALUE_END = '[^@&#\\s\'"`)\\]]+';

const URL_USERINFO_PASSWORD = new RegExp(
  `([a-z][a-z0-9+.-]*:\\/\\/[^/\\s:@]*):(${URL_VALUE_END})@`,
  'gi'
);

const SENSITIVE_QUERY = new RegExp(
  `([?&][A-Za-z0-9_.-]*(?:signature|credential|token|sig)=)(${URL_VALUE_END})`,
  'gi'
);

function redactUrlSecrets(text: string): string {
  return text
    .replace(URL_USERINFO_PASSWORD, (full, user: string, secret: string) =>
      shouldRedactAssignedValue(secret) ? `${user}:${REDACTED}@` : full
    )
    .replace(SENSITIVE_QUERY, (full, key: string, secret: string) =>
      shouldRedactAssignedValue(secret) ? `${key}${REDACTED}` : full
    );
}

function redactGatewayKeyForms(text: string): string {
  let out = text.replace(/(\bReceived\s+API\s+Key\s*=\s*)([^\s,;]+)/gi, `$1${REDACTED}`);
  out = out.replace(/(\bKey\s+Hash(?:\s*\([^)\n]{0,40}\))?\s*=\s*)([^\s,;]+)/gi, `$1${REDACTED}`);
  return redactSkFragments(out);
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
  return redactSkFragments(out);
}

/**
 * A key sitting inside a string (`'Password: '`, `"Password: " + name`) is
 * not an assignment. Hide that closer from `sanitizeSecrets`, which would
 * otherwise treat the next quote on the line as the end of a value.
 */
function shieldOddKeyQuotes(text: string): { text: string; spans: string[] } {
  const spans: string[] = [];
  let out = '';
  let last = 0;
  ASSIGNED_HEAD.lastIndex = 0;
  for (const match of text.matchAll(ASSIGNED_HEAD)) {
    const index = match.index ?? 0;
    if (index < last) continue;
    let i = index + match[0].length;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
    const ch = text[i];
    if ((ch !== '"' && ch !== "'") || quoteOpensValue(text, i)) continue;
    const token = `\u0000Q${spans.length}\u0000`;
    spans.push(text.slice(index, i + 1));
    out += text.slice(last, index);
    out += token;
    last = i + 1;
  }
  out += text.slice(last);
  return { text: out, spans };
}

/**
 * `sanitizeSecrets` masks quoted credential values and any `Password=<8+ chars>`.
 * A password we kept on purpose must not be rewritten, and neither must a
 * value already replaced with `[REDACTED]`. A quote that closes a string
 * around the key is restored after that pass.
 */
function sanitizeWithoutTouchingPlaceholders(text: string): string {
  const odd = shieldOddKeyQuotes(text);
  const spans: string[] = [];
  const shielded = forEachAssignment(odd.text, (hit) => {
    if (!isSyntacticSecretPlaceholder(hit.value)) return undefined;
    const token = `\u0000S${spans.length}\u0000`;
    spans.push(odd.text.slice(hit.start, hit.end));
    return token;
  });
  const protectedText = shielded.split(REDACTED).join(REDACTED_SENTINEL);
  const sanitized = sanitizeSecrets(protectedText).split(REDACTED_SENTINEL).join(REDACTED);
  const restored = sanitized.replace(
    /\u0000S(\d+)\u0000/g,
    (full, index: string) => spans[Number(index)] ?? full
  );
  return restored.replace(
    /\u0000Q(\d+)\u0000/g,
    (full, index: string) => odd.spans[Number(index)] ?? full
  );
}

export interface RedactEgressOptions {
  /**
   * The text came from a `.env*` / credentials-like file, or a tool read that
   * targets one. Secret-named keys use the password rule. Short URL userinfo
   * and high-entropy ordinary assignments are redacted too.
   */
  strictSecrets?: boolean;
}

function redactPgpassLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const match = PGPASS_LINE.exec(line);
      const secret = match?.[5];
      if (!match || !secret || !shouldRedactPasswordValue(secret)) return line;
      return `${match[1]}:${match[2]}:${match[3]}:${match[4]}:${REDACTED}`;
    })
    .join('\n');
}

const LOOSE_USERINFO = /([^\s:='"]{1,128}):([^\s:@'"]+)@/g;
const PLAIN_ASSIGNMENT = /(\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*['"]?)([^\s#'"]+)/g;

function redactStrictCredentialShapes(text: string): string {
  const withUserinfo = text.replace(LOOSE_USERINFO, (full, user: string, secret: string) =>
    shouldRedactPasswordValue(secret) ? `${user}:${REDACTED}@` : full
  );
  const withEntropy = withUserinfo.replace(
    PLAIN_ASSIGNMENT,
    (full, prefix: string, value: string) => {
      if (value.includes(REDACTED)) return full;
      return isHighEntropyToken(value) ? `${prefix}${REDACTED}` : full;
    }
  );
  return redactPgpassLines(withEntropy);
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
  out = redactCommandArgv(out);
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

/**
 * Whole-file strict when the tool targets a credential file. Otherwise each
 * `path:line:body` hit is strict when that path's file name is credential-like.
 * Overlay those hits only when ordinary redaction keeps the line count. If a
 * span swallows newlines, redact the whole block in strict mode. Never put
 * the original line back.
 */
function redactToolResult(text: string, env: NodeJS.ProcessEnv, strictSecrets: boolean): string {
  if (strictSecrets) return redactEgress(text, env, { strictSecrets: true });
  const lines = text.split('\n');
  if (!lines.some((line) => credentialGrepHit(line))) return redactEgress(text, env);
  const ordinary = redactEgress(text, env);
  const ordinaryLines = ordinary.split('\n');
  if (ordinaryLines.length !== lines.length) {
    return redactEgress(text, env, { strictSecrets: true });
  }
  return lines
    .map((line, index) => {
      const hit = credentialGrepHit(line);
      const ordinaryLine = ordinaryLines[index];
      if (!hit) return ordinaryLine ?? '';
      return `${hit.path}:${hit.lineNo}:${redactEgress(hit.body, env, { strictSecrets: true })}`;
    })
    .join('\n');
}

/**
 * Tool result the model is allowed to see. `.apikey-key` bytes are dropped
 * first. Strict redaction then runs on that filtered text.
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
    if (isRawApiKeyFile(resolved)) return CREDENTIAL_WITHHELD;
  }
  const command =
    args.toolName === 'exec' || args.toolName === 'exec_background'
      ? String(args.input.command ?? '')
      : '';
  if (command && /\.apikey-key\b/.test(command)) return CREDENTIAL_WITHHELD;
  const filtered = scrubRawApiKeyLines(args.text, workspaceDir, env);
  const strictSecrets = targetsCredentialFile(args.toolName, args.input);
  if (args.toolName === 'read_file') {
    return redactNumberedToolOutput(
      redactConfigSecretFieldsInView(filtered, env),
      env,
      strictSecrets
    );
  }
  return redactToolResult(filtered, env, strictSecrets);
}

bindRedactEgress(redactEgress);

export {
  createRedactingChunkWriter,
  createStreamingTextRedactor,
  holdOpenSecretSuffix,
  placeholderCount,
  redactedPlaceholderEditError,
  redactedPlaceholderPatchLineError,
  redactedPlaceholderWriteError,
  visibleStreamPrefix,
} from './redact-stream.js';
