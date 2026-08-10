import type { MossAgent } from '../core/index.js';
import type { ResolvedCliConfig } from './config.js';
import { connectMcpServers, loadMcpConfig, type McpConnection } from '../mcp/index.js';

export async function registerMcpConnectionTools(
  agent: Pick<MossAgent, 'tools'>,
  connections: McpConnection[]
): Promise<McpConnection[]> {
  try {
    for (const connection of connections) {
      for (const tool of connection.tools) {
        agent.tools.register(tool, `mcp:${connection.serverName}`);
      }
    }
    return connections;
  } catch (error) {
    await Promise.allSettled(connections.map((connection) => connection.close()));
    throw error;
  }
}

export async function registerConfiguredMcpTools(
  agent: Pick<MossAgent, 'tools'>,
  config: Pick<ResolvedCliConfig, 'mcpEnabled' | 'mcpConfigPath'>
): Promise<McpConnection[]> {
  if (!config.mcpEnabled) return [];
  const mcpConfig = loadMcpConfig(config.mcpConfigPath);
  if (!mcpConfig) {
    console.warn(
      `[mcp:config] MCP is enabled but no valid config was found at ${config.mcpConfigPath}`
    );
    return [];
  }
  const connections = await connectMcpServers(mcpConfig);
  return registerMcpConnectionTools(agent, connections);
}
