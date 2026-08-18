import { parentPort, workerData } from 'node:worker_threads';
import type {
  MossPlugin,
  MossPluginCommand,
  MossPluginDisposer,
  MossPluginMcpPreset,
  MossPluginProvider,
  MossWebContribution,
} from '../core/plugins/plugin-host.js';
import type { LLMProvider, LLMRequestOptions, LLMStreamEvent } from '../core/llm/llm-provider.js';
import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import type { SkillMeta } from '../skills/types.js';
import type { SubagentExpertDefinition } from '../core/subagent/expert-registry.js';
import type { AgentRoleDefinition } from '../orchestration/agent-role-types.js';

interface PluginSetupWorkerData {
  readonly moduleUrl: string;
  readonly exportName: string;
  readonly expectedId: string;
  readonly pluginConfig?: Readonly<Record<string, unknown>>;
}

interface RpcRequest {
  readonly type: 'call';
  readonly requestId: number;
  readonly method: string;
  readonly target?: string;
  readonly args: readonly unknown[];
}

const tools = new Map<string, Tool>();
const commands = new Map<string, MossPluginCommand>();
const providerFactories = new Map<string, MossPluginProvider>();
const providers = new Map<string, LLMProvider>();
const mcpPresets: MossPluginMcpPreset[] = [];
const skills: SkillMeta[] = [];
const experts: SubagentExpertDefinition[] = [];
const agentRoles: AgentRoleDefinition[] = [];
const promptLayers: string[] = [];
const webContributions: MossWebContribution[] = [];
const effects: Array<() => MossPluginDisposer | Promise<MossPluginDisposer>> = [];
const disposers: MossPluginDisposer[] = [];
let providerSequence = 0;
const callControllers = new Map<number, AbortController>();

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  return cause instanceof Error && cause.message !== error.message
    ? `${error.message}: ${cause.message}`
    : error.message;
}

function cloneableTool(tool: Tool): Record<string, unknown> {
  if (tool.normalizeInput)
    throw new Error(`isolated plugin tool cannot use normalizeInput: ${tool.name}`);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.metadata ? { metadata: tool.metadata } : {}),
    structured: typeof tool.executeStructured === 'function',
  };
}

async function setup(): Promise<void> {
  const data = workerData as PluginSetupWorkerData;
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
  const returned = await plugin.setup({
    config: Object.freeze({ ...(data.pluginConfig ?? {}) }),
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerSkill(skill) {
      skills.push(skill);
    },
    registerExpert(expert) {
      experts.push(expert);
    },
    registerAgentRole(role) {
      agentRoles.push(role);
    },
    registerCommand(command) {
      commands.set(command.id, command);
    },
    registerProvider(provider) {
      providerFactories.set(provider.id, provider);
    },
    registerMcpPreset(preset) {
      mcpPresets.push(preset);
    },
    addPromptLayer(layer) {
      promptLayers.push(layer);
    },
    registerWebContribution(contribution) {
      webContributions.push(contribution);
    },
    effect(effect) {
      effects.push(effect);
    },
  });
  if (typeof returned === 'function') disposers.push(returned);
  for (const effect of effects) disposers.push(await effect());
  parentPort!.postMessage({
    type: 'ready',
    contributions: {
      tools: [...tools.values()].map(cloneableTool),
      skills,
      experts,
      agentRoles,
      commands: [...commands.values()].map(({ id, title, description }) => ({
        id,
        title,
        ...(description ? { description } : {}),
      })),
      providers: [...providerFactories.values()].map(({ id, displayName }) => ({
        id,
        displayName,
      })),
      mcpPresets,
      promptLayers,
      webContributions,
    },
  });
}

