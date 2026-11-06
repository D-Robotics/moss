/**
 * `moss task` — the headless face of the unified task runtime (Task OS M5).
 * One natural-language goal in, one verified result out:
 *
 *   moss task run <goal...> [--accept "<cmd>"] [--max-repairs N] [--max-turns N] [--device ID]
 *   moss task resume <task_id> [--accept "<cmd>"]
 *   moss task status [task_id] [--json]   (default: latest; --json prints one object)
 *   moss task timeline [task_id]
 *   moss task list [--limit N] [--status pass|fail|blocked|aborted] [--json]   (goal-run rollup, newest first)
 *
 * Exit code 0 only when the task reached accepted (PASS).
 */
import path from 'node:path';
import {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_MAX_TURNS,
  runTask,
  resumeTask,
  summarizeTaskRun,
} from '../core/task/task-engine.js';
import { createAgentTurnRunner } from '../core/task/agent-turn.js';
import { runUsageFromSlices } from './run-usage.js';
import {
  getTaskStateSnapshot,
  listTaskEvents,
  listTaskStateSnapshots,
  buildTaskTimeline,
  formatTaskTimeline,
  localizeTaskDetail,
} from '../core/task/task-store.js';
import {
  recordGoalRun,
  listGoalRuns,
  projectGoalRunReviews,
} from '../core/task-runtime/goal-runs.js';
import type { GoalRunOutcome } from '../core/task-runtime/goal-runs.js';
import { writeRunRecord } from '../core/run-ledger.js';
import type { RunRecord, RunRecordStatus } from '../core/run-ledger.js';
import { readReviewSummaries } from '../core/loop/review-ledger.js';
import {
  formatGoalRunRows,
  projectFailureReasons,
  projectGoalRunFailures,
  readFailureRecords,
} from './task-list.js';
import type { GoalRunFailure } from './task-list.js';
import { persistedAcceptanceCommand } from '../core/task/acceptance-authority.js';
import { errorMessage } from '../errors.js';
import { resolveDefaultDeviceTarget } from '../device/device-target.js';
import { isResumableTaskPhase, latestTaskFailureDetail } from '../contracts/task-runtime.js';
import type {
  TaskEvent,
  TaskPhase,
  TaskPlanStep,
  TaskStateSnapshot,
  TaskStatusView,
} from '../contracts/task-runtime.js';
import { cliLocale, isZhLocale } from './cli-locale.js';
import { formatTaskProgressLine } from './task-card.js';
import { createSessionUsageAccumulator } from './session-usage.js';
import type { MossAgentEvent } from '../core/agent/moss-agent-types.js';
import { verifyTaskOnce } from './commands/task-verify.js';

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
  /** Top-level `--json` (the CLI arg parser consumes it before the subcommand). */
  outputJson?: boolean;
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

const TASK_WORD_ZH: Record<string, string> = {
  draft: '草稿',
  understanding: '理解中',
  planning: '计划中',
  ready: '就绪',
  executing: '执行中',
  verifying: '验证中',
  diagnosing: '诊断中',
  repairing: '修复中',
  reverifying: '复验中',
  accepted: '已验收',
  failed: '失败',
  blocked: '阻塞',
  abandoned: '已放弃',
  idle: '空闲',
  completed: '已完成',
  aborted: '已中止',
  fail: '失败',
  pass: '通过',
};

/** Phase and status words. English stays the raw id so CLI tests keep their tokens. */
export function localizeTaskWord(word: string, zh: boolean = isZhLocale()): string {
  if (!zh) return word;
  return TASK_WORD_ZH[word] ?? word;
}

/** Bare `/task` in the shell. `verify` and `view` are real subcommands. */
export function interactiveTaskUsageLines(): readonly string[] {
  if (isZhLocale()) {
    return [
      '用法：/task run <目标...> [--accept "<命令>"]',
      '/task status|timeline [标识]',
      '/task list [--limit N] [--status pass|fail|blocked|aborted] [--json]',
      '/task resume [标识]',
      '/task verify [标识]',
      '/task artifacts [种类]',
    ];
  }
  return [
    'usage: /task run <goal...> [--accept "<cmd>"]',
    '/task status|timeline [id]',
    '/task list [--limit N] [--status pass|fail|blocked|aborted] [--json]',
    '/task resume [id]',
    '/task verify [id]',
    '/task artifacts [kind]',
  ];
}

