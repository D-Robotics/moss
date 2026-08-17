import { resolveConfigDir } from './config.js';
import { ExitCode } from './exit-codes.js';
import { errorMessage } from '../errors.js';
import { InstalledPluginRegistry } from '../plugins/installed-plugin-registry.js';

export const PLUGINS_USAGE =
  'Usage: moss plugins <list|add <path-or-package>|remove <id>|enable <id>|disable <id>|doctor>';

/** Run the explicit trusted-plugin management command. @internal */
export async function runPluginsCommand(args: readonly string[]): Promise<void> {
  const registry = new InstalledPluginRegistry({ configDir: resolveConfigDir() });
  const command = args[0] ?? 'list';
  try {
    if (command === 'list') {
      const entries = await registry.list();
      if (entries.length === 0) {
        console.log('No Moss plugins installed.');
        return;
      }
      console.log('PLUGIN                           VERSION       STATE     SOURCE');
      for (const entry of entries) {
        console.log(
          `${entry.id.padEnd(32)} ${entry.version.padEnd(13)} ${(entry.enabled ? 'enabled' : 'disabled').padEnd(9)} ${entry.source}`
        );
      }
      return;
    }
    if (command === 'doctor') {
      const report = await registry.doctor();
      if (report.length === 0) console.log('No Moss plugins installed.');
      for (const result of report)
        console.log(`${result.status.toUpperCase().padEnd(8)} ${result.id}: ${result.message}`);
      if (report.some(({ status }) => status === 'error')) process.exitCode = ExitCode.CONFIG;
      return;
    }
    const target = args[1];
    if (!target) {
      console.error(PLUGINS_USAGE);
      process.exitCode = ExitCode.USAGE;
      return;
    }
    if (command === 'add') {
      const entry = await registry.add(target);
      console.log(
        `[plugins] Installed ${entry.id}@${entry.version} disabled. Review it, then run: moss plugins enable ${entry.id}`
      );
      return;
    }
    if (command === 'remove') await registry.remove(target);
    else if (command === 'enable') await registry.enable(target);
    else if (command === 'disable') await registry.disable(target);
    else {
      console.error(PLUGINS_USAGE);
      process.exitCode = ExitCode.USAGE;
      return;
    }
    console.log(`[plugins] ${command}d ${target}.`);
  } catch (error) {
    console.error(`[plugins] ${errorMessage(error)}`);
    process.exitCode = ExitCode.CONFIG;
  }
}
