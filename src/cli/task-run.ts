/**
 * `moss task` — the headless face of the unified task runtime (Task OS M5).
 * One natural-language goal in, one verified result out:
 *
 *   moss task run <goal...> [--accept "<cmd>"] [--max-repairs N] [--max-turns N] [--device ID]
 *   moss task resume <task_id>
 *   moss task status [task_id]      (default: latest)
 *   moss task timeline [task_id]
 *
 * Exit code 0 only when the task reached accepted (PASS).
 */
import path from 'node:path';
import { runTask, resumeTask, summarizeTaskRun } from '../core/task/task-engine.js';
import { createAgentTurnRunner } from '../core/task/agent-turn.js';
import {
  getTaskStateSnapshot,
  listTaskEvents,
  listTaskStateSnapshots,
  buildTaskTimeline,
  formatTaskTimeline,
} from '../core/task/task-store.js';
import type { TaskStateSnapshot } from '../contracts/task-runtime.js';

export interface TaskCommandContext {
  agent: unknown;
  workspace: string;
  sessionKey: string;
  /** User config dir (`<configDir>/skills`), so discovery sees the same skills the agent was given. */
  configDir?: string;
  /** Live event tap for the CLI renderer (optional). */
  onAgentEvent?: (event: unknown) => void;
  /** Output sink; defaults to the process streams for headless CLI use. */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  signal?: AbortSignal;
  /**
   * Connected MCP servers, when the host has any. Discovery selects tools from
   * `catalog()` per task and `reveal()`s exactly those, so a per-task MCP choice
   * actually becomes callable without the model searching first.
   */
  mcp?: {
    catalog: () => readonly { name: string; description?: string }[];
    /** Returns the wire names that were actually revealed — the layer may only
     *  name tools that exist, so a stale catalog must not put ghosts in the prompt. */
    reveal: (wireNames: readonly string[]) => string[];
  };
}

function usage(): string {
  return [
    'Usage: moss task <command> [options]',
    '',
    '  run <goal...>        run a task end to end (plan → execute → verify → repair → accept)',
    '      --accept "<cmd>"  acceptance authority: command must exit 0',
    '      --max-repairs N  repair attempts before honest FAIL (default 2)',
    '      --max-turns N    agent turn budget (default 8)',
    '      --device ID      target device id for the contract',
    '  resume <task_id>     resume a failed/abandoned/blocked task',
    '  status [task_id]     current phase, plan, failures, verdict (default: latest)',
    '  timeline [task_id]   full lifecycle timeline (default: latest)',
    '',
    'Exit code is 0 only when the task is accepted (PASS).',
  ].join('\n');
}

/**
 * Minimal shell-ish tokenizer: splits on whitespace but honors double-quoted
 * segments (for --accept "npm test && npm run check").
 */
export function splitCommandArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of line.trim()) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) args.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function parseFlags(args: string[]): {
  goal: string[];
  accept?: string;
  maxRepairs?: number;
  maxTurns?: number;
  device?: string;
} {
  const goal: string[] = [];
  let accept: string | undefined;
  let maxRepairs: number | undefined;
  let maxTurns: number | undefined;
  let device: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--accept') accept = args[++i];
    else if (arg.startsWith('--accept=')) accept = arg.slice('--accept='.length);
    else if (arg === '--max-repairs') maxRepairs = Number(args[++i]);
    else if (arg.startsWith('--max-repairs='))
      maxRepairs = Number(arg.slice('--max-repairs='.length));
    else if (arg === '--max-turns') maxTurns = Number(args[++i]);
    else if (arg.startsWith('--max-turns=')) maxTurns = Number(arg.slice('--max-turns='.length));
    else if (arg === '--device') device = args[++i];
    else if (arg.startsWith('--device=')) device = arg.slice('--device='.length);
    else goal.push(arg);
  }
  return { goal, accept, maxRepairs, maxTurns, device };
}