export function renderTaskCliUsage(zh: boolean = isZhLocale()): string {
  if (zh) {
    return [
      '用法：moss task <命令> [选项]',
      '',
      '  run <goal...>        端到端跑一个任务（计划 → 执行 → 验证 → 修复 → 验收）',
      '      --accept "<cmd>"  验收权威：命令必须以退出码 0 结束',
      `      --max-repairs N  诚实报告失败前的修复尝试次数（默认 ${DEFAULT_MAX_REPAIR_ATTEMPTS}）`,
      `      --max-turns N    模型轮次预算（默认 ${DEFAULT_MAX_TURNS}）`,
      '      --device ID      契约指定的目标设备标识',
      '  resume <task_id> [--accept "<cmd>"] [--max-repairs N] [--max-turns N]  恢复一个失败/中断/阻塞的任务（可改正验收命令、给本次重试单独的预算）',
      '  status [task_id]     当前阶段、计划、失败、裁决（默认：最新；--json 输出单个对象供自动化）',
      '  list [--limit N] [--status pass|fail|blocked|aborted]  目标运行汇总：时间/结果/任务/轮次/耗时/目标；fail/blocked 行还会显示记录的失败原因（↳ 原因：…）与评审裁决（默认最近 20 条；表头给出全账本计数，--status 只筛表格与 JSON）',
      '  timeline [task_id]   完整生命周期时间线（默认：最新）',
      '  artifacts [种类]     只读工件：`contracts` | `tasks` | `history` | `evidence` | `deployments` | `acceptance` | `device` | `failures`',
      '  verify [task_id]     用裁决器复验一次（不发起模型回合）',
      '',
      '只有任务被验收（通过）时退出码才是 0。',
      '',
      '选项：',
      '  --accept "<cmd>"   验收命令（退出码必须是 0）',
      `  --max-repairs N    诚实报告失败前的修复次数（默认 ${DEFAULT_MAX_REPAIR_ATTEMPTS}）`,
      `  --max-turns N      模型轮次预算（默认 ${DEFAULT_MAX_TURNS}）`,
      '  --device ID        目标设备标识',
      '',
      '示例：',
      '  `moss task run "创建 ./hello.txt" --accept "grep -q . ./hello.txt"`',
      '  moss task status',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss task <command> [options]',
    '',
    '  run <goal...>        run a task end to end (plan → execute → verify → repair → accept)',
    '      --accept "<cmd>"  acceptance authority: command must exit 0',
    `      --max-repairs N  repair attempts before honest FAIL (default ${DEFAULT_MAX_REPAIR_ATTEMPTS})`,
    `      --max-turns N    agent turn budget (default ${DEFAULT_MAX_TURNS})`,
    '      --device ID      target device id for the contract',
    '  resume <task_id> [--accept "<cmd>"] [--max-repairs N] [--max-turns N]  resume a failed/abandoned/blocked task with an optional oracle fix and its own budget',
    '  status [task_id]     current phase, plan, failures, verdict (default: latest; --json prints one object for automation)',
    '  list [--limit N] [--status pass|fail|blocked|aborted]  goal-run rollup: time/outcome/task/turns/duration/run; fail/blocked rows also show the recorded failure reason and review verdict (default 20; the header counts the whole ledger and --status narrows table and JSON)',
    '  timeline [task_id]   full lifecycle timeline (default: latest)',
    '  artifacts [kind]     read-only artifacts: contracts | tasks | history | evidence | deployments | acceptance | device | failures',
    '  verify [task_id]     re-run the verdict once (no model turn)',
    '',
    'Exit code is 0 only when the task is accepted (PASS).',
    '',
    'Options:',
    '  --accept "<cmd>"   acceptance command (must exit 0)',
    `  --max-repairs N    repair attempts before FAIL (default ${DEFAULT_MAX_REPAIR_ATTEMPTS})`,
    `  --max-turns N      agent turn budget (default ${DEFAULT_MAX_TURNS})`,
    '  --device ID        target device id',
    '',
    'Examples:',
    '  moss task run "create hello.txt" --accept "grep -q hello hello.txt"',
    '  moss task status',
  ].join('\n');
}

/**
 * Quote one argument for `splitCommandArgs`. Spaces, quotes, and backslashes
 * are wrapped so they survive the round trip; a bare token is left alone.
 * A goal that itself contains `--accept` stays one token, so the flag parser
 * does not steal it.
 */
export function quoteCommandArg(value: string): string {
  if (value.length > 0 && !/[\s"\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Minimal shell-ish tokenizer: splits on whitespace but honors double-quoted
 * segments and backslash escapes inside quotes (for --accept "npm test && echo \"ok\"").
 */

export function splitCommandArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  const raw = line.trim();
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i] ?? '';
    if (inQuotes && char === '\\') {
      const next = raw[i + 1];
      if (next === '"' || next === '\\') {
        current += next;
        started = true;
        i += 1;
        continue;
      }
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (started) args.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

/** Parse `run`/`resume` flags. Exported for the offline dispatch probe (B117). */
export function parseFlags(args: string[]): {
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
  let endOfOptions = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (endOfOptions) {
      goal.push(arg ?? '');
      continue;
    }
    if (arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (arg === '--accept') accept = args[++i];
    else if (arg.startsWith('--accept=')) accept = arg.slice('--accept='.length);
    else if (arg === '--max-repairs') maxRepairs = Number(args[++i]);
    else if (arg.startsWith('--max-repairs='))
      maxRepairs = Number(arg.slice('--max-repairs='.length));
    else if (arg === '--max-turns') maxTurns = Number(args[++i]);
    else if (arg.startsWith('--max-turns=')) maxTurns = Number(arg.slice('--max-turns='.length));
    else if (arg === '--device') device = args[++i];
    else if (arg.startsWith('--device=')) device = arg.slice('--device='.length);
    else goal.push(arg ?? '');
  }
  return { goal, accept, maxRepairs, maxTurns, device };
}

export function formatTaskStatus(
  snapshot: TaskStateSnapshot,
  timeline: string,
  zh: boolean = isZhLocale()
): string {
  // Column labels: English pads to 10 chars; zh labels are all two CJK
  // characters (4 display columns) + 6 spaces — same 10-column alignment.
  const label = (en: string, zhLabel: string) => (zh ? `${zhLabel}      ` : en.padEnd(10));
  const phaseText =
    snapshot.outcome === 'aborted'
      ? zh
        ? '已中止'
        : 'aborted'
      : zh
        ? `${localizeTaskWord(snapshot.phase, true)}（${localizeTaskWord(snapshot.statusView, true)}${snapshot.outcome ? ` · ${localizeTaskWord(snapshot.outcome, true)}` : ''}）`
        : `${snapshot.phase} (${snapshot.statusView}${snapshot.outcome ? ` · ${snapshot.outcome}` : ''})`;
  const lines: string[] = [
    `${label('TASK', '任务')}${snapshot.taskId}`,
    `${label('GOAL', '目标')}${snapshot.goal}`,
    `${label('PHASE', '阶段')}${phaseText}`,
  ];
  if (snapshot.targetDeviceId) lines.push(`${label('DEVICE', '设备')}${snapshot.targetDeviceId}`);
  if (snapshot.blockedReason) lines.push(`${label('BLOCKED', '阻塞')}${snapshot.blockedReason}`);
  lines.push(
    `${label('ATTEMPTS', '尝试')}${snapshot.attempt}` +
      (zh
        ? ` · 修复 ${snapshot.repairs.length} · 失败 ${snapshot.failures.length} · 证据 ${snapshot.evidenceCount}`
        : ` · repairs ${snapshot.repairs.length} · failures ${snapshot.failures.length} · evidence ${snapshot.evidenceCount}`)
  );
  if (snapshot.plan.length > 0) {
    lines.push(zh ? '计划' : 'PLAN');
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
      `${zh ? '失败' : 'FAILURE'} #${failure.attempt} [${failure.stage}] ${failure.symptom}` +
        (failure.rootCause
          ? zh
            ? `\n  根因：${failure.rootCause}`
            : `\n  root cause: ${failure.rootCause}`
          : '') +
        (failure.resolved
          ? zh
            ? '（已解决）'
            : ' (resolved)'
          : zh
            ? '（未解决）'
            : ' (unresolved)')
    );
  }
  if (snapshot.lastVerdict) {
    const verdictToken = snapshot.lastVerdict.verdict;
    const verdictLabel = zh
      ? verdictToken === 'pass'
        ? '通过'
        : verdictToken === 'fail'
          ? '失败'
          : verdictToken
      : verdictToken.toUpperCase();
    lines.push(
      `${label('VERDICT', '裁决')}${verdictLabel}` +
        (zh
          ? `（尚缺 ${snapshot.lastVerdict.unmetRequired} 条必需验收）`
          : ` (${snapshot.lastVerdict.unmetRequired} required unmet)`)
    );
  }
  if (timeline) {
    lines.push(zh ? '时间线' : 'TIMELINE');
    const shown = zh
      ? timeline
          .split('\n')
          .map((line) => {
            const mark = ' — ';
            const at = line.lastIndexOf(mark);
            if (at < 0) return line;
            return `${line.slice(0, at)}${mark}${localizeTaskDetail(line.slice(at + mark.length), true)}`;
          })
          .join('\n')
      : timeline;
    lines.push(
      shown
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n')
    );
  }
  return lines.join('\n');
}

/**
 * `moss task status --json` — the machine-readable twin of `formatTaskStatus`.
 *
 * One object with the same facts the human view renders (phase/status/attempts/
 * plan/timeline) plus the fields automation needs to decide what to do next:
 * `resumable`, the persisted acceptance command, the latest failure and the
 * engine's final failure detail. IDs stay raw (never localized); only `timeline`
 * reuses the human formatter, one line per entry, so CI logs read like the CLI.
 */
export interface TaskStatusJson {
  taskId: string;
  goal: string;
  phase: TaskPhase;
  /** Three-way label for automation: `completed` (settled), `live`, `blocked`. */
  status: 'completed' | 'live' | 'blocked';
  attempt: number;
  repairs: number;
  failures: number;
  evidence: number;
  resumable: boolean;
  acceptanceCommand: string | null;
  lastFailure: GoalRunFailure | null;
  blockedReason: string | null;
  engineFailure: string | null;
  plan: { stepId: string; title: string; status: TaskPlanStep['status'] }[];
  timeline: string[];
}

/** Collapse the snapshot's five-way `statusView` into the three-way JSON label. */
export function taskStatusLabel(statusView: TaskStatusView): 'completed' | 'live' | 'blocked' {
  if (statusView === 'completed') return 'completed';
  if (statusView === 'blocked') return 'blocked';
  return 'live';
}

export async function buildTaskStatusJson(
  workspaceDir: string,
  snapshot: TaskStateSnapshot,
  events: readonly TaskEvent[]
): Promise<TaskStatusJson> {
  const acceptanceCommand = await persistedAcceptanceCommand(workspaceDir, snapshot.taskId);
  const lastFailure = projectFailureReasons(snapshot.failures).get(snapshot.taskId) ?? null;
  const timeline = formatTaskTimeline(buildTaskTimeline([...events]));
  return {
    taskId: snapshot.taskId,
    goal: snapshot.goal,
    phase: snapshot.phase,
    status: taskStatusLabel(snapshot.statusView),
    attempt: snapshot.attempt,
    repairs: snapshot.repairs.length,
    failures: snapshot.failures.length,
    evidence: snapshot.evidenceCount,
    resumable: isResumableTaskPhase(snapshot.phase),
    acceptanceCommand: acceptanceCommand ?? null,
    lastFailure,
    blockedReason: snapshot.blockedReason ?? null,
    engineFailure: latestTaskFailureDetail(events) ?? null,
    plan: snapshot.plan.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      status: step.status,
    })),
    timeline: timeline.split('\n').filter((line) => line.length > 0),
  };
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

    return buildCapabilityPromptLayer({
      ...honestMatch,
      deviceConfigured: resolveDefaultDeviceTarget() !== null,
    });
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

export interface LlmUsageStdout {
  inputTokens: number;
  outputTokens: number;
}

/** A headless `{"type":"llm_usage",...}` line. Other stdout is left alone. */
export function parseLlmUsageStdout(text: string): LlmUsageStdout | null {
  const lines = text.trim().split('\n');
  if (lines.length !== 1 || !lines[0]) return null;
  try {
    const parsed: unknown = JSON.parse(lines[0]);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as { type?: unknown; input_tokens?: unknown; output_tokens?: unknown };
    if (record.type !== 'llm_usage') return null;
    if (typeof record.input_tokens !== 'number' || typeof record.output_tokens !== 'number') {
      return null;
    }
    return { inputTokens: record.input_tokens, outputTokens: record.output_tokens };
  } catch {
    return null;
  }
}

function tapUsage(ctx: TaskCommandContext): {
  onAgentEvent: (event: MossAgentEvent) => void;
  line: () => string | null;
  usage: () => import('../core/run-ledger.js').RunRecordUsage | undefined;
} {
  const usage = createSessionUsageAccumulator();
  return {
    onAgentEvent(event) {
      usage.record(event);
      ctx.onAgentEvent?.(event);
    },
    line() {
      const summary = usage.summary();
      if (summary.calls === 0) return null;
      return JSON.stringify({
        type: 'llm_usage',
        input_tokens: summary.inputTokens,
        output_tokens: summary.outputTokens,
      });
    },
    usage() {
      const summary = usage.summary();
      if (summary.calls === 0) return undefined;
      return runUsageFromSlices(summary.slices);
    },
  };
}

/**
 * `--limit N` (default 20), `--status <outcome>` and `--json` for
 * `moss task list`. `passed`/`failed` are aliases like `moss loop list`.
 */
const GOAL_RUN_STATUSES = ['pass', 'fail', 'blocked', 'aborted'] as const;

type ListOptions = { limit: number; json: boolean; status?: GoalRunOutcome } | { error: string };

function listOptions(args: string[]): ListOptions {
  let limit = 20;
  let json = false;
  let status: GoalRunOutcome | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--status' || arg.startsWith('--status=')) {
      const raw = arg.includes('=') ? arg.slice('--status='.length) : (args[++i] ?? '');
      const normalized = raw === 'passed' ? 'pass' : raw === 'failed' ? 'fail' : raw;
      if (!(GOAL_RUN_STATUSES as readonly string[]).includes(normalized)) {
        return {
          error: `--status must be one of ${GOAL_RUN_STATUSES.join('|')} (aliases: passed, failed)`,
        };
      }
      status = normalized as GoalRunOutcome;
      continue;
    }
    if (arg === '--limit' || arg.startsWith('--limit=')) {
      const raw = arg.includes('=') ? arg.slice('--limit='.length) : (args[++i] ?? '');
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        return { error: '--limit must be a positive integer' };
      }
      limit = value;
      continue;
    }
    return { error: `unknown argument ${arg}` };
  }
  return { limit, json, ...(status ? { status } : {}) };
}

