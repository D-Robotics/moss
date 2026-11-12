/**
 * Streaming redaction and write-back refusal. An open line (and an unclosed
 * PEM block) stays held until `flush`. Writing `[REDACTED]` back into a file
 * is rejected when the placeholder count would rise.
 *
 * `redactEgress` is bound by the facade. This module does not import it.
 */
import { createKnownSecretStreamCut, knownSecretPrefixCut } from './known-secrets.js';
import { callRedactEgress } from './redact-bind.js';
import { OPEN_SECRET_PREFIX, REDACTED, SECRET_FIELD_SOURCE } from './redact-patterns.js';
import { unclosedPrivateKeyLineStart } from './redact-pem.js';

/**
 * Text safe to paint while a stream is still open: every finished line, and
 * nothing from the current partial line or an unclosed line-start PEM block.
 * `flush` emits the tail.
 */
export function visibleStreamPrefix(raw: string, flush: boolean): string {
  if (flush) return raw;
  const holdAt = unclosedPrivateKeyLineStart(raw);
  if (holdAt !== -1) return raw.slice(0, holdAt);
  if (raw.endsWith('\n')) return raw;
  const nl = raw.lastIndexOf('\n');
  return nl === -1 ? '' : raw.slice(0, nl + 1);
}

let openAssignment: RegExp | undefined;
let openStandalone: RegExp | undefined;

function openAssignmentPattern(): RegExp {
  openAssignment ??= new RegExp(
    `((?:${SECRET_FIELD_SOURCE})|(?<=_)(?:pwd|pass))(["']?\\s*[:=]\\s*["']?)(\\S*)$`,
    'i'
  );
  return openAssignment;
}

function openStandalonePattern(): RegExp {
  openStandalone ??= new RegExp(`(?:${OPEN_SECRET_PREFIX})[A-Za-z0-9_+/=-]*$`);
  return openStandalone;
}

/**
 * Paint an unfinished line except a secret that is still growing. A finished
 * value is already `[REDACTED]`. Ordinary prose is returned as-is.
 */
export function holdOpenSecretSuffix(line: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!line) return '';
  if (
    /^[ \t]*(?:[+\- >][ \t]*)?-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(line) &&
    !/-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(line)
  ) {
    return '';
  }
  const redacted = callRedactEgress(line, env);
  let cut = knownSecretPrefixCut(redacted, env);
  const assign = openAssignmentPattern().exec(redacted);
  if (assign?.[3] !== undefined && assign[3] !== REDACTED) {
    const start = assign.index;
    const bounded = start === 0 || !/[A-Za-z0-9_]/.test(redacted.charAt(start - 1));
    if (bounded) cut = Math.min(cut, start);
  }
  const standalone = openStandalonePattern().exec(redacted);
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
    const redacted = callRedactEgress(visibleStreamPrefix(raw, flush));
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

