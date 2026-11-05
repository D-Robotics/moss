/**
 * `moss runs` — the read path of the unified run ledger (B129 slice 1).
 *
 * One command answers "what ran, how did it end, what do I do next" without
 * knowing whether the run was a task, a loop or a workflow. Details stay in the
 * per-engine ledgers; this only indexes them.
 */
import {
  listRunRecords,
  pruneRunRecords,
  readRunRecord,
  type RunRecord,
  type RunRecordStatus,
} from '../core/run-ledger.js';
import { isZhLocale, uiText } from './cli-locale.js';

const RUN_STATUSES: readonly RunRecordStatus[] = [
  'completed',
  'incomplete',
  'verify_failed',
  'blocked',
  'unverified',
  'interrupted',
];

const DEFAULT_LIMIT = 20;

export function renderRunsUsage(zh = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss runs [list] [--limit N] [--status <状态>] [--json]',
      '  moss runs show [<run_id>|latest] [--json]',
      '  moss runs prune [--keep N] [--dry-run] [--json]',
      '',
      '统一运行账本（.moss/runs/<run_id>/run.json）：每次 task / loop 等自动运行一条。',
      `  状态：${RUN_STATUSES.join(' | ')}`,
      '  interrupted 表示暂停但可续跑（不是失败）。',
      '',
      '示例：',
      '  moss runs',
      '  moss runs show latest',
      '  moss runs list --status verify_failed --json',
      '  moss runs prune --keep 20 --dry-run',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss runs [list] [--limit N] [--status <status>] [--json]',
    '  moss runs show [<run_id>|latest] [--json]',
    '  moss runs prune [--keep N] [--dry-run] [--json]',
    '',
    'Unified run ledger (.moss/runs/<run_id>/run.json): one row per autonomous run.',
    `  statuses: ${RUN_STATUSES.join(' | ')}`,
    '  interrupted means paused and resumable, not failed.',
    '',
    'Examples:',
    '  moss runs',
    '  moss runs show latest',
    '  moss runs list --status verify_failed --json',
    '  moss runs prune --keep 20 --dry-run',
  ].join('\n');
}

