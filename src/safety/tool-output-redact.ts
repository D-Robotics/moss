/**
 * One egress path for secret-like text. Reads and shell commands are not
 * blocked. Pattern redaction cannot stop xxd, od -c, hexdump, base64, rev,
 * fold, or a model that reassembles a secret character by character. The
 * main defenses are known-value exact match and the structured rules below
 * (PEM blocks, assignment values, netrc / docker / kube fields). Redaction
 * is defense in depth.
 *
 * Moss credential files are still read. `.apikey-key` bytes are withheld
 * entirely. Property-access chains (`req.headers.authorization`), `${...}`
 * expressions, and bare letter-only identifiers are source text, not secrets.
 * Writing the `[REDACTED]` placeholder back into a file is rejected separately.
 */
import path from 'node:path';
import { redactKnownSecretValues } from './known-secrets.js';
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
 * `_` is allowed before the keyword so `SERVICE_TOKEN=` and
 * `aws_secret_access_key =` match. Longer field names come first so the
 * whole name is kept in the replacement.
 */
/**
 * Real newlines and JSON `\n` / `\r\n` escapes both separate fields. Session
 * files are redacted after JSON.stringify, so the escape form has to count.
 */
const FIELD_BOUNDARY = String.raw`(?<=\\r\\n|\\n|^|[^A-Za-z0-9])`;

const ASSIGNED_SECRET = new RegExp(
  FIELD_BOUNDARY +
    '(aws_secret_access_key|aws_access_key_id|client-key-data|client_key_data|api[_-]?key|access[_-]?key|private[_-]?key|secret|token|password|passwd|credential|authorization|bearer)(["\']?\\s*[:=]\\s*["\']?)([^\\s"\',}\\\\;)]{8,})',
  'gi'
);

/** `.netrc` uses `password <value>`, not `password=`. */
const NETRC_PASSWORD = /(^|[^\w]|\\r\\n|\\n)(password)([ \t]+)(?![=:])([^\s\\]{8,})/gi;

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
 * (`hashedPasswordValue`, `someLongIdentifierName`). A value is secret-like
 * when it mixes letters and digits, or when it is long and not an identifier.
 */
function shouldRedactAssignedValue(value: string): boolean {
  if (value.length < 8) return false;
  if (isPlaceholder(value) || isSourceExpression(value)) return false;
  if (BARE_IDENTIFIER.test(value)) return false;
  if (/[A-Za-z]/.test(value) && /\d/.test(value)) return true;
  return value.length >= 20;
}

function redactPemBlocks(text: string): string {
  return text.replace(PEM_PRIVATE_KEY, REDACTED);
}

function redactAssignments(text: string): string {
  return text.replace(ASSIGNED_SECRET, (full, name: string, sep: string, value: string) => {
    if (!shouldRedactAssignedValue(value)) return full;
    return `${name}${sep}${REDACTED}`;
  });
}

function redactNetrcPasswords(text: string): string {
  return text.replace(
    NETRC_PASSWORD,
    (full, lead: string, name: string, sep: string, value: string) => {
      if (!shouldRedactAssignedValue(value)) return full;
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

/**
 * `sanitizeSecrets` masks quoted credential values. Hide placeholders first so
 * a value we already replaced is not rewritten as `hunt***er`.
 */
function sanitizeWithoutTouchingPlaceholders(text: string): string {
  if (!text.includes(REDACTED)) return sanitizeSecrets(text);
  const protectedText = text.split(REDACTED).join(REDACTED_SENTINEL);
  return sanitizeSecrets(protectedText).split(REDACTED_SENTINEL).join(REDACTED);
}

/**
 * Redact one string before it leaves the process: tool results, live exec
 * output, background buffers, assistant text, SDK events, evidence files,
 * and session logs.
 */
export function redactEgress(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  let out = redactPemBlocks(text);
  out = redactKnownSecretValues(out, env);
  out = redactAssignments(out);
  out = redactNetrcPasswords(out);
  out = redactDockerAuth(out);
  out = redactStandalone(out);
  return sanitizeWithoutTouchingPlaceholders(out);
}

/** @deprecated Use `redactEgress`. Kept so existing callers stay on the one path. */
export function redactToolOutput(text: string, env?: NodeJS.ProcessEnv): string {
  return redactEgress(text, env);
}

const CREDENTIAL_WITHHELD = 'Moss credential values withheld.\n';

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
  return redactEgress(args.text, env);
}

/**
 * Line-buffer a live stdout stream so a secret that arrives as a full line is
 * redacted before it is shown. The trailing partial line is held until flush.
 * The tool-result post hook redacts the final string again; this writer only
 * covers the live stream.
 */
function visibleStreamPrefix(raw: string, flush: boolean): string {
  const begin = raw.lastIndexOf('-----BEGIN ');
  if (begin !== -1) {
    const after = raw.slice(begin);
    const openPrivateKey =
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(after) &&
      !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(after);
    if (openPrivateKey) return raw.slice(0, begin);
  }
  if (flush || raw.endsWith('\n')) return raw;
  const nl = raw.lastIndexOf('\n');
  return nl === -1 ? '' : raw.slice(0, nl + 1);
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
