import type { MossAgent } from '../core/agent/moss-agent.js';
import type { TaskRunLedger } from '../core/task-run/task-run-ledger.js';
import { parseCliInteractionMode, type CliInteractionMode } from '../cli/approval.js';
import {
  registryCommandNames,
  runRegistryCommand,
  type CommandContext,
  type CommandSpec,
} from '../cli/commands/registry.js';
import type { CliRuntimeStatus } from '../cli/onboarding.js';
import { ErrorCode, MossError } from '../errors.js';
import {
  StoreExecutionActionController,
  type ExecutionAction,
} from '../orchestration/execution-action.js';
import { StoreExecutionQuery } from '../orchestration/execution-query.js';
import { parseTodoChecklistText, type TodoItem } from '../tools/todo-tool.js';

export interface MossWebRuntimeServiceOptions {
  readonly runtime?: CliRuntimeStatus;
  readonly locale?: string;
  readonly initialMode?: CliInteractionMode;
}

/** Browser application service over the agent's existing runtime state owners. @internal */
export class MossWebRuntimeService {
  private currentMode: CliInteractionMode;
  private readonly executionQuery: StoreExecutionQuery;
  private readonly executionActions: StoreExecutionActionController;

  constructor(
    private readonly agent: MossAgent,
    private readonly taskRuns: TaskRunLedger,
    private readonly options: MossWebRuntimeServiceOptions = {}
  ) {
    this.currentMode = options.initialMode ?? 'default';
    this.executionQuery = new StoreExecutionQuery(agent.executionStore);
    this.executionActions = new StoreExecutionActionController(agent.executionStore);
  }

  mode(): CliInteractionMode {
    return this.currentMode;
  }

  setMode(raw: string): CliInteractionMode {
    const mode = parseCliInteractionMode(raw);
    if (!mode) this.invalid('mode must be plan, default, or accept-edits');
    this.currentMode = mode;
    return mode;
  }

  inbox(sessionId: string) {
    return this.agent.inboxPending(sessionId);
  }

  admit(sessionId: string, prompt: string, delivery: 'queue' | 'steer' = 'queue') {
    const normalized = this.prompt(prompt);
    return this.agent.admit(sessionId, normalized, { delivery });
  }

  steer(sessionId: string, prompt: string) {
    return this.agent.steer(sessionId, this.prompt(prompt));
  }

  async goal(sessionId: string) {
    return this.agent.getGoal(sessionId);
  }

  async setGoal(sessionId: string, objective: string) {
    return this.agent.setGoal(sessionId, objective);
  }

  async updateGoal(
    sessionId: string,
    action: 'set' | 'pause' | 'resume' | 'complete' | 'block' | 'clear',
    input: { objective?: string; reason?: string }
  ) {
    if (action === 'set') return this.agent.setGoal(sessionId, input.objective ?? '');
    if (action === 'pause') return this.agent.pauseGoal(sessionId, input.reason);
    if (action === 'resume') return this.agent.resumeGoal(sessionId);
    if (action === 'complete') return this.agent.completeGoal(sessionId, input.reason);
    if (action === 'block') return this.agent.blockGoal(sessionId, input.reason);
    await this.agent.clearGoal(sessionId);
    return undefined;
  }

