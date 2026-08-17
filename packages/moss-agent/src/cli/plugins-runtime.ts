import type { MossAgent } from '../core/agent/moss-agent.js';
import { errorMessage } from '../errors.js';
import { InstalledPluginRegistry } from '../plugins/installed-plugin-registry.js';

/** Install enabled trusted plugins while isolating manifest/import failures. @internal */
export async function installConfiguredPlugins(agent: MossAgent, configDir: string): Promise<void> {
  const loaded = await new InstalledPluginRegistry({ configDir }).loadEnabled();
  for (const plugin of loaded.plugins) {
    try {
      await agent.plugins.install(plugin);
    } catch (error) {
      console.error(`[plugins] ${plugin.id} was isolated: ${errorMessage(error)}`);
    }
  }
  for (const failure of loaded.failures) {
    console.error(`[plugins] ${failure.id} was isolated: ${failure.message}`);
  }
}
