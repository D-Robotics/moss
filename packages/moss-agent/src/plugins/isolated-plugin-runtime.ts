import { Worker } from 'node:worker_threads';
import { ErrorCode, MossError } from '../errors.js';
import type {
  MossPlugin,
  MossPluginContext,
  MossPluginMcpPreset,
  MossWebContribution,
} from '../core/plugins/plugin-host.js';
import type {
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LLMStreamEvent,
} from '../core/llm/llm-provider.js';
import type { SkillMeta } from '../skills/types.js';
import type { SubagentExpertDefinition } from '../core/subagent/expert-registry.js';
import type { StructuredToolResult, ToolContext, ToolMetadata } from '../core/tools/tool-types.js';

interface IsolatedContributions {
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
    readonly metadata?: ToolMetadata;
    readonly structured: boolean;
  }>;
  readonly skills: readonly SkillMeta[];
  readonly experts: readonly SubagentExpertDefinition[];
  readonly commands: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description?: string;
  }>;
  readonly providers: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
  readonly mcpPresets: readonly MossPluginMcpPreset[];
  readonly promptLayers: readonly string[];
  readonly webContributions: readonly MossWebContribution[];
}

interface ReadyMessage {
  readonly type: 'ready';
  readonly contributions: IsolatedContributions;
}

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly onEvent?: (event: LLMStreamEvent) => void;
  readonly removeAbortListener?: () => void;
}

function pluginError(message: string): MossError {
  return new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
}

function serializableToolContext(context: ToolContext): Record<string, unknown> {
  // Host callbacks (subagents, output sinks, async registries) are deliberately
  // not exposed across the trust boundary. Isolated plugins must contribute an
  // ordinary Tool and let the host's pre-tool approval layer make decisions.
  return {
    workspaceDir: context.workspaceDir,
    sessionKey: context.sessionKey,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.toolCallId ? { toolCallId: context.toolCallId } : {}),
  };
}

function serializableLlmOptions(
  options: LLMRequestOptions
): Omit<LLMRequestOptions, 'abortSignal'> {
  const { abortSignal: _, ...serializable } = options;
  return serializable;
}

class IsolatedPluginWorker {
  private readonly pending = new Map<number, PendingCall>();
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly worker: Worker,
    readonly contributions: IsolatedContributions,
    private readonly pluginId: string
  ) {
    worker.on('message', (message: unknown) => this.handleMessage(message));
    worker.on('error', (error) => {
      this.closed = true;
      this.failPending(pluginError(`isolated plugin ${pluginId} failed: ${error.message}`));
    });
    worker.on('exit', (code) => {
      if (!this.closed) {
        this.closed = true;
        this.failPending(pluginError(`isolated plugin ${pluginId} exited with code ${code}`));
      }
    });
  }

  call<T>(
    method: string,
    target: string | undefined,
    args: readonly unknown[],
    onEvent?: (event: LLMStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<T> {
    if (this.closed)
      return Promise.reject(pluginError(`isolated plugin is disposed: ${this.pluginId}`));
    const requestId = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.worker.postMessage({ type: 'cancel', requestId });
        this.pending.delete(requestId);
        if (this.pending.size === 0) this.worker.unref();
        reject(new MossError({ code: ErrorCode.USER_ABORTED, message: 'plugin call aborted' }));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      this.worker.ref();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        ...(onEvent ? { onEvent } : {}),
        ...(signal
          ? { removeAbortListener: () => signal.removeEventListener('abort', abort) }
          : {}),
      });
      try {
        this.worker.postMessage({ type: 'call', requestId, method, target, args });
      } catch (error) {
        this.pending.delete(requestId);
        if (this.pending.size === 0) this.worker.unref();
        signal?.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : pluginError(String(error)));
      }
    });
  }

  async close(timeoutMs = 1_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const disposed = new Promise<void>((resolve, reject) => {
      const onMessage = (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const type = (message as Record<string, unknown>).type;
        if (type !== 'disposed' && type !== 'dispose-error') return;
        this.worker.off('message', onMessage);
        if (type === 'dispose-error') {
          reject(pluginError(String((message as Record<string, unknown>).message)));
        } else {
          resolve();
        }
      };
      this.worker.on('message', onMessage);
      this.worker.postMessage({ type: 'dispose' });
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        disposed,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(pluginError(`isolated plugin dispose timed out: ${this.pluginId}`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.failPending(pluginError(`isolated plugin is disposed: ${this.pluginId}`));
      await this.worker.terminate();
    }
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const value = message as Record<string, unknown>;
    const requestId = value.requestId;
    if (typeof requestId !== 'number') return;
    const pending = this.pending.get(requestId);
    if (!pending) return;
    if (value.type === 'event') {
      pending.onEvent?.(value.event as LLMStreamEvent);
      return;
    }
    this.pending.delete(requestId);
    if (this.pending.size === 0) this.worker.unref();
    pending.removeAbortListener?.();
    if (value.type === 'result') pending.resolve(value.value);
    else pending.reject(pluginError(String(value.message ?? 'isolated plugin call failed')));
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.removeAbortListener?.();
      pending.reject(error);
    }
    this.pending.clear();
    this.worker.unref();
  }
}

async function startWorker(
  moduleUrl: string,
  exportName: string,
  pluginId: string,
  timeoutMs: number,
  pluginConfig: Readonly<Record<string, unknown>>
): Promise<IsolatedPluginWorker> {
  const worker = new Worker(new URL('./plugin-setup-worker.js', import.meta.url), {
    workerData: { moduleUrl, exportName, expectedId: pluginId, pluginConfig },
  });
  worker.unref();
  let timer: NodeJS.Timeout | undefined;
  let onStartupMessage: ((message: unknown) => void) | undefined;
  let onStartupError: ((error: Error) => void) | undefined;
  try {
    const contributions = await new Promise<IsolatedContributions>((resolve, reject) => {
      onStartupError = reject;
      worker.once('error', onStartupError);
      onStartupMessage = (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        const value = message as Record<string, unknown>;
        if (value.type === 'ready') resolve((message as ReadyMessage).contributions);
        if (value.type === 'setup-error') reject(pluginError(String(value.message)));
      };
      worker.on('message', onStartupMessage);
      timer = setTimeout(
        () =>
          reject(
            pluginError(
              `plugin setup validation timed out after ${
                timeoutMs % 1_000 === 0
                  ? `${timeoutMs / 1_000} seconds`
                  : `${timeoutMs} milliseconds`
              }`
            )
          ),
        timeoutMs
      );
    });
    return new IsolatedPluginWorker(worker, contributions, pluginId);
  } catch (error) {
    await worker.terminate();
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onStartupMessage) worker.off('message', onStartupMessage);
    if (onStartupError) worker.off('error', onStartupError);
  }
}

