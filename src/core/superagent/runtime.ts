import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  SuperagentConfig,
  SuperagentRequest,
  SuperagentTicketView,
  SuperagentWorkerInput,
  SuperagentWorkRequest,
  SuperagentAssessment,
} from '../../contracts/superagent.js';
import {
  Engine,
  ticketStage,
  type Ticket,
  type Candidate,
  type OutboundMessage,
  type PolicyEffect,
} from './upstream/index.js';
import type { SuperagentStore } from './store.js';
import {
  NativeMossWorker,
  type SuperagentWorker,
  type SuperagentAssessorRequest,
} from './worker.js';
import { policyFor, checkedConfig, invalid } from './policy.js';
import { MossError, ErrorCode, wrapAsMoss } from '../../errors.js';
import { ensureMossRuntimeGitignore } from '../../utils/workspace-paths.js';
import { createWorktree } from '../subagent/worktree-isolation.js';
import { runGit } from '../../utils/git-spawn.js';
import { acquireSessionWriteLock } from '../session/session-write-lock.js';
import { runAcceptanceCommandInWorkspace } from '../task/acceptance-command.js';
import { getTaskStateSnapshot } from '../task/task-store.js';
import { persistedAcceptanceCommand } from '../task/acceptance-authority.js';

interface Effect {
  kind: 'start' | 'deliver' | 'stop' | 'assess';
  id: string;
  ticketId?: string;
  assignmentId?: string;
  candidate?: Candidate;
}
interface Binding {
  workspace: string;
  baseRev: string;
  sessionKey: string;
  taskId?: string;
  assignmentId: string;
  running: boolean;
}
interface Active {
  controller: AbortController;
  done: Promise<void>;
}
export interface MossSuperagentOptions {
  workspaceDir: string;
  config?: SuperagentConfig;
  worker?: SuperagentWorker;
  workerEnv?: NodeJS.ProcessEnv;
  assess?: (
    request: SuperagentAssessorRequest,
    signal: AbortSignal
  ) => Promise<SuperagentAssessment>;
}
function safePath(root: string, relative: string, create = true): string {
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (
      fs.existsSync(current) ||
      (() => {
        try {
          fs.lstatSync(current);
          return true;
        } catch {
          return false;
        }
      })()
    ) {
      if (fs.lstatSync(current).isSymbolicLink())
        throw invalid('Super-agent refuses symbolic links in its state/worktree paths');
    } else if (create) fs.mkdirSync(current, { mode: 0o700 });
  }
  return current;
}

/** Optional durable host for the actual DeepSeek domain engine. No network listeners or external reply sender. */
export class MossSuperagent {
  private readonly engine: Engine;
  private readonly worker: SuperagentWorker;
  private readonly assess: NonNullable<MossSuperagentOptions['assess']>;
  private readonly active = new Map<string, Active>();
  private working = false;
  private closed = false;

  constructor(
    readonly workspaceDir: string,
    private readonly stateDir: string,
    private readonly store: SuperagentStore,
    options: MossSuperagentOptions
  ) {
    const native = new NativeMossWorker({ env: options.workerEnv });
    this.worker = options.worker ?? native;
    this.assess =
      options.assess ?? ((request, signal) => native.assess(request, workspaceDir, signal));
    const effect = (value: Effect) => store.set('effect', `${value.kind}:${value.id}`, value);
    this.engine = new Engine({
      repo: store.repo,
      policy: () => policyFor(this.config(), this.paused()),
      scope: {
        scope: (input) =>
          Object.hasOwn(this.config().allowedActors, input.source)
            ? { listened: true, observed: true }
            : { listened: false, reason: 'unknown_source' },
      },
      assessor: {
        request: (candidate) => effect({ kind: 'assess', id: candidate.evalId, candidate }),
        release: (id) => store.remove('effect', `assess:${id}`),
      },
      executor: {
        start: (ticket, assignment) =>
          effect({
            kind: 'start',
            id: assignment.id,
            ticketId: ticket.id,
            assignmentId: assignment.id,
          }),
        deliver: (ticket, assignment) =>
          effect({
            kind: 'deliver',
            id: `${assignment.id}:${ticket.undelivered.at(-1) ?? 'empty'}`,
            ticketId: ticket.id,
            assignmentId: assignment.id,
          }),
        stop: (ticket, assignment) =>
          effect({
            kind: 'stop',
            id: assignment.id,
            ticketId: ticket.id,
            assignmentId: assignment.id,
          }),
      },
      outbox: {
        send: (message) => {
          if (!store.get('reply', message.id)) store.set('reply', message.id, message);
        },
        status: (id) => (store.get('reply', id) ? 'sent' : undefined),
        withdraw: () => {}, // A local durable receipt is the destination; already recorded replies cannot be unsent.
      },
      prepareTicket: (ticket) => ({
        ...ticket,
        execution: {
          name: `superagent-${ticket.id}`,
          directory: path.join(workspaceDir, '.moss', 'worktrees', `superagent-${ticket.id}`),
          assignment: ticket.mandate.scope,
        },
      }),
    });
  }