export function formatTaskStatus(snapshot: TaskStateSnapshot, timeline: string): string {
  const lines: string[] = [
    `TASK      ${snapshot.taskId}`,
    `GOAL      ${snapshot.goal}`,
    `PHASE     ${snapshot.phase} (${snapshot.statusView}${snapshot.outcome ? ` · ${snapshot.outcome}` : ''})`,
  ];
  if (snapshot.targetDeviceId) lines.push(`DEVICE    ${snapshot.targetDeviceId}`);
  if (snapshot.blockedReason) lines.push(`BLOCKED   ${snapshot.blockedReason}`);
  lines.push(
    `ATTEMPTS  ${snapshot.attempt} · repairs ${snapshot.repairs.length} · failures ${snapshot.failures.length} · evidence ${snapshot.evidenceCount}`
  );
  if (snapshot.plan.length > 0) {
    lines.push('PLAN');
    for (const step of snapshot.plan) {
      const mark =
        step.status === 'done'
          ? '[x]'
          : step.status === 'in_progress'
            ? '[>]'
            : step.status === 'failed'
              ? '[!]'
              : step.status === 'skipped'
                ? '[-]'
                : '[ ]';
      lines.push(`  ${mark} ${step.title}${step.detail ? ` — ${step.detail}` : ''}`);
    }
  }
  for (const failure of snapshot.failures) {
    lines.push(
      `FAILURE #${failure.attempt} [${failure.stage}] ${failure.symptom}` +
        (failure.rootCause ? `\n  root cause: ${failure.rootCause}` : '') +
        (failure.resolved ? ' (resolved)' : ' (unresolved)')
    );
  }
  if (snapshot.lastVerdict) {
    lines.push(
      `VERDICT   ${snapshot.lastVerdict.verdict.toUpperCase()} (${snapshot.lastVerdict.unmetRequired} required unmet)`
    );
  }
  if (timeline) {
    lines.push('TIMELINE');
    lines.push(
      timeline
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
    );
  }
  return lines.join('\n');
}

async function latestSnapshot(workspace: string): Promise<TaskStateSnapshot | null> {
  const all = await listTaskStateSnapshots(workspace);
  if (all.length === 0) return null;
  return all.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a));
}

/**
 * Capability discovery (M7): score the goal against workspace skills and the
 * agent's registered tools, and hand the planner a focused summary instead of
 * the full inventory.
 */
export async function buildCapabilityLayerForGoal(
  goal: string,
  ctx: TaskCommandContext
): Promise<string> {
  // A/B switch for measuring the layer itself (and an escape hatch if a bad
  // selection ever misleads a run). Everything discovery does is additive, so
  // 'off' simply restores the pre-v0.16 behaviour.
  if (process.env.MOSS_CAPABILITY_LAYER === 'off') return '';
  try {
    const { loadSkills } = await import('../core/skills/skill-registry.js');
    const { matchTaskCapabilities, buildCapabilityPromptLayer } =
      await import('../core/task/capability.js');
    // Same two sources the agent itself is given (skill-registry contract):
    // workspace skills plus user config skills. Loading only the workspace set
    // made every `<configDir>/skills` skill undiscoverable per task even though
    // the skill tool could load it — the discovery surface was narrower than
    // the real one.
    const skills = loadSkills([
      path.join(ctx.workspace, '.moss', 'skills'),
      ...(ctx.configDir ? [path.join(ctx.configDir, 'skills')] : []),
    ]);
    const duck = ctx.agent as {
      tools?: { getAll?: () => Array<{ name: string; description?: string }> };
    };
    const registered = typeof duck.tools?.getAll === 'function' ? duck.tools.getAll() : [];
    // MCP tools carry wire names (`mcp__<server>__<tool>`). Splitting them out is
    // what lets the matcher score them as MCP capabilities per task instead of
    // treating them as opaque builtins — and the MCP inventory was previously
    // never handed to the matcher at all (Task OS M12 follow-up).
    const builtinTools = registered
      .filter((tool) => !tool.name.startsWith('mcp__'))
      .map((tool) => tool.name);

    // The connected servers' tools/list catalog beats "whatever happens to be
    // registered": lazily-loaded MCP tools are invisible to `agent.tools` until
    // something searches for them, so the agent view alone can only ever select
    // servers, never tools. Catalog wins when present; the registered view stays
    // as the fallback for hosts that wired tools without a registry.
    const catalog = ctx.mcp?.catalog() ?? [];
    const registeredMcp = registered
      .filter((tool) => tool.name.startsWith('mcp__'))
      .map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
      }));
    // Merge both views. The catalog carries every server tool (selection); the
    // registered view carries the per-server `__search` meta-tools. The matcher
    // skips meta-tools as candidates but records their servers — feeding only
    // the catalog left the "no tool matched, search here" fallback dead in the
    // production wiring.
    const mcpByName = new Map<string, { name: string; description?: string }>();
    for (const entry of [...catalog, ...registeredMcp]) {
      if (!mcpByName.has(entry.name)) mcpByName.set(entry.name, entry);
    }
    const mcpTools = [...mcpByName.values()];

    const match = matchTaskCapabilities(goal, {
      skills,
      builtinTools,
      ...(mcpTools.length > 0 ? { mcpTools } : {}),
    });

    // Selection is only real if the selected tools become callable — otherwise
    // the prompt would name tools the provider never offered. The reveal
    // result is the authority: names it did not install are dropped from the
    // layer instead of being advertised as callable.
    const selected = match.candidates
      .filter((candidate) => candidate.kind === 'mcp-tool')
      .map((candidate) => candidate.name);
    const revealed = ctx.mcp && selected.length > 0 ? ctx.mcp.reveal(selected) : selected;
    const revealedSet = new Set(revealed);
    const honestMatch =
      revealed.length === selected.length
        ? match
        : {
            ...match,
            candidates: match.candidates.filter(
              (candidate) => candidate.kind !== 'mcp-tool' || revealedSet.has(candidate.name)
            ),
          };

    return buildCapabilityPromptLayer(honestMatch);
  } catch (error) {
    // Discovery stays best-effort (a broken layer must not break the task), but
    // degrading to "no capabilities" silently would also hide real bugs.
    try {
      const { getRootLogger } = await import('../logger.js');
      getRootLogger()
        .child('task:capability')
        .warn('capability discovery failed; continuing without it', {
          error: error instanceof Error ? error.message : String(error),
        });
    } catch {
      /* logging must never break the run */
    }
    return '';
  }
}

