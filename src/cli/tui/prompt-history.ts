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

export function savePromptHistory(file: string, entries: readonly string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = entries
    .slice(-MAX_ENTRIES)
    .map((text) => JSON.stringify({ text }))
    .join('\n');
  fs.writeFileSync(file, body.length > 0 ? `${body}\n` : '');
}