/**
 * Append the rollup row. A failed write warns once per run and never changes
 * the task exit code — the run's own verdict already happened.
 */
/**
 * B129: every task run also lands one unified record in `.moss/runs/<id>/goal.json`
 * so `moss runs list|show` can answer "what ran, how did it end, what next"
 * without knowing the per-engine ledgers.
 */
function runRecordForTask(
  result: Awaited<ReturnType<typeof runTask>>,
  startedAt: number,
  goal: string,
  acceptanceCommand: string | undefined,
  sessionKey: string,
  usage?: import('../core/run-ledger.js').RunRecordUsage
): RunRecord {
  const endedAt = Date.now();
  const status: RunRecordStatus =
    result.outcome === 'pass'
      ? 'completed'
      : result.outcome === 'aborted'
        ? 'interrupted'
        : result.outcome === 'blocked'
          ? 'blocked'
          : 'verify_failed';
  const reason = result.failureDetail ?? result.blockedReason ?? result.verdictDetail;
  return {
    version: 1,
    runId: result.snapshot.taskId,
    kind: 'task',
    status,
    exitCode: result.outcome === 'pass' ? 0 : result.outcome === 'aborted' ? 130 : 1,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    goal,
    taskId: result.snapshot.taskId,
    sessionKey,
    ...(acceptanceCommand ? { acceptanceCommand } : {}),
    attempts: result.snapshot.attempt,
    repairs: result.snapshot.repairs.length,
    failures: result.snapshot.failures.length,
    turns: result.turns,
    // A completed run has no failure to report; the snapshot's latest failure is
    // history and must not be attached to a PASS row.
    ...(reason && status !== 'completed' ? { reason } : {}),
    ...(status === 'completed' ? {} : { next: `moss task resume ${result.snapshot.taskId}` }),
    ...(usage ? { usage } : {}),
    artifacts: {
      taskEvents: '.moss/task-events.jsonl',
      evidence: '.moss/evidence.jsonl',
      acceptance: '.moss/acceptance.jsonl',
    },
  };
}