export async function runTaskCommand(
  commandArgs: string[],
  ctx: TaskCommandContext
): Promise<number> {
  const output = ctx.onOutput ?? ((stream, text) => process[stream].write(text));
  const sub = commandArgs[0] ?? 'status';

  if (sub === 'run') {
    const flags = parseFlags(commandArgs.slice(1));
    const goal = flags.goal.join(' ').trim();
    if (!goal) {
      output('stderr', 'moss task run: a goal is required.\n\n' + usage() + '\n');
      return 2;
    }
    const runTurn = createAgentTurnRunner(ctx.agent, ctx.sessionKey, {
      ...(ctx.onAgentEvent ? { onEvent: ctx.onAgentEvent } : {}),
      ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
    });
    const result = await runTask(
      {
        workspaceDir: ctx.workspace,
        runTurn,
        ...(flags.maxRepairs !== undefined && Number.isFinite(flags.maxRepairs)
          ? { maxRepairAttempts: flags.maxRepairs }
          : {}),
        ...(flags.maxTurns !== undefined && Number.isFinite(flags.maxTurns)
          ? { maxTurns: flags.maxTurns }
          : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (progress) => {
          output('stderr', `[task ${progress.phase}] ${progress.detail}\n`);
        },
      },
      goal,
      {
        ...(flags.accept ? { acceptanceCommand: flags.accept } : {}),
        ...(flags.device ? { targetDeviceId: flags.device } : {}),
        capabilityLayer: await buildCapabilityLayerForGoal(goal, ctx),
      }
    );
    output('stdout', summarizeTaskRun(result) + '\n');
    return result.outcome === 'pass' ? 0 : 1;
  }

  if (sub === 'resume') {
    const taskId = commandArgs[1];
    if (!taskId) {
      output('stderr', 'moss task resume: task_id required.\n');
      return 2;
    }
    const runTurn = createAgentTurnRunner(ctx.agent, ctx.sessionKey, {
      ...(ctx.onAgentEvent ? { onEvent: ctx.onAgentEvent } : {}),
      ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
    });
    const result = await resumeTask(
      {
        workspaceDir: ctx.workspace,
        runTurn,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (progress) => {
          output('stderr', `[task ${progress.phase}] ${progress.detail}\n`);
        },
      },
      taskId
    );
    output('stdout', summarizeTaskRun(result) + '\n');
    return result.outcome === 'pass' ? 0 : 1;
  }

  if (sub === 'status') {
    const snapshot = commandArgs[1]
      ? await getTaskStateSnapshot(ctx.workspace, commandArgs[1])
      : await latestSnapshot(ctx.workspace);
    if (!snapshot) {
      output('stdout', 'No tasks in this workspace. Start one: moss task run <goal>\n');
      return 0;
    }
    const events = await listTaskEvents(ctx.workspace, snapshot.taskId);
    output(
      'stdout',
      formatTaskStatus(snapshot, formatTaskTimeline(buildTaskTimeline(events))) + '\n'
    );
    return 0;
  }

  if (sub === 'timeline') {
    const snapshot = commandArgs[1]
      ? await getTaskStateSnapshot(ctx.workspace, commandArgs[1])
      : await latestSnapshot(ctx.workspace);
    if (!snapshot) {
      output('stdout', 'No tasks in this workspace.\n');
      return 0;
    }
    const events = await listTaskEvents(ctx.workspace, snapshot.taskId);
    output('stdout', formatTaskTimeline(buildTaskTimeline(events)) + '\n');
    return 0;
  }

  output('stderr', `Unknown task subcommand "${sub}".\n\n` + usage() + '\n');
  return 2;
}
