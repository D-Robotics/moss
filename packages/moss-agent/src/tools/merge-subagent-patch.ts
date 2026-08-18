import type { Tool } from '../core/tools/tool-types.js';

interface MergeSubagentPatchInput {
  leaseId: string;
  patchId: string;
}

/** Approval-gated parent merge for an adapter-owned isolated-worker artifact. @beta */
export const mergeSubagentPatchTool: Tool<MergeSubagentPatchInput> = {
  name: 'merge_subagent_patch',
  description:
    'Merge a completed full-scope sub-agent patch into the parent workspace. Use the lease and patchId returned by create_subagent. The stored artifact, declared write paths, parent baseline, and host approval are revalidated before mutation.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'allow',
    requiresApproval: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      leaseId: { type: 'string', description: 'Workspace lease returned by the sub-agent.' },
      patchId: { type: 'string', description: 'Stored patch ID returned by the sub-agent.' },
    },
    required: ['leaseId', 'patchId'],
  },
  async execute(input, ctx) {
    if (!ctx.mergeWorkspacePatch) return 'Error: workspace patch merging is unavailable.';
    const result = await ctx.mergeWorkspacePatch(input.leaseId, input.patchId);
    if (result.status === 'merge_conflict') {
      return `Error: sub-agent patch has parent conflicts: ${result.conflictingPaths.join(', ')}`;
    }
    return `Merged sub-agent patch ${input.patchId} from lease ${input.leaseId}.`;
  },
};