/** Local `MM-DD HH:MM` so a ledger row reads like the wall clock the user saw. */
function formatLocalTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds - minutes * 60)}s`;
}

function statusLabel(status: RunRecordStatus, zh: boolean): string {
  const labels: Record<RunRecordStatus, { en: string; zh: string }> = {
    completed: { en: 'pass', zh: '通过' },
    incomplete: { en: 'incomplete', zh: '未完成' },
    verify_failed: { en: 'fail', zh: '失败' },
    blocked: { en: 'blocked', zh: '阻塞' },
    unverified: { en: 'unverified', zh: '未验证' },
    interrupted: { en: 'paused', zh: '暂停' },
  };
  return zh ? labels[status].zh : labels[status].en;
}

function countsOf(records: readonly RunRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const record of records) counts[record.status] = (counts[record.status] ?? 0) + 1;
  return counts;
}

export interface RunsCommandContext {
  workspace: string;
  /** Top-level `--json` was consumed by the CLI parser before the subcommand. */
  outputJson?: boolean;
  output?: (stream: 'stdout' | 'stderr', text: string) => void;
}

interface ListFlags {
  limit: number;
  status?: RunRecordStatus;
  json: boolean;
}

function parseListFlags(
  args: readonly string[],
  jsonDefault: boolean
): ListFlags | { error: string } {
  let limit = DEFAULT_LIMIT;
  let status: RunRecordStatus | undefined;
  let json = jsonDefault;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--limit' || arg.startsWith('--limit=')) {
      const raw = arg.includes('=') ? arg.slice('--limit='.length) : (args[++i] ?? '');
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1)
        return { error: '--limit must be a positive integer' };
      limit = value;
    } else if (arg === '--status' || arg.startsWith('--status=')) {
      const raw = (
        arg.includes('=') ? arg.slice('--status='.length) : (args[++i] ?? '')
      ).toLowerCase();
      const aliases: Record<string, RunRecordStatus> = {
        pass: 'completed',
        passed: 'completed',
        fail: 'verify_failed',
        failed: 'verify_failed',
        paused: 'interrupted',
        aborted: 'interrupted',
      };
      const resolved = (aliases[raw] ?? raw) as RunRecordStatus;
      if (!RUN_STATUSES.includes(resolved)) {
        return { error: `unknown --status ${raw}; use ${RUN_STATUSES.join(', ')}` };
      }
      status = resolved;
    } else {
      return { error: `unknown argument ${arg}` };
    }
  }
  return { limit, json, ...(status ? { status } : {}) };
}

function renderList(records: readonly RunRecord[], all: readonly RunRecord[]): string {
  const counts = countsOf(all);
  const header = uiText(
    `run ledger · ${all.length} total · ${counts.completed ?? 0} pass · ${counts.verify_failed ?? 0} fail · ${counts.blocked ?? 0} blocked · ${counts.interrupted ?? 0} paused · ${counts.incomplete ?? 0} incomplete · ${counts.unverified ?? 0} unverified`,
    `运行账本 · 共 ${all.length} · 通过 ${counts.completed ?? 0} · 失败 ${counts.verify_failed ?? 0} · 阻塞 ${counts.blocked ?? 0} · 暂停 ${counts.interrupted ?? 0} · 未完成 ${counts.incomplete ?? 0} · 未验证 ${counts.unverified ?? 0}`
  );
  if (records.length === 0) {
    return `${header}\n${uiText('no runs recorded yet — start one with `moss run "<intent>" --accept "<cmd>"`', '还没有运行记录——用 `moss run "<意图>" --accept "<命令>"` 开始一次')}`;
  }
  const lines = [header];
  for (const record of records) {
    const at = formatLocalTime(record.endedAt);
    lines.push(
      uiText(
        `${at}  ${statusLabel(record.status, false).padEnd(10)} ${record.kind.padEnd(6)} ${record.runId}  ${formatDuration(record.durationMs)}`,
        `${at}  ${statusLabel(record.status, true)}  ${record.kind.padEnd(6)} ${record.runId}  ${formatDuration(record.durationMs)}`
      )
    );
    lines.push(`  ${record.goal}`);
    if (record.reason) lines.push(`  ↳ ${uiText('reason', '原因')}: ${record.reason}`);
    if (record.next) lines.push(`  ↳ ${uiText('next', '下一步')}: ${record.next}`);
  }
  return lines.join('\n');
}

function renderShow(record: RunRecord, zh: boolean): string {
  const lines = [
    `${record.runId} — ${statusLabel(record.status, zh)}`,
    uiText('kind', '类型') + `: ${record.kind}`,
    uiText('goal', '目标') + `: ${record.goal}`,
    uiText('started', '开始') + `: ${new Date(record.startedAt).toISOString()}`,
    uiText('duration', '耗时') + `: ${formatDuration(record.durationMs)}`,
    uiText('exit', '退出码') + `: ${record.exitCode}`,
  ];
  if (record.acceptanceCommand)
    lines.push(uiText('acceptance', '验收命令') + `: ${record.acceptanceCommand}`);
  if (record.attempts !== undefined || record.repairs !== undefined || record.turns !== undefined) {
    lines.push(
      uiText('counts', '计数') +
        `: attempts ${record.attempts ?? 0} · repairs ${record.repairs ?? 0} · failures ${record.failures ?? 0} · turns ${record.turns ?? 0}`
    );
  }
  if (record.reason) lines.push(uiText('reason', '原因') + `: ${record.reason}`);
  if (record.next) lines.push(uiText('next', '下一步') + `: ${record.next}`);
  if (record.artifacts) {
    const parts = Object.entries(record.artifacts)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => `${key}=${value}`);
    if (parts.length > 0) lines.push(uiText('artifacts', '工件') + `: ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}

