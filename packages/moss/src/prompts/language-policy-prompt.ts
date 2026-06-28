














export function buildLanguagePolicyPrompt(): string {
  return [
    '## Response Language',
    "- **Default to English.** Write each response in the language of the user's most recent message: if they write in Chinese, reply in Chinese; if in English, reply in English; likewise for any other language.",
    '- When the latest message carries no clear language signal — it is only code, a file path, a URL, a number, a single command or symbol, or is otherwise ambiguous — respond in **English**.',
    "- Let only the user's own prose decide the language. Do **not** switch based on quoted text, log lines, file contents, or tool results, even when those are in another language.",
    '- Keep code, identifiers, file paths, shell commands, API and tool names, and tool-call arguments verbatim regardless of the response language; never translate or transliterate them.',
    '- If the user explicitly asks for a specific output language, follow that and keep using it until they ask otherwise.',
  ].join('\n');
}






export function buildLanguagePolicyPromptQuick(): string {
  return [
    '## Response Language (brief)',
    "Default to English; otherwise match the language of the user's latest message (Chinese in → Chinese out). Ambiguous or code-only → English. Decide from the user's own prose only, never from quoted text or tool output. Never translate code, identifiers, paths, commands, or tool arguments. Honor an explicit language request until the user changes it.",
  ].join('\n');
}
