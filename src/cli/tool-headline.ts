export const HEADLINE_MAX = 72;

export function summarizeToolInput(input: unknown, maxChars = 80): string {
  if (input === undefined || input === null) return '';
  let raw: string;
  try {
    raw = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    raw = String(input);
  }
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Pull the most informative arg out of a tool input for the headline.
 * Examples:
 *   `{ path: 'src/foo.ts' }` → 'src/foo.ts'
 *   `{ command: 'npm run build' }` → 'npm run build'
 *   `{ query: 'authStore' }` → 'authStore'
 *   `{ url: 'https://...' }` → 'https://...'
 * Falls back to summarizeToolInput.
 */
export function toolHeadline(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return summarizeToolInput(input, HEADLINE_MAX);
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  const preferred = [
    'path',
    'file_path',
    'filepath',
    'file',
    'command',
    'cmd',
    'query',
    'pattern',
    'url',
    'symbol',
    'task',
    'description',
    'subject',
  ];
  for (const key of preferred) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) {
      const compact = value.replace(/\s+/g, ' ').trim();
      return compact.length > HEADLINE_MAX
        ? `${compact.slice(0, HEADLINE_MAX - 1).trimEnd()}…`
        : compact;
    }
  }
  return summarizeToolInput(input, HEADLINE_MAX);
}
