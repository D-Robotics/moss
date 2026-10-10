/**
 * `moss trust list|remove` — manage the user folder-trust store.
 * CliPhase.None: no project config load and no trust prompt.
 */
import { isZhLocale } from './cli-locale.js';
import { resolveConfigDir, safeProcessCwd } from './config.js';
import { ExitCode } from './exit-codes.js';
import { forgetFolderTrust, isFilesystemRoot, listTrustedFolders } from './folder-trust-store.js';
import { chrome } from './tui/copy.js';
import { resolveFolderKey } from './workspace-trust.js';

export async function runTrustCommand(args: readonly string[]): Promise<number> {
  const zh = isZhLocale();
  const sub = (args[0] ?? 'list').trim().toLowerCase();
  const configDir = resolveConfigDir();
  if (sub === 'list') {
    const folders = listTrustedFolders(configDir);
    if (folders.length === 0) {
      console.log(chrome('No trusted folders.', zh));
      return ExitCode.SUCCESS;
    }
    for (const folder of folders) console.log(folder);
    return ExitCode.SUCCESS;
  }
  if (sub === 'remove') {
    const target = args[1] ? args[1] : await resolveFolderKey(safeProcessCwd());
    if (isFilesystemRoot(target)) {
      console.error(chrome('The filesystem root is not remembered as trusted.', zh));
      return ExitCode.USAGE;
    }
    const removed = forgetFolderTrust(configDir, target);
    if (!removed) {
      console.error(chrome('This folder is not trusted.', zh));
      return ExitCode.USAGE;
    }
    console.log(
      chrome('Removed trust for {path}. It applies the next time Moss starts.', zh, {
        path: removed,
      })
    );
    return ExitCode.SUCCESS;
  }
  console.error('Usage: moss trust <list|remove [path]>');
  return ExitCode.USAGE;
}
