/**
 * Streaming redaction and write-back refusal. An open line (and an unclosed
 * PEM block) stays held until `flush`. Writing `[REDACTED]` back into a file
 * is rejected when the placeholder count would rise.
 *
 * `redactEgress` lives in the facade. This module only calls it from
 * functions, after both modules have finished initializing.
 */
import { knownSecretPrefixCut } from './known-secrets.js';
import { unclosedPrivateKeyLineStart } from './redact-pem.js';
import {
  OPEN_SECRET_PREFIX,
  REDACTED,
  SECRET_FIELD_SOURCE,
  redactEgress,
} from './tool-output-redact.js';

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
  const redacted = redactEgress(line, env);
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
