import fs from 'node:fs';
import path from 'node:path';
import { runTuiApp } from '../../dist/cli/tui/app.js';
import { formatWorkspaceMigrationNotices } from '../../dist/cli/workspace-migration-notice.js';
import { createTuiNoticeSource } from '../../dist/cli/tui-notice-source.js';
import { migrateLegacyWorkspacePaths } from '../../dist/utils/workspace-paths.js';

const workspace = process.argv.at(-1);
const originalRmdir = fs.rmdirSync;
if (process.env.MOSS_TUI_TEST_CLEANUP === '1') {
  const target = path.join(workspace, 'agent');
  fs.rmdirSync = function (dir, ...args) {
    if (dir === target) {
      const error = new Error('synthetic cleanup failure');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRmdir.call(this, dir, ...args);
  };
}
let migration;
try {
  migration = migrateLegacyWorkspacePaths(workspace);
} finally {
  fs.rmdirSync = originalRmdir;
}
const pending = formatWorkspaceMigrationNotices(
  migration.skippedPaths.length > 0,
  migration.cleanupWarnings.length > 0,
  false
);
for (const message of pending) console.error(message);
const noticeSource = createTuiNoticeSource(pending);
const agent = {
  config: {},
  asyncTasks: { list: () => [] },
  async *streamChat() {},
};

await runTuiApp({
  agent,
  workspaceDir: workspace,
  sessionKey: 'fixture',
  model: 'mock',
  locale: 'en',
  noticeSource,
});
