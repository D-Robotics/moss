import { reservedBuiltinNames } from './commands/custom-commands.js';

interface PluginCommandSource {
  listCommands(): readonly {
    readonly id: string;
    readonly title: string;
    readonly description?: string;
  }[];
  expandCommand(id: string, args: string): Promise<string | undefined>;
}

export function pluginCommandRows(
  plugins: PluginCommandSource
): ReadonlyArray<readonly [string, string]> {
  return plugins
    .listCommands()
    .filter(({ id }) => !reservedBuiltinNames().has(`/${id}`))
    .map(({ id, description, title }) => [`/${id}`, description ?? title]);
}

export async function dispatchPlugin(
  message: string,
  plugins: PluginCommandSource,
  submit: (prompt: string) => void
): Promise<boolean> {
  const [id = '', ...args] = message.slice(1).split(/\s+/);
  if (reservedBuiltinNames().has(`/${id}`)) return false;
  const expanded = await plugins.expandCommand(id, args.join(' '));
  if (expanded === undefined) return false;
  submit(expanded);
  return true;
}