// A word at the end of a chunk could still become a provider key or an
// assignment. Credential words also introduce patterns that reach across
// whitespace. Keep those words and structured syntax on the full-text path.
const CREDENTIAL_WORD = new RegExp(
  `(?:${SECRET_FIELD_SOURCE}|passwordvalue|pwd|pass|auth|sig|accountkey|sharedaccesskey)$|eyJ|AKIA|AIza`,
  'i'
);
const PROSE_SYMBOL =
  /[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200D.,!?;'"()[\]{}#*`，。！？、；：“”‘’（）《》…—–]/uy;
const PROSE_BREAK = /^[ \t\r\n.,!?;'"()[\]{}#*`]|^[^\x00-\x7f]/u;
const ATOM_BREAK = /^[\s'"`()\[\]{};,!]/u;

/**
 * Publish stable prose and completed ordinary code/path atoms. Credential
 * contexts and unresolved command syntax remain pending for full redaction.
 * Tool and command output keep the ordinary line-oriented redactor.
 */
export function createAssistantTextRedactor(
  options: { normalizeLeadingWhitespace?: boolean } = {}
) {
  const atom = /[A-Za-z0-9_$/\\:=@?&%+#~-][A-Za-z0-9_$./\\:=@?&%+#~-]*/y;
  const symbol = new RegExp(PROSE_SYMBOL);
  let raw = '';
  let scanned = 0;
  let proseEnd = 0;
  let emitted = 0;
  let held = false;
  let leading = options.normalizeLeadingWhitespace === true;
  let structured = false;
  let cutKnownSecrets: ReturnType<typeof createKnownSecretStreamCut> | undefined;

  const reset = () => {
    raw = '';
    scanned = proseEnd = emitted = 0;
    held = structured = false;
    leading = options.normalizeLeadingWhitespace === true;
    cutKnownSecrets = undefined;
  };

  const advance = () => {
    while (!held && scanned < raw.length) {
      const char = raw.charAt(scanned);
      if (/\s/u.test(char)) {
        scanned += 1;
        continue;
      }
      // A Markdown bullet or quote can still introduce a PEM diff line.
      if ((char === '-' || char === '>') && /\s/u.test(raw.charAt(scanned + 1))) {
        const body = raw.slice(scanned + 1).search(/\S/u);
        if (body === -1) return;
        if (raw.charAt(scanned + 1 + body) === '-') {
          held = true;
          return;
        }
        scanned += 1;
        proseEnd = scanned;
        continue;
      }
      atom.lastIndex = scanned;
      const token = atom.exec(raw);
      if (token) {
        let value = token[0];
        if (atom.lastIndex === raw.length) {
          if (!value.endsWith('.') || /[:/\\]/.test(value)) return;
          value = value.slice(0, -1);
          atom.lastIndex -= 1;
        }
        const delimiter = raw.charAt(atom.lastIndex);
        const words = value.match(/[A-Za-z0-9_]+/g) ?? [];
        const contextual =
          CREDENTIAL_WORD.test(value) || words.some((word) => CREDENTIAL_WORD.test(word));
        const flag = value.startsWith('-') && !/^-\d/.test(value);
        const url = value.includes('://');
        // A URL password can include non-ASCII text and punctuation. Only
        // actual URL/argv terminators make such an atom complete.
        const boundary = url ? ATOM_BREAK.test(delimiter) : PROSE_BREAK.test(delimiter);
        if (contextual || flag) {
          held = true;
          return;
        }
        if (!boundary) return;
        structured ||= /[^A-Za-z0-9]/.test(value);
        scanned = atom.lastIndex;
      } else {
        if (scanned + 1 === raw.length && /[\uD800-\uDBFF]/.test(char)) return;
        symbol.lastIndex = scanned;
        if (!symbol.test(raw)) return;
        structured ||= char === '`' || char === '{' || char === '}';
        scanned = symbol.lastIndex;
      }
      proseEnd = scanned;
    }
  };

  return {
    push(chunk: string): string {
      if (leading) {
        chunk = chunk.trimStart();
        if (!chunk) return '';
        leading = false;
      }
      raw += chunk;
      advance();
      if (proseEnd <= emitted) return '';
      const prefix = raw.slice(0, proseEnd);
      // Structured atoms must also agree with the authoritative batch
      // redactor before their original bytes can enter an append-only stream.
      if (structured && callRedactEgress(prefix) !== prefix) {
        held = true;
        return '';
      }
      cutKnownSecrets ??= createKnownSecretStreamCut();
      const candidate = raw.slice(emitted, proseEnd);
      const delta = candidate.slice(0, cutKnownSecrets(candidate));
      emitted += delta.length;
      return delta;
    },
    flush(finalText = raw): string {
      const canonical = options.normalizeLeadingWhitespace ? finalText.trimStart() : finalText;
      const settled = callRedactEgress(canonical);
      const delta = settled.startsWith(raw.slice(0, emitted)) ? settled.slice(emitted) : '';
      reset();
      return delta;
    },
    reset,
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