  config(): SuperagentConfig {
    this.assertOpen();
    return checkedConfig(this.store.get<SuperagentConfig>('meta', 'config')!);
  }
  paused(): boolean {
    return this.store.get<boolean>('meta', 'paused') === true;
  }
  setPaused(paused: boolean): void {
    this.assertOpen();
    if (typeof paused !== 'boolean') throw invalid('Pause must be a boolean');
    this.store.atomic(() => {
      this.store.set('meta', 'paused', paused);
      this.engine.evaluateDue();
    });
  }
  configure(config: SuperagentConfig): void {
    this.assertOpen();
    const next = checkedConfig(config);
    const previousConfig = this.config();
    const previous = policyFor(previousConfig, this.paused());
    this.store.atomic(() => {
      this.store.set('policy', policyFor(next, false).version, next);
      this.store.set('meta', 'config', next);
      const effects = new Map<string, PolicyEffect>();
      for (const ticket of this.store.repo.tickets.open()) {
        const effect: PolicyEffect = {};
        if (
          !Object.hasOwn(next.allowedActors, ticket.mandate.actor.source) ||
          !next.allowedActors[ticket.mandate.actor.source]!.includes(ticket.mandate.actor.id)
        )
          effect.requesterAllowed = false;
        if (ticket.mandate.strength === 'inferred' && next.acceptMode !== 'auto')
          effect.proactive = false;
        effect.rules = ticket.mandate.basis.rules?.flatMap((id) => {
          const old = previousConfig.rules.find((rule) => rule.id === id);
          const rule = next.rules.find((item) => item.id === id);
          if (old?.instruction === rule?.instruction) return [];
          return [
            {
              id,
              name: id,
              change: rule ? ('changed' as const) : ('disabled' as const),
              ...(rule ? { instruction: rule.instruction } : {}),
            },
          ];
        });
        if (effect.requesterAllowed === false || effect.proactive === false || effect.rules?.length)
          effects.set(ticket.id, effect);
      }
      this.engine.policyChanged(previous.version, policyFor(next, this.paused()).version, effects);
    });
  }
  receive(request: SuperagentRequest): { duplicate: boolean; triggerId: string } {
    this.assertOpen();
    if (
      !request ||
      ['id', 'source', 'actor', 'thread', 'text'].some(
        (key) =>
          typeof request[key as keyof SuperagentRequest] !== 'string' ||
          !(request[key as keyof SuperagentRequest] as string).trim()
      ) ||
      request.text.length > 32_768 ||
      request.id.length > 200 ||
      request.thread.length > 200 ||
      typeof request.human !== 'boolean' ||
      (request.addressed !== undefined && typeof request.addressed !== 'boolean')
    )
      throw invalid('Invalid authenticated Super-agent request');
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          request.source,
          request.actor,
          request.thread,
          request.text,
          request.human,
          request.addressed ?? false,
        ])
      )
      .digest('hex');
    return this.store.atomic(() => {
      const previous = this.store.repo.triggers.get(request.id);
      if (previous) {
        if (previous.meta.requestDigest !== digest)
          throw invalid('An event ID cannot be reused with changed content');
        return { duplicate: true, triggerId: request.id };
      }
      const authorizedHuman =
        request.human &&
        Object.hasOwn(this.config().allowedActors, request.source) &&
        this.config().allowedActors[request.source]!.includes(request.actor);
      this.engine.receive({
        id: request.id,
        source: request.source,
        actor: { source: request.source, id: request.actor },
        threads: [{ source: request.source, id: request.thread }],
        human: authorizedHuman,
        ...(request.addressed && authorizedHuman ? { addressed: 'direct' as const } : {}),
        at: new Date().toISOString(),
        text: request.text,
        meta: { requestDigest: digest },
        channel: { source: request.source, thread: request.thread, address: {} },
      });
      return { duplicate: false, triggerId: request.id };
    });
  }
  tickets(): SuperagentTicketView[] {
    this.assertOpen();
    return this.store.repo.tickets.list().map((ticket) => {
      const binding = this.store.get<Binding>('binding', ticket.id);
      const stage = ticketStage(ticket);
      const report = ticket.assignments.at(-1)?.report;
      return {
        id: ticket.id,
        title: ticket.title,
        scope: ticket.mandate.scope,
        state: ticket.ended?.outcome ?? (stage.stage === 'person' ? stage.action : stage.stage),
        ...(report ? { summary: report.summary } : {}),
        ...(binding
          ? { workspace: binding.workspace, sessionKey: binding.sessionKey, taskId: binding.taskId }
          : {}),
        ...(ticket.ended ? { outcome: ticket.ended.outcome } : {}),
      };
    });
  }
  decisions(): unknown[] {
    this.assertOpen();
    return this.store.list('decision');
  }
  replies(): OutboundMessage[] {
    this.assertOpen();
    return this.store.list('reply');
  }
  stop(ticketId: string): void {
    this.assertOpen();
    try {
      this.engine.stopTicket(ticketId);
    } catch (error) {
      throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID);
    }
    for (const [id, active] of this.active)
      if (id === this.store.get<Binding>('binding', ticketId)?.assignmentId)
        active.controller.abort();
  }
  retry(ticketId: string): void {
    this.assertOpen();
    try {
      this.engine.retryTicket(ticketId);
    } catch (error) {
      throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID);
    }
  }

  private inputs(ticket: Ticket): SuperagentWorkerInput[] {
    return ticket.inputs
      .filter(
        (input) =>
          ticket.undelivered.includes(input.id) || (input.kind === 'trigger' && !input.readAt)
      )
      .map((input) => {
        const trigger =
          input.kind === 'trigger' ? this.store.repo.triggers.get(input.triggerId) : undefined;
        return {
          id: input.id,
          text:
            trigger?.text ??
            (input.kind === 'text' || input.kind === 'note' ? input.text : JSON.stringify(input)),
          contextOnly: input.kind !== 'trigger' || input.context === true || !input.human,
        };
      });
  }
  private current(effect: Effect): Ticket | undefined {
    const ticket = effect.ticketId ? this.store.repo.tickets.get(effect.ticketId) : undefined;
    return ticket && !ticket.ended && ticket.assignments.at(-1)?.id === effect.assignmentId
      ? ticket
      : undefined;
  }
  private async launch(effect: Effect, controller: AbortController): Promise<void> {
    let binding: Binding | undefined;
    try {
      let ticket = this.current(effect);
      if (!ticket) return;
      binding = this.store.get<Binding>('binding', ticket.id);
      safePath(this.workspaceDir, '.moss/worktrees');
      if (!binding) {
        const directory = ticket.execution!.directory;
        if (fs.existsSync(directory))
          throw invalid('An unbound ticket worktree already exists; inspect it before retrying');
        const lease = await createWorktree({
          parentWorkspace: this.workspaceDir,
          runId: `superagent-${ticket.id}`,
          signal: controller.signal,
        });
        binding = {
          workspace: lease.worktreePath,
          baseRev: lease.baseRev,
          sessionKey: `superagent-${ticket.id}`,
          assignmentId: effect.assignmentId!,
          running: false,
        };
        this.store.set('binding', ticket.id, binding);
      }
      if (
        binding.workspace !== ticket.execution?.directory ||
        fs.lstatSync(binding.workspace).isSymbolicLink() ||
        fs.realpathSync(binding.workspace) !== path.resolve(binding.workspace)
      )
        throw invalid('Unsafe ticket worktree');
      const top = await runGit(['rev-parse', '--show-toplevel'], {
        cwd: binding.workspace,
        readOnly: true,
      });
      const common = await runGit(['rev-parse', '--git-common-dir'], {
        cwd: binding.workspace,
        readOnly: true,
      });
      const parentCommon = await runGit(['rev-parse', '--git-common-dir'], {
        cwd: this.workspaceDir,
        readOnly: true,
      });
      if (
        fs.realpathSync(path.resolve(binding.workspace, common.stdout.trim())) !==
        fs.realpathSync(path.resolve(this.workspaceDir, parentCommon.stdout.trim()))
      )
        throw invalid('Ticket worktree belongs to a different repository');
      if (fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(binding.workspace))
        throw invalid('Ticket worktree binding changed');
      ticket = this.current(effect);
      if (!ticket || controller.signal.aborted) return;
      binding = { ...binding, assignmentId: effect.assignmentId!, running: true };
      this.store.atomic(() => {
        this.store.set('binding', ticket!.id, binding);
        this.engine.assignmentStarted(ticket!.id, effect.assignmentId!);
      });
      const request: SuperagentWorkRequest = {
        ticketId: ticket.id,
        assignmentId: effect.assignmentId!,
        workspaceDir: binding.workspace,
        sessionKey: binding.sessionKey,
        scope: ticket.mandate.scope,
        acceptanceCommand:
          this.store.get<SuperagentConfig>('policy', ticket.mandate.policyVersion)
            ?.acceptanceCommand ??
          (() => {
            throw invalid('Missing original acceptance authority');
          })(),
        inputs: this.inputs(ticket),
        ...(binding.taskId ? { taskId: binding.taskId } : {}),
      };
      const result = await this.worker.run(request, controller.signal, (taskId) => {
        if (typeof taskId !== 'string' || !/^[\w.-]{1,200}$/.test(taskId))
          throw invalid('Invalid native task ID');
        binding = { ...binding!, taskId };
        this.store.set('binding', request.ticketId, binding);
      });
      ticket = this.current(effect);
      if (!ticket) return;
      if (
        !result ||
        !['ready', 'blocked', 'failed'].includes(result.state) ||
        typeof result.summary !== 'string' ||
        !Array.isArray(result.readInputIds) ||
        result.readInputIds.some((id) => !ticket!.inputs.some((input) => input.id === id))
      )
        throw invalid('Invalid Moss worker result');
      const delivered = result.readInputIds;
      this.engine.inputsDelivered(ticket.id, effect.assignmentId!, delivered);
      this.engine.inputsRead(ticket.id, delivered);
      let state = result.state;
      if (state === 'ready') {
        const taskId = result.taskId;
        const native = taskId ? await getTaskStateSnapshot(binding.workspace, taskId) : undefined;
        if (
          !taskId ||
          taskId !== binding.taskId ||
          native?.phase !== 'accepted' ||
          (await persistedAcceptanceCommand(binding.workspace, taskId)) !==
            request.acceptanceCommand
        )
          state = 'blocked';
        else {
          const verdict = await runAcceptanceCommandInWorkspace(
            {
              command: request.acceptanceCommand,
              timeoutMs: Math.min(300_000, this.config().maxWallMs),
            },
            controller.signal,
            binding.workspace
          );
          if (!verdict.passed) state = 'blocked';
        }
      }
      if (!this.current(effect) || controller.signal.aborted) return;
      // A follow-up may arrive after the child finishes, while the independent oracle is running.
      if (state === 'ready' && this.inputs(this.current(effect)!).length) state = 'blocked';
      this.store.atomic(() => {
        this.engine.report(ticket!.id, {
          state,
          summary:
            state === 'ready'
              ? 'Moss native task accepted and the operator command passed independent verification'
              : 'Moss execution requires attention; inspect its native task and session before retrying',
        });
        this.engine.turnEnded(ticket!.id, effect.assignmentId!);
        if (state === 'ready')
          this.engine.reply({
            purpose: 'result',
            ticketId: ticket!.id,
            text: `Verified result ready in ${binding!.workspace}`,
          });
      });
    } catch (error) {
      const ticket = this.current(effect);
      if (ticket)
        this.engine.report(ticket.id, {
          state: 'blocked',
          summary: controller.signal.aborted
            ? 'Worker interrupted; explicit retry required'
            : `Worker could not produce a verified result (${error instanceof MossError ? error.code : 'worker_error'}); explicit retry required`,
        });
    } finally {
      if (binding) this.store.set('binding', effect.ticketId!, { ...binding, running: false });
      this.store.remove('effect', `start:${effect.id}`);
    }
  }
  private async assessCandidate(effect: Effect, controller: AbortController): Promise<void> {
    const candidate = effect.candidate!;
    const triggerId = candidate.triggers[0]?.id;
    if (!triggerId || this.engine.candidate(triggerId)?.evalId !== candidate.evalId) return;
    this.engine.candidateDelivered(candidate.evalId);
    try {
      if (candidate.strength === 'explicit') {
        this.engine.decide(triggerId, {
          kind: 'accept',
          evalId: candidate.evalId,
          title: candidate.triggers[0]!.text.slice(0, 160),
          scope: candidate.triggers[0]!.text,
          reason: 'Explicit request from an allowed human',
        });
        return;
      }
      const config = this.config();
      const result = await this.assess(
        {
          text: candidate.triggers
            .map((trigger) => trigger.text)
            .join('\n')
            .slice(0, 32_768),
          rules: config.rules,
        },
        controller.signal
      );
      if (
        !result ||
        !['accept', 'ignore'].includes(result.kind) ||
        typeof result.scope !== 'string' ||
        !result.scope.trim() ||
        result.scope.length > 8192 ||
        typeof result.reason !== 'string' ||
        !Array.isArray(result.rules) ||
        new Set(result.rules).size !== result.rules.length ||
        result.rules.some((id) => !config.rules.some((rule) => rule.id === id)) ||
        (result.kind === 'accept' && result.rules.length === 0)
      )
        throw invalid('Invalid semantic assessment');
      if (this.config().acceptMode === 'observe' && result.kind === 'accept') {
        this.engine.decide(triggerId, {
          kind: 'ignore',
          evalId: candidate.evalId,
          reason: result.reason,
          audit: { wouldAccept: true, rules: result.rules },
        });
      } else
        this.engine.decide(triggerId, {
          ...result,
          title: result.scope.slice(0, 160),
          evalId: candidate.evalId,
        });
    } catch {
      if (this.engine.candidate(triggerId)?.evalId === candidate.evalId)
        this.engine.decide(triggerId, {
          kind: 'unavailable',
          evalId: candidate.evalId,
          reason: 'Assessment unavailable or invalid; no work authorized',
        });
    } finally {
      this.store.remove('effect', `assess:${effect.id}`);
    }
  }

  /** One scheduler, separate per-ticket processes. Restart blocks uncertain work until an explicit retry. */
  async work(options: { follow?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    this.assertOpen();
    if (this.working) throw invalid('This runtime already owns a scheduler');
    this.working = true;
    const lock = await acquireSessionWriteLock({
      sessionFile: path.join(this.stateDir, 'scheduler'),
      timeoutMs: 100,
    }).catch((error) => {
      this.working = false;
      throw error;
    });
    const abort = () => {
      for (const active of this.active.values()) active.controller.abort();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      for (const ticket of this.store.repo.tickets.open()) {
        const binding = this.store.get<Binding>('binding', ticket.id);
        if (binding?.running) {
          this.engine.report(ticket.id, {
            state: 'blocked',
            summary: 'Previous scheduler interrupted; inspect native evidence and explicitly retry',
          });
          this.store.set('binding', ticket.id, { ...binding, running: false });
          this.store.remove('effect', `start:${binding.assignmentId}`);
        }
      }
      while (!this.closed && !options.signal?.aborted) {
        this.engine.evaluateDue();
        const effects = this.store.list<Effect>('effect');
        for (const effect of effects) {
          if (effect.kind === 'stop') {
            this.active.get(effect.assignmentId!)?.controller.abort();
            this.store.remove('effect', `stop:${effect.id}`);
            continue;
          }
          if (effect.kind === 'deliver') {
            const ticket = this.current(effect);
            if (!ticket || !this.active.has(effect.assignmentId!)) {
              if (!ticket) this.store.remove('effect', `deliver:${effect.id}`);
              continue;
            }
            const inputs = this.inputs(ticket);
            if (!inputs.length) {
              this.store.remove('effect', `deliver:${effect.id}`);
              continue;
            }
            try {
              const ids = await this.worker.deliver(effect.assignmentId!, inputs);
              if (this.current(effect))
                this.engine.inputsDelivered(ticket.id, effect.assignmentId!, ids);
              this.store.remove('effect', `deliver:${effect.id}`);
            } catch {
              /* A starting worker has not installed its IPC handler yet; retry on the next pass. */
            }
            continue;
          }
          if (
            this.paused() ||
            this.active.has(effect.id) ||
            this.active.size >= this.config().maxWorkers
          )
            continue;
          if (effect.kind === 'start' && !this.current(effect)) {
            this.store.remove('effect', `start:${effect.id}`);
            continue;
          }
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), this.config().maxWallMs);
          const done = (
            effect.kind === 'start'
              ? this.launch(effect, controller)
              : this.assessCandidate(effect, controller)
          ).finally(() => {
            clearTimeout(timeout);
            this.active.delete(effect.id);
          });
          this.active.set(effect.id, { controller, done });
        }
        const pending = this.store
          .list<Effect>('effect')
          .some((effect) => effect.kind !== 'deliver' && effect.kind !== 'stop');
        if (!options.follow && !this.active.size && (this.paused() || !pending)) break;
        await delay(40);
      }
    } finally {
      abort();
      await Promise.allSettled([...this.active.values()].map((active) => active.done));
      options.signal?.removeEventListener('abort', abort);
      await lock.release();
      this.working = false;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    // Callers must cancel/await work before closing the store.
    if (this.working) throw invalid('Cancel and await the scheduler before closing');
    this.closed = true;
    this.store.close();
  }
  private assertOpen(): void {
    if (this.closed) throw invalid('Super-agent runtime is closed');
  }
}

