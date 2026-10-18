/**
 * Exec must not be the path that writes the redaction placeholder back.
 * Commands whose text contains `[REDACTED]` and a write action are refused
 * before spawn. After exec, files from the caller's mutation list are only
 * scanned: if the placeholder count went up, the tool result names those
 * files. Nothing is deleted or overwritten. Copying or moving a file that
 * already contained the placeholder is not a count increase of new
 * redaction — the destination bytes already existed in the snapshot.
 * Shell redirects feed the mutation list; interpreter writes to watched
 * protected paths are covered when callers also merge those paths in
 * (see {@link includeProtectedPathsInMutationSnap}).
 */
import fs from 'node:fs';
import path from 'node:path';

export const REDACTED_PLACEHOLDER = '[REDACTED]';

const PLACEHOLDER_BYTES = Buffer.from(REDACTED_PLACEHOLDER);

export function redactedShellWriteRefusal(command: string, hasWriteAction: boolean): string | null {
  if (!hasWriteAction || !command.includes(REDACTED_PLACEHOLDER)) return null;
  return (
    'Command blocked: refusing to write [REDACTED] into a file. ' +
    'The placeholder is a redaction mark, not file content. ' +
    'Edit the real text from read_file; do not write the redacted form back.'
  );
}

export function snapshotMutationFiles(
  workspaceDir: string,
  mutationPaths: readonly string[]
): Map<string, Buffer | null> {
  const snap = new Map<string, Buffer | null>();
  const root = path.resolve(workspaceDir || process.cwd());
  for (const rel of mutationPaths) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
    if (snap.has(abs)) continue;
    try {
      snap.set(abs, fs.readFileSync(abs));
    } catch {
      snap.set(abs, null);
    }
  }
  return snap;
}

/**
 * O152 F10: also watch L3 protected files for placeholder growth so
 * `node -e` / `python3 -c` writes (no shell redirect) are still detected.
 * Absolute paths only; existing snap entries win (keep the earlier bytes).
 */
export function includeProtectedPathsInMutationSnap(
  snap: Map<string, Buffer | null>,
  protectedAbsPaths: Iterable<string>
): void {
  for (const abs of protectedAbsPaths) {
    if (!abs || snap.has(abs)) continue;
    try {
      snap.set(abs, fs.readFileSync(abs));
    } catch {
      snap.set(abs, null);
    }
  }
}

function placeholderCountInBuffer(buf: Buffer): number {
  let count = 0;
  let from = 0;
  while (from <= buf.length) {
    const at = buf.indexOf(PLACEHOLDER_BYTES, from);
    if (at === -1) return count;
    count += 1;
    from = at + PLACEHOLDER_BYTES.length;
  }
  return count;
}

/**
 * Paths whose placeholder count rose, and whose new bytes are not a copy of
 * a snapshot that already had them (cp/mv of a file that already contained
 * `[REDACTED]`). Missing paths are skipped — a moved source is not recreated.
 */
export function filesWithIncreasedPlaceholderCount(snap: Map<string, Buffer | null>): string[] {
  const beforeImages = [...snap.values()].filter((buf): buf is Buffer => buf !== null);
  const increased: string[] = [];
  for (const [abs, before] of snap) {
    let after: Buffer;
    try {
      after = fs.readFileSync(abs);
    } catch {
      continue;
    }
    const beforeCount = before === null ? 0 : placeholderCountInBuffer(before);
    const afterCount = placeholderCountInBuffer(after);
    if (afterCount <= beforeCount) continue;
    const copiedExisting = beforeImages.some((image) => image.equals(after));
    if (copiedExisting) continue;
    increased.push(abs);
  }
  return increased;
}

/**
 * O152 r4: after L3 restore, word the warning from the post-restore state.
 * - `restoredPaths`: placeholder was written then L3 put prior bytes back —
 *   say "placeholder written; restored" (never "Moss did not overwrite").
 * - `keptPaths`: still on disk with more `[REDACTED]` (approved / non-protected)
 *   — keep the classic "must be restored … Moss did not overwrite" wording.
 */
export function formatRedactedWritebackWarning(
  keptPaths: readonly string[],
  restoredPaths: readonly string[] = []
): string {
  const parts: string[] = [];
  if (restoredPaths.length > 0) {
    parts.push(
      'Warning: [REDACTED] placeholder was written into ' +
        restoredPaths.join(', ') +
        '; Moss restored the prior content (placeholder written; restored).'
    );
  }
  if (keptPaths.length > 0) {
    parts.push(
      'Warning: real values in these files were replaced by [REDACTED] and must be restored from the original source: ' +
        keptPaths.join(', ') +
        '. Moss did not delete or overwrite them.'
    );
  }
  if (parts.length === 0) return '';
  return '\n\n[moss] ' + parts.join(' ');
}
