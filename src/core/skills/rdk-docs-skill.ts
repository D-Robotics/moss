/**
 * Bundled rdk-docs skill. The index line is added only while the server is
 * connected; the body loads through the skill tool. This is the short usage
 * guide from the 2026-10-09 audit — not the npm package's forum/post skill.
 */
import type { SkillManifest } from './skill-registry.js';

export const RDK_DOCS_SKILL_NAME = 'rdk-docs';

const RDK_DOCS_SKILL_BODY = [
  'The rdk-docs server is the source of RDK board facts. Moss does not ship a manual, and a failed connect is not a reason to answer from memory.',
  '',
  'For a question: call `mcp__rdk-docs__search` once, open at most 2 pages, answer with the source link, then stop.',
  'Search registers the available tools and returns their exact callable names. Do not guess a tool name that search did not return.',
  'If the search schema supports a board/manual filter, pass it when the user named a board.',
  '',
  'Judge the snippet yourself:',
  '- Prefer a hit with role=official-start, then open that URL.',
  '- A top score can still be the wrong board. Keep the URL that matches the asked board.',
  '- `source=forum` is unofficial. The manual wins a conflict.',
  '- Cite every page URL you used. Zero hits stay zero hits. Do not invent a page.',
  '- Pinouts are often figures. Do not reconstruct a table the page text does not contain.',
  '',
  'Do not look up how Moss connects. If a device is configured, probes run before docs. If none is configured, do not call device tools.',
].join('\n');

export function bundledRdkDocsSkill(): SkillManifest {
  return {
    name: RDK_DOCS_SKILL_NAME,
    description: 'Look up RDK manual pages; judge snippets and cite the URL.',
    when: 'an RDK board fact is needed',
    file: 'builtin:rdk-docs',
    body: RDK_DOCS_SKILL_BODY,
  };
}

/**
 * Add the bundled skill only while the server is connected, and only when the
 * user has not already provided a skill of the same name (theirs wins).
 */
export function includeBundledRdkDocsSkill(
  skills: readonly SkillManifest[],
  connected: boolean
): SkillManifest[] {
  if (!connected) return [...skills];
  if (skills.some((skill) => skill.name === RDK_DOCS_SKILL_NAME)) return [...skills];
  return [...skills, bundledRdkDocsSkill()];
}
