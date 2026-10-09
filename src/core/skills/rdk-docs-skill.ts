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
  'Tools (call `mcp__rdk_docs__search` first if a name is not registered yet):',
  '- `mcp__rdk_docs__list_manuals` — manual ids. Relevant ids include `rdk-x` (X3/X5; aliases `x3`/`x5`), `rdk-s` (S100/S600), `tros`, `rdk-studio`, `xburn`, `model-zoo`.',
  '- `mcp__rdk_docs__search_docs` — search. Pass `manual` when the user named a board.',
  '- `mcp__rdk_docs__get_page` — one page. If `truncated` is true, call again with a larger `maxChars` (limit 40000).',
  '- `mcp__rdk_docs__list_toc` — contents of one manual.',
  '',
  'Judge the snippet yourself:',
  '- Prefer a hit with role=official-start, then open that URL.',
  '- A top score can still be the wrong board. Keep the URL that matches the asked board (RDK_X5 is not RDK_X3; rdk-s is not rdk-x).',
  '- Query with the user\'s words. Ask for one board\'s page ("RDK X5 hardware introduction"), not a comparison the index ranks poorly.',
  '- A bare package name such as hobot_dnn barely matches. Search the task (BPU inference) and keep the page for the asked board.',
  '- `source=forum` is unofficial. Use it only when the user wants community experience or the manual has no page. The manual wins a conflict.',
  '- An empty shell page: open `related`.',
  '- Pinouts, current limits, and connector counts are often figures. Do not reconstruct a table the page text does not contain. If two pages disagree, cite both URLs.',
  '- Reply with the page URL. When the fact supports `record_evidence`, copy the URL into observed. A quotation is not an acceptance pass.',
  '- Zero hits stay zero hits. Say the search missed; do not invent a page.',
  '',
  'Do not look up how Moss connects. `device_info`, the probe scripts, and the device safety policy run first. Docs answer what to do on the board.',
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