function remoteProvider(
  runtime: IsolatedPluginWorker,
  metadata: {
    readonly providerId: string;
    readonly id: string;
    readonly displayName: string;
    readonly capabilities?: LLMProvider['capabilities'];
    readonly countTokens: boolean;
  }
): LLMProvider {
  return {
    id: metadata.id,
    displayName: metadata.displayName,
    ...(metadata.capabilities ? { capabilities: metadata.capabilities } : {}),
    complete: (options) =>
      runtime.call<LLMResponse>(
        'provider.complete',
        metadata.providerId,
        [serializableLlmOptions(options)],
        undefined,
        options.abortSignal
      ),
    stream: (options, onEvent) =>
      runtime.call<LLMResponse>(
        'provider.stream',
        metadata.providerId,
        [serializableLlmOptions(options)],
        onEvent,
        options.abortSignal
      ),
    ...(metadata.countTokens
      ? {
          countTokens: (text: string) =>
            runtime.call<number>('provider.countTokens', metadata.providerId, [text]),
        }
      : {}),
  };
}

function registerRemoteContributions(
  context: MossPluginContext,
  runtime: IsolatedPluginWorker
): void {
  for (const tool of runtime.contributions.tools) {
    context.registerTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.metadata ? { metadata: tool.metadata } : {}),
      execute: (input, toolContext) =>
        runtime.call<string>(
          'tool.execute',
          tool.name,
          [input, serializableToolContext(toolContext)],
          undefined,
          toolContext.abortSignal
        ),
      ...(tool.structured
        ? {
            executeStructured: (input: unknown, toolContext: ToolContext) =>
              runtime.call<StructuredToolResult>(
                'tool.executeStructured',
                tool.name,
                [input, serializableToolContext(toolContext)],
                undefined,
                toolContext.abortSignal
              ),
          }
        : {}),
    });
  }
  for (const skill of runtime.contributions.skills) context.registerSkill(skill);
  for (const expert of runtime.contributions.experts) context.registerExpert(expert);
  for (const command of runtime.contributions.commands) {
    context.registerCommand({
      ...command,
      expand: (args) => runtime.call<string>('command.expand', command.id, [args]),
    });
  }
  for (const factory of runtime.contributions.providers) {
    context.registerProvider({
      ...factory,
      async create(config) {
        const metadata = await runtime.call<Parameters<typeof remoteProvider>[1]>(
          'provider.create',
          factory.id,
          [config]
        );
        return remoteProvider(runtime, metadata);
      },
    });
  }
  for (const preset of runtime.contributions.mcpPresets) context.registerMcpPreset(preset);
  for (const layer of runtime.contributions.promptLayers) context.addPromptLayer(layer);
  for (const contribution of runtime.contributions.webContributions) {
    context.registerWebContribution(contribution);
  }
}

/** Start a trusted-code plugin in a termination-bounded Worker/RPC boundary. @internal */
export async function createIsolatedMossPlugin(options: {
  readonly moduleUrl: string;
  readonly exportName: string;
  readonly pluginId: string;
  readonly timeoutMs: number;
  readonly manifestWebContributions?: readonly MossWebContribution[];
  readonly config?: Readonly<Record<string, unknown>>;
}): Promise<MossPlugin> {
  const runtime = await startWorker(
    options.moduleUrl,
    options.exportName,
    options.pluginId,
    options.timeoutMs,
    options.config ?? {}
  );
  return {
    id: options.pluginId,
    config: Object.freeze({ ...(options.config ?? {}) }),
    disposeCandidate: () => runtime.close(),
    setup(context) {
      registerRemoteContributions(context, runtime);
      for (const contribution of options.manifestWebContributions ?? []) {
        context.registerWebContribution(contribution);
      }
      return () => runtime.close();
    },
  };
}
