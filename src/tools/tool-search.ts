import { TOOL_SEARCH_NAME, deferredToolGroupNames } from '../core/tools/deferred-tool-offer.js';
import type { Tool } from '../core/tools/tool-types.js';

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
    const group = typeof input.group === 'string' ? input.group.trim() : '';
    if (!ctx.revealDeferredTools) {
      return 'Error: deferred tools are not available in this context.';
    }
    return ctx.revealDeferredTools(group);
  },
};