function toolContext(value: unknown, abortSignal: AbortSignal): ToolContext {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    workspaceDir: typeof input.workspaceDir === 'string' ? input.workspaceDir : process.cwd(),
    sessionKey: typeof input.sessionKey === 'string' ? input.sessionKey : 'plugin-worker',
    abortSignal,
    ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
    ...(typeof input.runId === 'string' ? { runId: input.runId } : {}),
    ...(typeof input.toolCallId === 'string' ? { toolCallId: input.toolCallId } : {}),
  };
}

async function call(request: RpcRequest): Promise<unknown> {
  const controller = new AbortController();
  callControllers.set(request.requestId, controller);
  try {
    if (request.method === 'tool.execute' || request.method === 'tool.executeStructured') {
      const tool = tools.get(request.target ?? '');
      if (!tool) throw new Error(`isolated plugin tool not found: ${request.target}`);
      const input = request.args[0];
      const context = toolContext(request.args[1], controller.signal);
      return request.method === 'tool.executeStructured'
        ? tool.executeStructured?.(input, context)
        : tool.execute(input, context);
    }
    if (request.method === 'command.expand') {
      const command = commands.get(request.target ?? '');
      if (!command) throw new Error(`isolated plugin command not found: ${request.target}`);
      return command.expand(String(request.args[0] ?? ''));
    }
    if (request.method === 'provider.create') {
      const factory = providerFactories.get(request.target ?? '');
      if (!factory) throw new Error(`isolated plugin provider not found: ${request.target}`);
      const provider = await factory.create((request.args[0] ?? {}) as Record<string, unknown>);
      const providerId = `provider-${++providerSequence}`;
      providers.set(providerId, provider);
      return {
        providerId,
        id: provider.id,
        displayName: provider.displayName,
        capabilities: provider.capabilities,
        countTokens: typeof provider.countTokens === 'function',
      };
    }
    const provider = providers.get(request.target ?? '');
    if (!provider) throw new Error(`isolated provider instance not found: ${request.target}`);
    if (request.method === 'provider.complete') {
      return provider.complete({
        ...(request.args[0] as LLMRequestOptions),
        abortSignal: controller.signal,
      });
    }
    if (request.method === 'provider.countTokens')
      return provider.countTokens?.(String(request.args[0] ?? ''));
    if (request.method === 'provider.stream') {
      return provider.stream(
        {
          ...(request.args[0] as LLMRequestOptions),
          abortSignal: controller.signal,
        },
        (event: LLMStreamEvent) => {
          parentPort!.postMessage({ type: 'event', requestId: request.requestId, event });
        }
      );
    }
    throw new Error(`unknown isolated plugin RPC method: ${request.method}`);
  } finally {
    callControllers.delete(request.requestId);
  }
}

if (!parentPort) throw new Error('plugin setup worker requires a parent port');

parentPort.on('message', (message: unknown) => {
  if (
    message &&
    typeof message === 'object' &&
    (message as Record<string, unknown>).type === 'cancel'
  ) {
    const requestId = (message as Record<string, unknown>).requestId;
    if (typeof requestId === 'number') callControllers.get(requestId)?.abort();
    return;
  }
  if (
    message &&
    typeof message === 'object' &&
    (message as Record<string, unknown>).type === 'dispose'
  ) {
    void (async () => {
      for (const dispose of [...disposers].reverse()) await dispose();
      parentPort!.postMessage({ type: 'disposed' });
    })().catch((error: unknown) => {
      parentPort!.postMessage({ type: 'dispose-error', message: errorMessage(error) });
    });
    return;
  }
  if (
    !message ||
    typeof message !== 'object' ||
    (message as Record<string, unknown>).type !== 'call'
  )
    return;
  const request = message as RpcRequest;
  void call(request).then(
    (value) => parentPort!.postMessage({ type: 'result', requestId: request.requestId, value }),
    (error: unknown) =>
      parentPort!.postMessage({
        type: 'error',
        requestId: request.requestId,
        message: errorMessage(error),
      })
  );
});

try {
  await setup();
} catch (error) {
  parentPort.postMessage({ type: 'setup-error', message: errorMessage(error) });
}
