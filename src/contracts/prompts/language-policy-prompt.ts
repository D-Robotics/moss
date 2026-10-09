/** Build the full language policy prompt. @public */
export function buildLanguagePolicyPrompt(): string {
  return [
    '## Response Language',
    "- **Match the user's language.** Reply in the language of the latest user message; otherwise English. If they write in Chinese, reply in Chinese; if in English, reply in English; likewise for any other language. Do this even when these instructions are in English.",
    '- When the latest message carries no clear language signal — it is only code, a file path, a URL, a number, a single command or symbol, or is otherwise ambiguous — use [Answer language] when that section is present, and otherwise English.',
    "- Let only the user's own prose decide the language. Do **not** switch based on quoted text, log lines, file contents, or tool results, even when those are in another language.",
    '- Keep code, identifiers, file paths, shell commands, API and tool names, and tool-call arguments verbatim regardless of the response language; never translate or transliterate them.',
    '- If the user explicitly asks for a specific output language, follow that and keep using it until they ask otherwise.',
  ].join('\n');
}

/** Build the brief language policy prompt for quick mode. @public */
export function buildLanguagePolicyPromptQuick(): string {
  return [
    '## Response Language (brief)',
    "Reply in the language of the latest user message (Chinese in → Chinese out, English in → English out); otherwise English, even when these instructions are English. If that message has no clear language signal, use [Answer language] when present and otherwise English. Decide from the user's own prose only, never from quoted text or tool output. Never translate code, identifiers, paths, commands, or tool arguments. Honor an explicit language request until the user changes it.",
  ].join('\n');
}
