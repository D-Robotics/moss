/**
 * Skill tools — Claude Code SkillTool / Grok skill tool parity + SkillHub market.
 *
 * - `load_skill`: on-demand load of a local/builtin/bundled skill body.
 * - `skillhub_search` / `skillhub_install`: discover and install marketplace skills
 *   into the workspace `.moss/skills` directory (SkillHub CN-first store).
 *
 * Passive keyword matchByText still auto-injects high-confidence skills; these tools
 * cover the miss path (model knows the catalog and pulls what it needs).
 */

import fs from 'node:fs';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { SkillRegistry, getSkillAliases } from '../skills/registry.js';
import type { SkillMeta } from '../skills/types.js';
import { skillHubInstall, skillHubSearch } from '../skills/skillhub.js';
import { toolError } from './tool-helpers.js';

const MAX_BODY_CHARS = 24_000;
const MAX_LIST_DESC = 160;

function createRegistry(ctx: ToolContext): SkillRegistry {
  return new SkillRegistry({ workspaceDir: ctx.workspaceDir });
}

function readBody(skill: SkillMeta): string | undefined {
  if (!skill.sourcePath || skill.sourcePath.startsWith('builtin://')) {
    return skill.body?.trim() || undefined;
  }
  try {
    const raw = fs.readFileSync(skill.sourcePath, 'utf-8');
    const body = raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
    return body || skill.body?.trim() || undefined;
  } catch {
    return skill.body?.trim() || undefined;
  }
}

function formatSkillEnvelope(skill: SkillMeta, body: string): string {
  const truncated =
    body.length > MAX_BODY_CHARS
      ? `${body.slice(0, MAX_BODY_CHARS)}\n\n…[skill body truncated at ${MAX_BODY_CHARS} chars]`
      : body;
  return [
    `<skill name="${skill.name}" description="${escapeAttr(skill.description)}" path="${skill.sourcePath}">`,
    truncated,
    '</skill>',
    '',
    'Follow the skill instructions above for the current task. They are additional guidance, not a program to execute blindly.',
  ].join('\n');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, ' ').slice(0, 300);
}

function findSkill(registry: SkillRegistry, name: string): SkillMeta | undefined {
  const q = name.trim().toLowerCase();
  if (!q) return undefined;
  const skills = registry.list().filter((s) => s.enabled !== false);
  for (const s of skills) {
    const aliases = getSkillAliases(s);
    if (s.name.toLowerCase() === q || aliases.some((a) => a === q)) return s;
  }
  const contains = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      getSkillAliases(s).some((a) => a.includes(q))
  );
  if (contains.length === 1) return contains[0];
  return undefined;
}

function listSkillsText(registry: SkillRegistry, query?: string): string {
  let skills = registry.list().filter((s) => s.enabled !== false);
  const q = query?.trim().toLowerCase();
  if (q) {
    skills = skills.filter((s) => {
      const hay = `${s.name} ${s.description} ${s.tags.join(' ')} ${s.trigger.join(' ')}`.toLowerCase();
      return hay.includes(q) || getSkillAliases(s).some((a) => a.includes(q));
    });
  }
  if (skills.length === 0) {
    return q
      ? `No local skills match "${query}". Try skillhub_search to find marketplace skills.`
      : 'No local skills are registered.';
  }
  const lines = skills.map((s) => {
    const desc =
      s.description.length > MAX_LIST_DESC
        ? `${s.description.slice(0, MAX_LIST_DESC - 1)}…`
        : s.description;
    return `- ${s.name}: ${desc}`;
  });
  return [
    q ? `Local skills matching "${query}" (${skills.length}):` : `Local skills (${skills.length}):`,
    ...lines,
    '',
    'Call load_skill with a skill name to load full instructions.',
  ].join('\n');
}

