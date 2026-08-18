import type { MossAgent } from '../core/agent/moss-agent.js';
import type { MossPlugin } from '../core/plugins/plugin-host.js';
import { ErrorCode, MossError } from '../errors.js';
import { importDshPackage } from '../plugins/dsh-bundle-compatibility.js';
import type { MossPluginConfigSchema } from '../plugins/plugin-config-schema.js';
import { readMossPluginConfigSchema } from '../plugins/plugin-config-store.js';
import type { MossPluginConfigStore } from '../plugins/plugin-config-store.js';
import type {
  InstalledMossPlugin,
  InstalledPluginRegistry,
} from '../plugins/installed-plugin-registry.js';

/** Resolve the schema of one installed plugin without exposing secret values. @internal */
export async function installedPluginSchema(
  entry: InstalledMossPlugin
): Promise<MossPluginConfigSchema | undefined> {
  return entry.format === 'dsh-package-v1'
    ? (await importDshPackage(entry.root)).configSchema
    : readMossPluginConfigSchema(entry.root);
}

function active(agent: MossAgent, pluginId: string): boolean {
  return agent.plugins
    .inspect()
    .plugins.some(({ id, state }) => id === pluginId && state === 'active');
}

/** Activate a same-id immutable npm candidate and restore last-good on failure. @internal */
export async function activateWebPluginCandidate(
  agent: MossAgent,
  registry: InstalledPluginRegistry,
  entry: InstalledMossPlugin,
  wasActive: boolean
): Promise<void> {
  if (!entry.lastGood || !entry.enabled) return;
  let candidate: MossPlugin | undefined;
  try {
    candidate = await registry.loadInstalled(entry.id);
  } catch (error) {
    await registry.rollback(entry.id);
    throw error;
  }
  if (wasActive) {
    try {
      await agent.plugins.unload(entry.id);
    } catch (error) {
      await discard(candidate);
      await registry.rollback(entry.id);
      throw error;
    }
  }
  try {
    await agent.plugins.install(candidate);
  } catch (error) {
    await registry.rollback(entry.id);
    if (wasActive) await restoreRuntime(agent, registry, entry.id);
    throw error;
  }
}

async function discard(candidate: MossPlugin | undefined): Promise<void> {
  await candidate?.disposeCandidate?.();
}

async function restoreRuntime(
  agent: MossAgent,
  registry: InstalledPluginRegistry,
  pluginId: string
): Promise<void> {
  const rollback = await registry.loadInstalled(pluginId);
  await agent.plugins.install(rollback);
}

/** Enable and activate one statically validated candidate exactly once. @internal */
export async function enableWebPlugin(
  agent: MossAgent,
  registry: InstalledPluginRegistry,
  pluginId: string
): Promise<void> {
  if (active(agent, pluginId)) {
    await registry.enable(pluginId);
    return;
  }
  const candidate = await registry.loadInstalled(pluginId);
  try {
    await registry.enable(pluginId);
  } catch (error) {
    await discard(candidate);
    throw error;
  }
  try {
    await agent.plugins.install(candidate);
  } catch (error) {
    await registry.disable(pluginId).catch(() => {});
    throw error;
  }
}

/** Disable one generation and restore it if the registry commit fails. @internal */
export async function disableWebPlugin(
  agent: MossAgent,
  registry: InstalledPluginRegistry,
  pluginId: string
): Promise<void> {
  const wasActive = active(agent, pluginId);
  if (wasActive) await agent.plugins.unload(pluginId);
  try {
    await registry.disable(pluginId);
  } catch (error) {
    if (wasActive) await restoreRuntime(agent, registry, pluginId);
    throw error;
  }
}

/** Remove one generation and restore it if the registry commit fails. @internal */
export async function removeWebPlugin(
  agent: MossAgent,
  registry: InstalledPluginRegistry,
  pluginId: string
): Promise<void> {
  const wasActive = active(agent, pluginId);
  if (wasActive) await agent.plugins.unload(pluginId);
  try {
    await registry.remove(pluginId);
  } catch (error) {
    if (wasActive) await restoreRuntime(agent, registry, pluginId);
    throw error;
  }
}

/** Persist config, prepare one candidate, drain old calls, and roll back on failure. @internal */
export async function mutateWebPluginConfig(
  agent: MossAgent,
  registry: InstalledPluginRegistry,
  store: MossPluginConfigStore,
  entry: InstalledMossPlugin,
  schema: MossPluginConfigSchema,
  mutation: () => Promise<void>
): Promise<void> {
  if (!active(agent, entry.id)) {
    await mutation();
    return;
  }
  const before = await store.loadRuntimeConfig(entry.id, schema);
  await mutation();

  let candidate: MossPlugin | undefined;
  try {
    candidate = await registry.loadInstalled(entry.id);
  } catch (error) {
    await store.replaceRuntimeConfig(entry.id, schema, before);
    throw error;
  }

  try {
    await agent.plugins.unload(entry.id);
  } catch (error) {
    await discard(candidate);
    await store.replaceRuntimeConfig(entry.id, schema, before);
    throw error;
  }

  try {
    await agent.plugins.install(candidate);
  } catch (activationError) {
    await store.replaceRuntimeConfig(entry.id, schema, before);
    try {
      await restoreRuntime(agent, registry, entry.id);
    } catch (rollbackError) {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: `plugin config activation and rollback failed: ${entry.id}`,
        cause: new AggregateError([activationError, rollbackError]),
        context: { pluginId: entry.id },
      });
    }
    throw activationError;
  }
}