export async function createMossSuperagent(
  options: MossSuperagentOptions
): Promise<MossSuperagent> {
  try {
    if (options.config) checkedConfig(options.config);
    const workspace = fs.realpathSync(options.workspaceDir);
    const git = await runGit(['rev-parse', '--show-toplevel'], { cwd: workspace, readOnly: true });
    if (fs.realpathSync(git.stdout.trim()) !== workspace)
      throw invalid('Super-agent requires the Git repository root');
    if (
      !options.config &&
      !fs.existsSync(path.join(workspace, '.moss', 'superagent', 'state.sqlite'))
    )
      throw invalid('Initialize Super-agent with a fixed acceptance command first');
    safePath(workspace, '.moss');
    ensureMossRuntimeGitignore(workspace);
    const stateDir = safePath(workspace, '.moss/superagent');
    const ignore = safePath(stateDir, '.gitignore', false);
    try {
      fs.writeFileSync(ignore, '*\n', { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const file = safePath(stateDir, 'state.sqlite', false);
    safePath(stateDir, 'state.sqlite-wal', false);
    safePath(stateDir, 'state.sqlite-shm', false);
    const { SuperagentStore: Store } = await import('./store.js');
    const store = new Store(file);
    try {
      store.atomic(() => {
        const saved = store.get<SuperagentConfig>('meta', 'config');
        const config = options.config ? checkedConfig(options.config) : saved;
        if (!config) throw invalid('Initialize Super-agent with a fixed acceptance command first');
        if (saved && options.config && JSON.stringify(saved) !== JSON.stringify(config))
          throw invalid('Existing Super-agent policy differs; use configure explicitly');
        if (!saved) store.set('meta', 'config', config);
        store.set('policy', policyFor(config, false).version, config);
      });
      return new MossSuperagent(workspace, stateDir, store, options);
    } catch (error) {
      store.close();
      throw error;
    }
  } catch (error) {
    throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID);
  }
}