  async todos(sessionId: string): Promise<readonly TodoItem[]> {
    const messages = await this.agent.config.sessionStore.loadMessages(sessionId);
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
      const content = messages[messageIndex]?.content;
      if (!Array.isArray(content)) continue;
      for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = content[blockIndex];
        if (block?.type !== 'tool_result' || typeof block.content !== 'string') continue;
        const parsed = parseTodoChecklistText(block.content);
        if (parsed !== null) return parsed;
      }
    }
    return [];
  }

  jobs() {
    return this.agent.asyncTasks.list();
  }

  tasks() {
    return this.agent.tasks.list();
  }

  task(graphId: string) {
    return this.agent.tasks.inspect(graphId);
  }

  executions(sessionId?: string) {
    return this.executionQuery.list(sessionId ? { sessionId } : {});
  }

  execution(graphId: string) {
    const execution = this.executionQuery.get(graphId);
    if (!execution) this.invalid(`execution "${graphId}" was not found`);
    return execution;
  }

  executeAction(graphId: string, expectedRevision: number, rawAction: unknown) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      this.invalid('expectedRevision must be a positive integer');
    }
    if (!rawAction || typeof rawAction !== 'object') this.invalid('action must be an object');
    const type = (rawAction as { readonly type?: unknown }).type;
    const supported = new Set<ExecutionAction['type']>([
      'resume',
      'retry',
      'stop',
      'record_elaboration',
      'record_proposal',
      'approve_proposal',
      'transition_delivery',
      'revise_acceptance',
      'record_review',
      'publish_report',
      'request_manual_review',
    ]);
    if (typeof type !== 'string' || !supported.has(type as ExecutionAction['type'])) {
      this.invalid('action type is unsupported');
    }
    this.executionActions.execute(graphId, expectedRevision, rawAction as ExecutionAction);
    return this.execution(graphId);
  }

  controlTask(graphId: string, action: 'resume' | 'retry' | 'stop', nodeId?: string) {
    if (action === 'resume') return this.agent.tasks.resume(graphId);
    if (action === 'stop') return this.agent.tasks.stop(graphId);
    if (!nodeId) this.invalid('nodeId is required for retry');
    return this.agent.tasks.retry(graphId, nodeId);
  }

  stopJob(taskId: string): boolean {
    return this.agent.asyncTasks.stop(taskId, 'user_cancelled');
  }

  workflows() {
    return this.agent.plugins.listCommands().map((command) => ({
      id: command.id,
      title: command.title,
      description: command.description,
      available: true,
    }));
  }

  async runWorkflow(sessionId: string, workflowId: string, args: string) {
    const prompt = (await this.agent.plugins.expandCommand(workflowId, args))?.trim();
    if (prompt === undefined) this.invalid(`workflow "${workflowId}" was not found`);
    if (!prompt) this.invalid(`workflow "${workflowId}" produced an empty prompt`);
    const entry = this.agent.admit(sessionId, prompt, { delivery: 'queue' });
    return { workflowId, prompt, entry };
  }

  trajectory(runId: string) {
    const run = this.taskRuns.get(runId);
    if (!run) this.invalid(`run "${runId}" was not found`);
    const events = this.taskRuns.events(runId);
    return {
      run,
      events,
      evidence: events.filter((event) => event.type.startsWith('tool.')),
    };
  }

  completionVerdict(runId: string) {
    const graph = this.agent.executionStore.load(runId);
    if (graph) {
      return {
        runId,
        status: graph.status,
        verdict: graph.verification?.verdict ?? 'pending',
        evidenceIds: graph.verification?.evidenceIds ?? [],
        reasons: graph.verification?.reasons ?? [],
        evidenceCount: graph.evidence.length,
        complete: graph.status === 'completed' && graph.verification?.verdict === 'verified',
        revision: graph.revision,
      };
    }
    const run = this.taskRuns.get(runId);
    if (!run) this.invalid(`run "${runId}" was not found`);
    return {
      runId,
      status: run.status,
      verdict: run.verification,
      evidenceCount: run.evidenceCount,
      complete: run.status === 'completed',
    };
  }

  mentionInventory() {
    const skills = (this.agent.config.skillRegistry?.list() ?? []).map((skill) => ({
      id: skill.stableId ?? skill.name,
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled !== false,
    }));
    const configuredExperts =
      this.agent.config.subagentExpertRegistry?.list() ?? this.agent.config.subagentExperts ?? [];
    const pluginExperts = this.agent.plugins
      .inspect()
      .plugins.flatMap((plugin) => plugin.experts.map((id) => ({ id, pluginId: plugin.id })));
    return {
      commands: [
        ...registryCommandNames(),
        ...this.agent.plugins.listCommands().map(({ id }) => `/${id}`),
      ],
      skills,
      experts: [
        ...configuredExperts.map(({ instructions: _, ...expert }) => expert),
        ...pluginExperts,
      ],
    };
  }

  inventory() {
    return {
      model: this.agent.config.model ?? 'Configured model',
      workspace: this.agent.config.workspaceDir,
      mode: this.mode(),
      tools: this.agent.tools.getAll().map((tool) => ({
        name: tool.name,
        description: tool.description,
        sideEffect: tool.metadata?.sideEffectClass ?? 'local_write',
      })),
      plugins: this.agent.plugins.inspect(),
      asyncTasks: this.jobs(),
      runtime: this.options.runtime
        ? {
            workspace: this.options.runtime.workspace,
            runtimeDir: this.options.runtime.runtimeDir,
            execBackend: this.options.runtime.execBackend,
            safetyMode: this.options.runtime.safetyMode,
            meshEnabled: this.options.runtime.meshEnabled,
            mcp: this.options.runtime.mcp,
            deviceConnected: Boolean(this.options.runtime.device),
          }
        : undefined,
    };
  }

  async dispatchSlash(sessionId: string, command: string) {
    const messages: Array<{ kind: 'system' | 'error'; text: string }> = [];
    const modeCommand = command.trim().match(/^\/(?:mode|plan)(?:\s+(.*))?$/);
    if (modeCommand) {
      const input = modeCommand[1]?.trim();
      if (!input) {
        messages.push({ kind: 'system', text: `Interaction mode: ${this.mode()}` });
      } else {
        const parsed = parseCliInteractionMode(input);
        if (!parsed) {
          messages.push({
            kind: 'error',
            text: 'Usage: /mode [plan|default|accept-edits]',
          });
        } else {
          this.currentMode = parsed;
          messages.push({ kind: 'system', text: `Switched to ${parsed}` });
        }
      }
      return { handled: true, messages, mode: this.mode() };
    }
    let prefill: string | undefined;
    let submittedPrompt: string | undefined;
    const context: CommandContext = {
      agent: this.agent,
      runtime: this.options.runtime,
      sessionKey: sessionId,
      workspace: this.agent.config.workspaceDir ?? process.cwd(),
      locale: this.options.locale,
      surface: 'repl',
      say: (kind, text) => messages.push({ kind, text }),
      prefillInput: (text) => {
        prefill = text;
      },
      submitPrompt: (text) => {
        submittedPrompt = text;
      },
      setInteractionMode: (mode) => {
        this.currentMode = mode;
      },
    };
    const customCommands: CommandSpec[] = this.agent.plugins
      .listCommands()
      .map((pluginCommand) => ({
        name: `/${pluginCommand.id}`,
        summary: pluginCommand.description ?? pluginCommand.title,
        run: async (ctx, args) =>
          ctx.submitPrompt?.(
            (await this.agent.plugins.expandCommand(pluginCommand.id, args)) ?? ''
          ),
      }));
    const handled = await runRegistryCommand(command, context, customCommands);
    return {
      handled,
      messages,
      mode: this.mode(),
      ...(prefill !== undefined ? { prefill } : {}),
      ...(submittedPrompt !== undefined ? { submittedPrompt } : {}),
    };
  }

  private prompt(value: string): string {
    const normalized = value.trim();
    if (!normalized || normalized.length > 20_000) {
      this.invalid('prompt must contain 1 to 20000 characters');
    }
    return normalized;
  }

  private invalid(message: string): never {
    throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
  }
}