async function recordRun(
  ctx: TaskCommandContext,
  result: Awaited<ReturnType<typeof runTask>>,
  startedAt: number,
  goal: string,
  acceptanceCommand: string | undefined,
  output: (stream: 'stdout' | 'stderr', text: string) => void,
  usage?: import('../core/run-ledger.js').RunRecordUsage
): Promise<void> {
  try {
    await recordGoalRun(ctx.workspace, {
      taskId: result.snapshot.taskId,
      goal,
      phase: result.snapshot.phase,
      outcome: result.outcome,
      attempts: result.snapshot.attempt,
      repairs: result.snapshot.repairs.length,
      turns: result.turns,
      startedAt,
      ...(acceptanceCommand ? { acceptanceCommand } : {}),
      ...(result.snapshot.blockedReason ? { blockedReason: result.snapshot.blockedReason } : {}),
      sessionKey: ctx.sessionKey,
    });
  } catch (err) {
    output('stderr', `[task] could not record the goal run: ${errorMessage(err)}\n`);
  }
  try {
    await writeRunRecord(
      ctx.workspace,
      runRecordForTask(result, startedAt, goal, acceptanceCommand, ctx.sessionKey, usage)
    );
  } catch (err) {
    output('stderr', `[task] could not write the run ledger: ${errorMessage(err)}\n`);
  }
}

