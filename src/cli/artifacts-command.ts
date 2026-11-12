/**
 * `moss artifacts` — read-only inspection of what the closed loop recorded.
 *
 * This used to be the separate `moss tasks` command, one letter away from
 * `moss task` and with its own help. It is a workspace command (no model
 * configuration needed), so CI can inspect evidence and verdicts on a machine
 * that never configured a provider. `moss task artifacts` delegates here so the
 * two surfaces cannot drift.
 */
import { isZhLocale } from './cli-locale.js';
import {
  buildTaskTimeline,
  formatTaskTimeline,
  listFailures,
  listTaskEvents,
  listTaskStateSnapshots,
} from '../core/task/task-store.js';
import { runTasksCommand } from './tasks-commands.js';
import { errorMessage } from '../errors.js';

const KINDS = [
  'contracts',
  'list',
  'tasks',
  'snapshots',
  'history',
  'evidence',
  'deployments',
  'acceptance',
  'device',
  'failures',
] as const;
type Kind = (typeof KINDS)[number];

/** Kinds implemented by the original `moss tasks` command. */
const DELEGATED: ReadonlySet<Kind> = new Set([
  'contracts',
  'list',
  'evidence',
  'deployments',
  'acceptance',
  'device',
]);

export function renderArtifactsUsage(zh = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      `  moss artifacts [${KINDS.join('|')}] [--json]`,
      '',
      '  contracts     任务契约：目标、状态、验收标准（默认）',
      '  tasks         任务快照：task id · 阶段 · 目标',
      '  history       每个任务的时间线',
      '  evidence      已记录的证据（指标 / 期望 / 观测 / 结果）',
      '  deployments   部署生命周期记录',
      '  acceptance    验收裁决历史',
      '  device        解析出的设备目标与连接状态',
      '  failures      失败记录（症状 / 阶段）',
      '',
      '不需要模型配置；只读。`moss tasks …` 仍可用，等价于本命令。',
      '',
      '示例：',
      '  moss artifacts',
      '  moss artifacts evidence --json',
      '  moss artifacts tasks',
    ].join('\n');
  }
  return [
    'Usage:',
    `  moss artifacts [${KINDS.join('|')}] [--json]`,
    '',
    '  contracts     task contracts: goal, status, acceptance criteria (default)',
    '  tasks         task snapshots: task id · phase · goal',
    '  history       per-task timelines',
    '  evidence      recorded evidence (metric / expected / observed / result)',
    '  deployments   deployment lifecycle records',
    '  acceptance    acceptance verdict history',
    '  device        resolved device target and connection state',
    '  failures      recorded failures (symptom / stage)',
    '',
    'Read-only and needs no model configuration. `moss tasks …` still works as an alias.',
    '',
    'Examples:',
    '  moss artifacts',
    '  moss artifacts evidence --json',
    '  moss artifacts tasks',
  ].join('\n');
}

function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

export interface ArtifactsCommandContext {
  workspace: string;
  output?: (stream: 'stdout' | 'stderr', text: string) => void;
}

export async function runArtifactsCommand(
  args: readonly string[],
  ctx: ArtifactsCommandContext
): Promise<number> {
  const output =
    ctx.output ?? ((stream: 'stdout' | 'stderr', text: string) => process[stream].write(text));
  const zh = isZhLocale();
  const first = args.find((arg) => !arg.startsWith('-'));
  const rest = args.filter((arg) => arg !== first);
  if (first === undefined && args.includes('--help')) {
    output('stdout', `${renderArtifactsUsage(zh)}\n`);
    return 0;
  }
  const requested = first ?? 'contracts';
  if (!isKind(requested)) {
    output(
      'stderr',
      `unknown kind "${requested}" — use ${KINDS.join(' | ')}\n\n${renderArtifactsUsage(zh)}\n`
    );
    return 2;
  }
  const kind: Kind = requested === 'snapshots' ? 'tasks' : requested;
  const json = args.includes('--json');
  // B332: one envelope for every kind, including the delegated `tasks` ones.
  const emitArtifactsJson = (artifactKind: string, items: unknown): void => {
    output(
      'stdout',
      `${JSON.stringify({ schema: 'moss_artifacts.v1', kind: artifactKind, items }, null, 2)}\n`
    );
  };

  if (DELEGATED.has(kind)) {
    try {
      const delegated = kind === 'contracts' ? 'list' : kind;
      await runTasksCommand([delegated, ...rest], ctx.workspace, json ? { json: true } : {});
      return 0;
    } catch (err) {
      output('stderr', `moss artifacts: ${errorMessage(err)}\n`);
      return 2;
    }
  }

  if (kind === 'tasks' || kind === 'history') {
    const snapshots = await listTaskStateSnapshots(ctx.workspace);
    if (snapshots.length === 0) {
      if (json) {
        emitArtifactsJson(kind, []);
      } else {
        output('stdout', zh ? '此工作区没有任务。\n' : 'No tasks in this workspace.\n');
      }
      return 0;
    }
    if (kind === 'tasks') {
      output(
        'stdout',
        json
          ? `${JSON.stringify({ schema: 'moss_artifacts.v1', kind: 'tasks', items: snapshots }, null, 2)}\n`
          : `${snapshots.map((snapshot) => `${snapshot.taskId}  ${snapshot.phase}  ${snapshot.goal}`).join('\n')}\n`
      );
      return 0;
    }
    if (json) {
      const histories = [];
      for (const snapshot of snapshots) {
        histories.push({
          taskId: snapshot.taskId,
          events: await listTaskEvents(ctx.workspace, snapshot.taskId),
        });
      }
      emitArtifactsJson('history', histories);
      return 0;
    }
    const blocks: string[] = [];
    for (const snapshot of snapshots) {
      const events = await listTaskEvents(ctx.workspace, snapshot.taskId);
      blocks.push(`${snapshot.taskId}\n${formatTaskTimeline(buildTaskTimeline(events))}`);
    }
    output('stdout', `${blocks.join('\n')}\n`);
    return 0;
  }

  // failures
  const failures = await listFailures(ctx.workspace);
  if (json) {
    emitArtifactsJson('failures', failures);
    return 0;
  }
  if (failures.length === 0) {
    output('stdout', zh ? '没有失败记录。\n' : 'No failures recorded.\n');
    return 0;
  }
  // B265: a table without a header read as three anonymous columns; evidence
  // and acceptance already name theirs.
  const idWidth = Math.max(6, ...failures.map((failure) => failure.taskId.length));
  const stageWidth = Math.max(5, ...failures.map((failure) => failure.stage.length));
  const header = `${'TASK ID'.padEnd(idWidth)}  ${'STAGE'.padEnd(stageWidth)}  SYMPTOM`;
  const rule = '─'.repeat(Math.min(120, header.length + 40));
  const rows = failures.map(
    (failure) =>
      `${failure.taskId.padEnd(idWidth)}  ${failure.stage.padEnd(stageWidth)}  ${failure.symptom}`
  );
  output('stdout', `${header}\n${rule}\n${rows.join('\n')}\n`);
  return 0;
}
