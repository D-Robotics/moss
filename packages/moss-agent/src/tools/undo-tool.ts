/**
 * Undo tool — restores files to their pre-modification state using the
 * auto-backup system.
 */
import type { Tool } from '../core/tools/tool-types.js';
import { globalBackupManager } from './backup-manager.js';
import { toolError } from './tool-helpers.js';

export const undoTool: Tool = {
  name: 'undo',
  description:
    'Undo the most recent file modification (write_file, edit_file, or apply_patch). ' +
    'Restores the file to its pre-modification content from the auto-backup. ' +
    'Call repeatedly to undo multiple changes in reverse order.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of changes to undo (default: 1, max: 10)',
      },
    },
  },
  async execute(input, ctx) {
    try {
      const count = Math.min(Number(input.count) || 1, 10);
      const backups = globalBackupManager.getBackups();
      if (backups.length === 0) {
        return 'Nothing to undo — no backups available.';
      }

      const undone: string[] = [];
      for (let i = 0; i < count; i++) {
        const restored = await globalBackupManager.undoLast(ctx.workspaceDir);
        if (restored) {
          undone.push(restored);
        } else {
          break;
        }
      }

      if (undone.length === 0) {
        return 'Nothing to undo — no backups available.';
      }

      return `Undid ${undone.length} change(s):\n${undone.map((f) => `  - ${f}`).join('\n')}`;
    } catch (err) {
      throw toolError('Error undoing changes', err);
    }
  },
};