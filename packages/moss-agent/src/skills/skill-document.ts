export interface SkillDocument {
  frontmatter: string | null;
  body: string;
}

/** Parse a Markdown Skill without coupling body extraction to a multiline regex. */
export function parseSkillDocument(raw: string): SkillDocument {
  const normalized = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines[0] !== '---') return { frontmatter: null, body: normalized.trim() };

  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closingIndex < 0) return { frontmatter: null, body: '' };
  return {
    frontmatter: lines.slice(1, closingIndex).join('\n'),
    body: lines.slice(closingIndex + 1).join('\n').trim(),
  };
}