/**
 * Exit codes for a headless task run. 130 is the conventional "interrupted"
 * code, so a script can tell Ctrl+C (`aborted`, resumable) from a real failure
 * (1); a pass is still 0.
 */
export function taskOutcomeExitCode(outcome: 'pass' | 'fail' | 'blocked' | 'aborted'): number {
  if (outcome === 'pass') return 0;
  if (outcome === 'aborted') return 130;
  return 1;
}

export async function runTaskCommand(
  commandArgs: string[],
  ctx: TaskCommandContext
): Promise<number> {
  const output = ctx.onOutput ?? ((stream, text) => process[stream].write(text));
  const sub = commandArgs[0] ?? 'status';
  const zh = isZhLocale();
  const locale = cliLocale();

  if (sub === 'run') {
    const flags = parseFlags(commandArgs.slice(1));
    const goal = flags.goal.join(' ').trim();
    if (!goal) {
      output(
        'stderr',
        'moss task run: ' +
          (zh ? '需要一个目标（goal）。\n\n' : 'a goal is required.\n\n') +
          renderTaskCliUsage(zh) +
          '\n'
      );
      return 2;
    }
    const usageTap = tapUsage(ctx);
    const startedAt = Date.now();
    const runTurn = createAgentTurnRunner(ctx.agent, ctx.sessionKey, {
      onEvent: usageTap.onAgentEvent,
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
          output('stderr', `${formatTaskProgressLine(progress.phase)}\n`);
        },
      },
      goal,
      {
        ...(flags.accept ? { acceptanceCommand: flags.accept } : {}),
        ...(flags.device ? { targetDeviceId: flags.device } : {}),
        capabilityLayer: await buildCapabilityLayerForGoal(goal, ctx),
      }
    );
    output('stdout', summarizeTaskRun(result, locale) + '\n');
    const usageLine = usageTap.line();
    if (usageLine) output('stdout', `${usageLine}\n`);
    await recordRun(ctx, result, startedAt, goal, flags.accept, output, usageTap.usage());
    return taskOutcomeExitCode(result.outcome);
  }

  if (sub === 'resume') {
    const resumeFlags = parseFlags(commandArgs.slice(1));
    const taskId = resumeFlags.goal[0];
    if (!taskId) {
      output(
        'stderr',
        zh ? 'moss task resume: 需要 task_id。\n' : 'moss task resume: task_id required.\n'
      );
      return 2;
    }
    const usageTap = tapUsage(ctx);
    const startedAt = Date.now();
    const runTurn = createAgentTurnRunner(ctx.agent, ctx.sessionKey, {
      onEvent: usageTap.onAgentEvent,
      ...(ctx.signal ? { abortSignal: ctx.signal } : {}),
    });
    const result = await resumeTask(
      {
        workspaceDir: ctx.workspace,
        runTurn,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (progress) => {
          output('stderr', `${formatTaskProgressLine(progress.phase)}\n`);
        },
      },
      taskId,
      {
        ...(resumeFlags.accept ? { acceptanceCommand: resumeFlags.accept } : {}),
        // B114: a resume is a retry, not a fresh run — let the caller narrow
        // the repair/turn budget instead of silently granting the defaults.
        ...(resumeFlags.maxRepairs !== undefined && Number.isFinite(resumeFlags.maxRepairs)
          ? { maxRepairAttempts: resumeFlags.maxRepairs }
          : {}),
        ...(resumeFlags.maxTurns !== undefined && Number.isFinite(resumeFlags.maxTurns)
          ? { maxTurns: resumeFlags.maxTurns }
          : {}),
      }
    );
    output('stdout', summarizeTaskRun(result, locale) + '\n');
    const usageLine = usageTap.line();
    if (usageLine) output('stdout', `${usageLine}\n`);
    await recordRun(
      ctx,
      result,
      startedAt,
      result.snapshot.goal,
      resumeFlags.accept,
      output,
      usageTap.usage()
    );
    return taskOutcomeExitCode(result.outcome);
  }

  if (sub === 'list') {
    const parsed = listOptions(commandArgs.slice(1));
    if ('error' in parsed) {
      output('stderr', `moss task list: ${parsed.error}\n`);
      return 2;
    }
    const records = await listGoalRuns(ctx.workspace);
    // The review verdict is only recorded in `.moss/review.jsonl`; project the
    // record that fell inside each run's window so a row says *why* it failed.
    // Failures recorded by the agent (`.moss/task-failures.jsonl`) explain a
    // fail/blocked row the acceptance command alone cannot; like the review
    // verdict they are scoped to that row's own run window.
    const rows = projectGoalRunFailures(
      projectGoalRunReviews(records, readReviewSummaries(ctx.workspace)),
      readFailureRecords(ctx.workspace)
    );
    const scoped = parsed.status ? rows.filter((row) => row.outcome === parsed.status) : rows;
    const newestFirst = [...scoped].sort((left, right) => right.endedAt - left.endedAt);
    if (parsed.json || ctx.outputJson === true) {
      output('stdout', `${JSON.stringify(newestFirst.slice(0, parsed.limit), null, 2)}\n`);
      return 0;
    }
    for (const line of formatGoalRunRows(rows, {
      zh,
      limit: parsed.limit,
      ...(parsed.status ? { status: parsed.status } : {}),
    })) {
      output('stdout', `${line}\n`);
    }
    return 0;
  }

  if (sub === 'status') {
    const json = ctx.outputJson === true || commandArgs.includes('--json');
    const taskId = commandArgs.slice(1).find((arg) => !arg.startsWith('-'));
    const snapshot = taskId
      ? await getTaskStateSnapshot(ctx.workspace, taskId)
      : await latestSnapshot(ctx.workspace);
    if (!snapshot) {
      if (json) {
        output('stdout', `${JSON.stringify(null, null, 2)}\n`);
        return 0;
      }
      output(
        'stdout',
        zh
          ? '本工作区尚无任务。开始一个：moss task run <目标>\n'
          : 'No tasks in this workspace. Start one: moss task run <goal>\n'
      );
      return 0;
    }
    const events = await listTaskEvents(ctx.workspace, snapshot.taskId);
    if (json) {
      const status = await buildTaskStatusJson(ctx.workspace, snapshot, events);
      output('stdout', `${JSON.stringify(status, null, 2)}\n`);
      return 0;
    }
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
      output('stdout', zh ? '本工作区尚无任务。\n' : 'No tasks in this workspace.\n');
      return 0;
    }
    const events = await listTaskEvents(ctx.workspace, snapshot.taskId);
    output('stdout', formatTaskTimeline(buildTaskTimeline(events)) + '\n');
    return 0;
  }

  if (sub === 'verify') {
    const result = await verifyTaskOnce(ctx.workspace, {
      ...(commandArgs[1] ? { taskId: commandArgs[1] } : {}),
    });
    output(result.exitCode === 0 ? 'stdout' : 'stderr', result.summary + '\n');
    return result.exitCode;
  }

  // B131: `moss tasks …` folded into `moss artifacts`; both spellings are read
  // paths over the same inspectors. `view` stays as a deprecated alias.
  if (sub === 'view' || sub === 'artifacts') {
    const { runArtifactsCommand } = await import('./artifacts-command.js');
    return runArtifactsCommand(commandArgs.slice(1), { workspace: ctx.workspace, output });
  }

  output(
    'stderr',
    (zh ? `未知 task 子命令 "${sub}"。\n\n` : `Unknown task subcommand "${sub}".\n\n`) +
      renderTaskCliUsage(zh) +
      '\n'
  );
  return 2;
}
