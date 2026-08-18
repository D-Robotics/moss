/** CLI interaction modes shared by terminal and embedded hosts. */
export type CliInteractionMode = 'plan' | 'default' | 'acceptEdits';

let currentInteractionMode: CliInteractionMode = 'default';
const interactionModeListeners = new Set<(mode: CliInteractionMode) => void>();

export function setCliInteractionMode(mode: CliInteractionMode): void {
  if (currentInteractionMode === mode) return;
  currentInteractionMode = mode;
  for (const listener of interactionModeListeners) {
    try {
      listener(mode);
    } catch {
      // listeners must not break mode transitions
    }
  }
}

export function getCliInteractionMode(): CliInteractionMode {
  return currentInteractionMode;
}

/** Subscribe to interaction-mode changes (plan / default / acceptEdits). */
export function subscribeCliInteractionMode(
  listener: (mode: CliInteractionMode) => void
): () => void {
  interactionModeListeners.add(listener);
  return () => {
    interactionModeListeners.delete(listener);
  };
}

export function formatCliInteractionModeLabel(mode: CliInteractionMode, zh = false): string {
  if (mode === 'plan') return zh ? '计划模式' : 'plan';
  if (mode === 'acceptEdits') return zh ? '自动接受编辑' : 'accept-edits';
  return zh ? '默认' : 'default';
}

export function parseCliInteractionMode(raw: string | undefined): CliInteractionMode | null {
  const token = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if (!token) return null;
  if (token === 'plan' || token === 'p' || token === '计划' || token === '计划模式') {
    return 'plan';
  }
  if (
    token === 'default' ||
    token === 'd' ||
    token === 'normal' ||
    token === '默认' ||
    token === '默认模式'
  ) {
    return 'default';
  }
  if (
    token === 'accept-edits' ||
    token === 'acceptedits' ||
    token === 'accept' ||
    token === 'auto' ||
    token === 'a' ||
    token === '自动接受' ||
    token === '自动接受编辑'
  ) {
    return 'acceptEdits';
  }
  return null;
}

/**
 * Best-effort interaction mode recovery from session history (no extra storage).
 * Newest signal wins:
 * - "Left plan mode → default" / switched-to-default text → default
 * - user prompt prefixed with Moss plan-mode header → plan
 * - explicit /mode plan|default|accept-edits user text → that mode
 * Returns null when no signal is found.
 */
export function inferCliInteractionModeFromMessages(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>
): CliInteractionMode | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const texts: string[] = [];
    if (typeof m.content === 'string') {
      texts.push(m.content);
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string; content?: unknown };
        if (typeof b.text === 'string') texts.push(b.text);
        if (typeof b.content === 'string') texts.push(b.content);
      }
    }
    for (const text of texts) {
      const head = text.slice(0, 240);
      if (
        /Left plan mode\s*(→|->)\s*default/i.test(text) ||
        /已切换到默认/i.test(text) ||
        /Switched to default\b/i.test(text)
      ) {
        return 'default';
      }
      if (m.role === 'user' && (/^\[Plan mode\]/m.test(head) || /^\[计划模式\]/m.test(head))) {
        return 'plan';
      }
      if (m.role === 'user') {
        const cmd = text.trim().toLowerCase();
        if (/^\/mode\s+plan\b/.test(cmd) || cmd === '/plan') return 'plan';
        if (/^\/mode\s+accept-?edits\b/.test(cmd)) return 'acceptEdits';
        if (/^\/mode\s+default\b/.test(cmd)) return 'default';
      }
    }
  }
  return null;
}
