/**
 * Secret-redaction patterns + free-text redactor. Lives in the safety base layer
 * (alongside `sanitizeSecrets` / `containsSecrets`) so that `skill-learning` can
 * redact `userMessage` / `assistantText` before persisting a SKILL.md draft
 * WITHOUT pulling the `memory` layer — keeping `skill-learning` a self-contained
 * base layer (no skill-learning → memory dependency).
 *
 * Shares the canonical `MEMORY_SECRET_PATTERNS` with memory's
 * `validateMemoryWriteContent` (which imports it from here) so the two cannot
 * drift.
 * @public
 */
export const MEMORY_SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bgh[posru]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{4,}@/i,
  /\b(?:password|passwd|pwd|api[_-]?key|secret|access[_-]?key|auth[_-]?token)\b\s*[:=]\s*['"]?(?=[^\s'"]{0,40}\d)[^\s'"]{6,}/i,
];

/**
 * Redact secret-shaped substrings from free text (e.g. a user message pasted
 * into a conversation) by replacing each match with `[redacted]`. Used by
 * skill-learning to sanitize `userMessage` / `assistantText` before persisting a
 * SKILL.md draft, so a pasted API key does not land in `.moss/skills/`.
 * Shares the canonical {@link MEMORY_SECRET_PATTERNS} with memory's
 * `validateMemoryWriteContent` so the two cannot drift.
 * @public
 */
export function redactSecretsInText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of MEMORY_SECRET_PATTERNS) {
    // Patterns lack a global flag; replace() would only redact the first
    // occurrence. Use a global copy so a message pasting the same secret twice
    // does not leave the second one in the persisted text.
    const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
    out = out.replace(new RegExp(re.source, flags), '[redacted]');
  }
  return out;
}