export const loadSkillTool: Tool = {
  name: 'load_skill',
  description:
    'Load a skill\'s full instructions by name (Claude Code Skill / Grok skill tool parity). ' +
    'Use when a Skills index entry matches the task, or when you need domain guidance (coding workflows, RDK/ROS board work). ' +
    'Omit `name` or set list=true to list/search local skills. After skillhub_install, call this to activate the new skill.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Skill name/slug to load (e.g. code-review, rdk-ros, efficient-coding-loop).',
      },
      list: {
        type: 'boolean',
        description: 'If true, list local skills (optionally filtered by name as a query) instead of loading a body.',
      },
      query: {
        type: 'string',
        description: 'When list=true, optional filter against name/description/tags.',
      },
    },
  },
  async execute(input, ctx) {
    try {
      const registry = createRegistry(ctx);
      const listMode = input.list === true || (!input.name && !input.query);
      if (listMode) {
        return listSkillsText(
          registry,
          typeof input.query === 'string'
            ? input.query
            : typeof input.name === 'string'
              ? input.name
              : undefined
        );
      }
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name.trim()) {
        return listSkillsText(registry, typeof input.query === 'string' ? input.query : undefined);
      }
      const skill = findSkill(registry, name);
      if (!skill) {
        const similar = listSkillsText(registry, name);
        return `Error: skill "${name}" not found.\n\n${similar}\n\nTip: use skillhub_search to find marketplace skills, then skillhub_install.`;
      }
      const body = readBody(skill);
      if (!body) {
        return `Skill "${skill.name}" has no body (description only):\n${skill.description}`;
      }
      return formatSkillEnvelope(skill, body);
    } catch (err) {
      throw toolError('Error loading skill', err);
    }
  },
};

export const skillhubSearchTool: Tool = {
  name: 'skillhub_search',
  description:
    'Search the SkillHub marketplace (https://skillhub.cn) for installable skills. ' +
    'CN-first skill store for coding, robotics, and office workflows. ' +
    'After finding a useful slug, call skillhub_install then load_skill.',
  metadata: {
    // Marketplace search is read-only from the workspace POV (like web_search).
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords (e.g. "ros2", "code review", "pdf", "frontend").',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 10, max 50).',
      },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    try {
      const result = await skillHubSearch(String(input.query ?? ''), {
        limit: typeof input.limit === 'number' ? input.limit : 10,
        abortSignal: ctx.abortSignal,
      });
      if (!result.ok) return result.message;
      if (result.hits.length === 0) {
        if (result.raw) {
          return `SkillHub search returned no structured hits. Raw output:\n${result.raw.slice(0, 2000)}`;
        }
        return `No SkillHub skills matched "${input.query}". Try different keywords.`;
      }
      const lines = result.hits.map((h) => {
        const ver = h.version ? ` v${h.version}` : '';
        const src = h.source ? ` · ${h.source}` : '';
        const desc =
          h.description.length > 200 ? `${h.description.slice(0, 199)}…` : h.description;
        return `- ${h.slug}${ver}${src}: ${desc || h.name}`;
      });
      return [
        `SkillHub results for "${input.query}" (${result.hits.length}):`,
        ...lines,
        '',
        'Install with skillhub_install slug="<slug>", then load_skill name="<slug>".',
      ].join('\n');
    } catch (err) {
      throw toolError('Error searching SkillHub', err);
    }
  },
};

export const skillhubInstallTool: Tool = {
  name: 'skillhub_install',
  description:
    'Install a skill from SkillHub into the workspace `.moss/skills` directory so Moss can discover it. ' +
    'Requires the skillhub CLI (see https://skillhub.cn/install/skillhub.md). ' +
    'After install, call load_skill to load the skill body for this turn.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description: 'Skill slug from skillhub_search (e.g. "coding", "frontend-design").',
      },
      force: {
        type: 'boolean',
        description: 'Overwrite an existing install of the same slug (default false).',
      },
    },
    required: ['slug'],
  },
  async execute(input, ctx) {
    try {
      const result = await skillHubInstall(String(input.slug ?? ''), {
        workspaceDir: ctx.workspaceDir,
        force: input.force === true,
        abortSignal: ctx.abortSignal,
      });
      if (!result.ok) return result.message;
      return result.message;
    } catch (err) {
      throw toolError('Error installing SkillHub skill', err);
    }
  },
};
