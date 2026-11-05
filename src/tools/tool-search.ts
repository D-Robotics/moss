import {
  TOOL_SEARCH_NAME,
  deferredToolGroupNames,
  SUBAGENT_DEFERRED_TOOLS,
} from '../core/tools/deferred-tool-offer.js';
import type { Tool } from '../core/tools/tool-types.js';

/** Tool names per deferred group, for resolving a free-text query. */
const GROUP_TOOLS: Record<string, readonly string[]> = {
  subagent: SUBAGENT_DEFERRED_TOOLS,
};

/**
 * Claude Code's `ToolSearch` takes `query`, so a model trained there emits
 * `{query: "subagent tools"}`. Moss takes `group`; without this the undeclared
 * key is dropped and the call answers `unknown tool group ""`.
 */
function groupFromQuery(query: string): string | null {
  const q = query.toLowerCase();
  if (!q) return null;
  for (const group of deferredToolGroupNames()) {
    if (q.includes(group.toLowerCase())) return group;
    if (GROUP_TOOLS[group]?.some((name) => q.includes(name.toLowerCase()))) return group;
  }
  return null;
}

/**
 * One short meta-tool for the deferred sub-agent family. The five schemas
 * stay off the default request until the model asks for the group.
 */
export const toolSearchTool: Tool = {
  name: TOOL_SEARCH_NAME,
  description:
    'Load deferred tool schemas. group=subagent loads create_subagent, fan_out_subagents, subagent_status, subagent_stop, and merge_subagent_patch. ' +
    'Use that group for 3+ independent subtasks, a background child, an open-ended explore pass, or merging a sub-agent patch. ' +
    'Do not use it for a short answer or a single local edit. Empty child output is failure. ' +
    'Loaded tools are callable on the next model call.',
  metadata: {
    leanDescription:
      'Load deferred tool schemas; group=subagent for 3+ subtasks. Not for tools already declared.',
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      group: {
        type: 'string',
        enum: [...deferredToolGroupNames()],
        description: 'Deferred group to load. subagent: the five sub-agent tools.',
      },
    },
    required: ['group'],
  },
  async execute(input, ctx) {
    if (!ctx.revealDeferredTools) {
      return 'Error: deferred tools are not available in this context.';
    }
    const groups = deferredToolGroupNames();
    const requested = typeof input.group === 'string' ? input.group.trim() : '';
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    const group = requested || groupFromQuery(query) || '';
    if (!group) {
      const usage = groups
        .map((name) => `${name} (${(GROUP_TOOLS[name] ?? []).join(', ')})`)
        .join('; ');
      return (
        `Error: pass group to load deferred tools. Groups: ${usage}.` +
        (query ? ` Nothing matched query "${query}".` : '')
      );
    }
    return ctx.revealDeferredTools(group);
  },
};
