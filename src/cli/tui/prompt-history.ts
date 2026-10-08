/**
 * Workspace prompt history. One JSON object per line, newest last, capped.
 * The file stays inside the workspace runtime dir and is never sent anywhere.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 500;

export function promptHistoryFile(runtimeDir: string): string {
  return path.join(runtimeDir, 'prompt-history.jsonl');
}

export function loadPromptHistory(file: string): string[] {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const entries: string[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { text?: unknown };
        if (typeof parsed.text === 'string' && parsed.text.trim()) entries.push(parsed.text);
      } catch {
        // A corrupt line is skipped; the rest of the history still loads.
      }
    }
    return entries.slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Newest last. A later list wins on duplicates, so a prompt typed again moves
 * to the end. An empty list does not erase what is already on disk: a stale
 * in-memory snapshot used to overwrite the file with a single entry.
 */
export function mergePromptHistory(lists: readonly (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const text of list) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      const existing = out.indexOf(trimmed);
      if (existing >= 0) out.splice(existing, 1);
      out.push(trimmed);
    }
  }
  return out.slice(-MAX_ENTRIES);
}

export function loadMergedPromptHistory(files: readonly string[]): string[] {
  return mergePromptHistory(files.map((file) => loadPromptHistory(file)));
}

export function savePromptHistory(file: string, entries: readonly string[]): void {
  const merged = mergePromptHistory([loadPromptHistory(file), entries]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = merged.map((text) => JSON.stringify({ text })).join('\n');
  fs.writeFileSync(file, body.length > 0 ? `${body}\n` : '');
}

export interface HistoryCursor {
  /** Index into the history list. Undefined when the walk is not active. */
  index: number | undefined;
  /** Composer text to restore when the walk moves past the newest entry. */
  draft: string;
}

/**
 * Up recalls the previous submission; down walks back toward the draft.
 * The draft is captured on the first Up so a half-typed line is not lost.
 */
export function walkPromptHistory(
  entries: readonly string[],
  cursor: HistoryCursor,
  direction: 'older' | 'newer',
  currentInput: string
): (HistoryCursor & { text: string }) | undefined {
  if (entries.length === 0) return undefined;
  if (direction === 'older') {
    const index = cursor.index === undefined ? entries.length - 1 : Math.max(0, cursor.index - 1);
    return {
      index,
      draft: cursor.index === undefined ? currentInput : cursor.draft,
      text: entries[index] ?? '',
    };
  }
  if (cursor.index === undefined) return undefined;
  const index = cursor.index + 1;
  if (index >= entries.length) {
    return { index: undefined, draft: '', text: cursor.draft };
  }
  return { index, draft: cursor.draft, text: entries[index] ?? '' };
}
