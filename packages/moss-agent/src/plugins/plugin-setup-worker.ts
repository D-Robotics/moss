import { parentPort, workerData } from 'node:worker_threads';
import { createMossPluginHost, type MossPlugin } from '../core/plugins/plugin-host.js';

interface PluginSetupWorkerData {
  readonly moduleUrl: string;
  readonly exportName: string;
  readonly expectedId: string;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

async function validateSetup(data: PluginSetupWorkerData): Promise<void> {
  const imported = (await import(data.moduleUrl)) as Record<string, unknown>;
  const candidate = imported[data.exportName];
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof (candidate as MossPlugin).setup !== 'function'
  ) {
    throw new Error(`plugin ${data.expectedId} did not export a MossPlugin`);
  }
  const plugin = candidate as MossPlugin;
  if (plugin.id !== data.expectedId) {
    throw new Error(`plugin export id does not match manifest: ${data.expectedId}`);
  }

  const tools = new Set<string>();
  const skills = new Set<string>();
  const experts = new Set<string>();
  const host = createMossPluginHost({
    hasTool: (name) => tools.has(name),
    registerTool: (tool) => {
      tools.add(tool.name);
      return () => {
        tools.delete(tool.name);
      };
    },
    hasSkill: (id) => skills.has(id),
    registerSkill: (skill) => {
      const id = skill.stableId ?? skill.name;
      skills.add(id);
      return () => {
        skills.delete(id);
      };
    },
    hasExpert: (id) => experts.has(id),
    registerExpert: (expert) => {
      experts.add(expert.id);
      return () => {
        experts.delete(expert.id);
      };
    },
  });
  try {
    await host.install(plugin);
  } finally {
    await host.close();
  }
}

if (!parentPort) throw new Error('plugin setup worker requires a parent port');

try {
  await validateSetup(workerData as PluginSetupWorkerData);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: errorMessage(error) });
}
