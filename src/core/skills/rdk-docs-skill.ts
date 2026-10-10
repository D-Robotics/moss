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
  'Start with `mcp__rdk-docs__search` once, open at most 2 pages, answer with the source link, then stop. Search registers the available tools and returns their exact callable names and descriptions; do not guess a tool name that search did not return.',
  'Common server tools include `list_manuals`, `search_docs`, `get_page`, and `list_toc`, but their arguments depend on the installed package version. Use the schema Moss registers after search.',
  'Board: pass the board the user named. Otherwise, if a device is configured, call device_info and map its `board:` line to x3|x5|s100|s600 or another id the schema lists. With no device and no named board, ask one short question for the board before board-specific topics (flashing, drivers, pins, cameras, images), then search with board. Pass `board` and `alt_queries` only when the returned schema has them.',
  'If the result exposes `noGoodMatch`, ranking metadata, or section reads, use them; otherwise judge ordinary hits and fetch the whole page.',
  'If a page says it was truncated and its schema supports a larger character limit, fetch it again within that schema limit.',
  '',
  'Judge the snippet yourself:',
  '- Prefer a hit with role=official-start, then open that URL.',
  '- A top score can still be the wrong board. Keep the URL that matches the asked board (RDK_X5 is not RDK_X3; rdk-s is not rdk-x).',
  "- Keep `query` short. If the schema has `alt_queries`, add 1-3 rewrites in manual wording: turn colloquial terms and symptoms into the manual's terms, keep error codes, commands and API names verbatim, drop timestamps, paths and hex dumps, add no facts the user did not state.",
  '- A bare package name such as hobot_dnn barely matches. Search the task (BPU inference) and keep the page for the asked board.',
  '- `source=forum` is unofficial. Use it only when the user wants community experience or the manual has no page. The manual wins a conflict.',
  '- An empty shell page: open `related`.',
  '- Pinouts, current limits, and connector counts are often figures. Do not reconstruct a table the page text does not contain. If two pages disagree, cite both URLs.',
  '- Cite every page URL copied from search or get_page, including when the page body was truncated. A quotation is not an acceptance pass.',
  '- Zero hits stay zero hits. Say the search missed; do not invent a page.',
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
