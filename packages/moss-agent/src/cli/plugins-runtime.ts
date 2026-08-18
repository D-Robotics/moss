import type { MossAgent } from '../core/agent/moss-agent.js';
import { errorMessage } from '../errors.js';
import { InstalledPluginRegistry } from '../plugins/installed-plugin-registry.js';
import { connectMcpServers, type McpConnection } from '../mcp/index.js';
import type { LLMProvider } from '../core/llm/llm-provider.js';

/** Install enabled trusted plugins while isolating manifest/import failures. @internal */
export async function installConfiguredPlugins(agent: MossAgent, configDir: string): Promise<void> {
  const registry = new InstalledPluginRegistry({ configDir });
  const loaded = await registry.loadEnabled();
  for (const plugin of loaded.plugins) {
    try {
      await agent.plugins.install(plugin);
    } catch (error) {
      const installed = (await registry.list()).find(({ id }) => id === plugin.id);
      if (installed?.lastGood) {
        try {
          const restored = await registry.rollback(plugin.id);
          await agent.plugins.install(await registry.loadInstalled(plugin.id));
          console.warn(
            `[plugins] ${plugin.id}@${installed.version} was isolated; last-good ${restored.version} was restored: ${errorMessage(error)}`
          );
          continue;
        } catch (recoveryError) {
          console.error(
            `[plugins] ${plugin.id} candidate and last-good recovery failed: ${errorMessage(recoveryError)}`
          );
          continue;
        }
      }
      console.error(`[plugins] ${plugin.id} was isolated: ${errorMessage(error)}`);
    }
  }
  for (const failure of loaded.failures) {
    if (failure.recovered) console.warn(`[plugins] ${failure.id}: ${failure.message}`);
    else console.error(`[plugins] ${failure.id} was isolated: ${failure.message}`);
  }
}

/** Instantiate a plugin provider through the host's active-call lease. @internal */
export async function createPluginProvider(
  agent: MossAgent,
  providerId: string,
  config: Readonly<Record<string, unknown>>
): Promise<LLMProvider> {
  const provider = await agent.plugins.createProvider(providerId, config);
  if (!provider) throw new Error(`plugin provider not found: ${providerId}`);
  return provider;
}

/** Connect a contributed MCP preset and publish its tools into the live agent. @internal */
export async function registerPluginMcpPresetTools(
  agent: MossAgent,
  presetId: string
): Promise<McpConnection[]> {
  const activated = await agent.plugins.activateMcpPreset(presetId, async (preset) => {
    const connections = await connectMcpServers({
      mcpServers: {
        [preset.id]: {
          command: preset.server.command,
          ...(preset.server.args ? { args: [...preset.server.args] } : {}),
          ...(preset.server.env ? { env: { ...preset.server.env } } : {}),
          ...(preset.server.cwd ? { cwd: preset.server.cwd } : {}),
          ...(preset.server.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: preset.server.requestTimeoutMs }
            : {}),
        },
      },
    });
    const toolDisposers: Array<() => void> = [];
    try {
      for (const connection of connections) {
        for (const tool of connection.tools) {
          toolDisposers.push(agent.tools.registerScoped(tool, `plugin-mcp:${preset.id}`));
        }
      }
    } catch (error) {
      for (const dispose of toolDisposers.reverse()) dispose();
      await Promise.allSettled(connections.map((connection) => connection.close()));
      throw error;
    }
    return {
      value: connections,
      dispose: async () => {
        for (const dispose of toolDisposers.reverse()) dispose();
        await Promise.allSettled(connections.map((connection) => connection.close()));
      },
    };
  });
  if (!activated) throw new Error(`plugin MCP preset not found: ${presetId}`);
  return activated;
}