function parseKeep(
  args: readonly string[],
  jsonDefault: boolean
): { keep: number; dryRun: boolean; json: boolean } | { error: string } {
  let keep = 50;
  let dryRun = false;
  let json = jsonDefault;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--json') json = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--keep' || arg.startsWith('--keep=')) {
      const raw = arg.includes('=') ? arg.slice('--keep='.length) : (args[++i] ?? '');
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1)
        return { error: '--keep must be a positive integer' };
      keep = value;
    } else return { error: `unknown argument ${arg}` };
  }
  return { keep, dryRun, json };
}

export async function runRunsCommand(
  args: readonly string[],
  ctx: RunsCommandContext
): Promise<number> {
  const output =
    ctx.output ?? ((stream: 'stdout' | 'stderr', text: string) => process[stream].write(text));
  const zh = isZhLocale();
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'list';
  const rest = args[0] && !args[0].startsWith('-') ? args.slice(1) : args;

  if (sub === 'list') {
    const parsed = parseListFlags(rest, ctx.outputJson === true);
    if ('error' in parsed) {
      output('stderr', `${parsed.error}\n\n${renderRunsUsage(zh)}\n`);
      return 2;
    }
    const all = await listRunRecords(ctx.workspace);
    const filtered = parsed.status ? all.filter((record) => record.status === parsed.status) : all;
    const page = filtered.slice(0, parsed.limit);
    if (parsed.json) {
      output(
        'stdout',
        `${JSON.stringify({ version: 1, total: filtered.length, runs: page, counts: countsOf(all) }, null, 2)}\n`
      );
    } else {
      output('stdout', `${renderList(page, all)}\n`);
    }
    return 0;
  }

  if (sub === 'show') {
    let parsed: { json: boolean } = { json: ctx.outputJson === true };
    let target = 'latest';
    for (const arg of rest) {
      if (arg === '--json') parsed = { json: true };
      else if (arg.startsWith('-')) {
        output('stderr', `unknown argument ${arg}\n\n${renderRunsUsage(zh)}\n`);
        return 2;
      } else target = arg;
    }
    const record = await readRunRecord(ctx.workspace, target);
    if (!record) {
      output(
        'stderr',
        uiText(`no run found for "${target}"`, `没有找到运行记录 "${target}"`) + '\n'
      );
      return 2;
    }
    if (parsed.json) output('stdout', `${JSON.stringify(record, null, 2)}\n`);
    else output('stdout', `${renderShow(record, zh)}\n`);
    return 0;
  }

  if (sub === 'prune') {
    const parsed = parseKeep(rest, ctx.outputJson === true);
    if ('error' in parsed) {
      output('stderr', `${parsed.error}\n\n${renderRunsUsage(zh)}\n`);
      return 2;
    }
    const result = await pruneRunRecords(ctx.workspace, {
      keep: parsed.keep,
      dryRun: parsed.dryRun,
    });
    if (parsed.json) {
      output(
        'stdout',
        `${JSON.stringify({ version: 1, ...result, dryRun: parsed.dryRun }, null, 2)}\n`
      );
    } else {
      const verb = parsed.dryRun ? uiText('would remove', '将删除') : uiText('removed', '已删除');
      output(
        'stdout',
        `${uiText('run ledger', '运行账本')}: ${verb} ${result.removed.length}, ${uiText('kept', '保留')} ${result.kept}, ${uiText('freed', '释放')} ${result.bytes}B\n` +
          (result.removed.length > 0 ? `${result.removed.join('\n')}\n` : '')
      );
    }
    return 0;
  }

  output(
    'stderr',
    `${uiText(`unknown runs subcommand "${sub}"`, `未知 runs 子命令 "${sub}"`)}\n\n${renderRunsUsage(zh)}\n`
  );
  return 2;
}
