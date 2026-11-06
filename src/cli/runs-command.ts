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
  type RunKind,
} from '../core/run-ledger.js';
import { isZhLocale, uiText } from './cli-locale.js';
import { formatRunUsage } from './run-usage.js';

const RUN_STATUSES: readonly RunRecordStatus[] = [
  'completed',
  'incomplete',
  'verify_failed',
  'blocked',
  'unverified',
  'interrupted',
  'running',
];

const DEFAULT_LIMIT = 20;

export function renderRunsUsage(zh = isZhLocale()): string {
  if (zh) {
    return [
      '用法：',
      '  moss runs [list] [--limit N] [--status <状态>] [--kind <引擎>] [--since <时长|日期>] [--json]',
      '  moss runs show [<run_id>|latest] [--json]',
      '  moss runs export [<run_id>|latest] [--format md|json] [--out <文件>]',
      '  moss runs summary [--since <时长|日期>] [--kind <引擎>] [--by day|week|model] [--json]',
      '  moss runs prune [--keep N] [--dry-run] [--json]',
      '',
      '统一运行账本（.moss/runs/<run_id>/goal.json）：每次 task / loop 等自动运行一条。',
      `  状态：${RUN_STATUSES.join(' | ')}`,
      '  interrupted 表示暂停但可续跑（不是失败）。',
      '',
      '示例：',
      '  moss runs',
      '  moss runs show latest',
      '  moss runs list --kind loop --limit 5',
      '  moss runs list --since 24h --status fail',
      '  moss runs summary --since 7d --by day',
      '  moss runs summary --since 7d --by day',
      '  moss runs list --since 24h --status fail',
      '  moss runs export latest > run.md',
      '  moss runs prune --keep 20 --dry-run',
    ].join('\n');
  }
  return [
    'Usage:',
    '  moss runs [list] [--limit N] [--status <status>] [--kind <engine>] [--since <window|date>] [--json]',
    '  moss runs show [<run_id>|latest] [--json]',
    '  moss runs export [<run_id>|latest] [--format md|json] [--out <file>]',
    '  moss runs summary [--since <window|date>] [--kind <engine>] [--by day|week|model] [--json]',
    '  moss runs prune [--keep N] [--dry-run] [--json]',
    '',
    'Unified run ledger (.moss/runs/<run_id>/goal.json): one row per autonomous run.',
    `  statuses: ${RUN_STATUSES.join(' | ')}`,
    '  interrupted means paused and resumable, not failed.',
    '',
    'Examples:',
    '  moss runs',
    '  moss runs show latest',
    '  moss runs list --kind loop --limit 5',
    '  moss runs export latest > run.md',
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
    running: { en: 'running', zh: '进行中' },
  };
  return zh ? labels[status].zh : labels[status].en;
}

function runningSuffix(counts: Record<string, number>): string {
  const running = counts.running ?? 0;
  return running > 0 ? ` · ${String(running)} running` : '';
}

function runningSuffixZh(counts: Record<string, number>): string {
  const running = counts.running ?? 0;
  return running > 0 ? ` · 进行中 ${String(running)}` : '';
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

const RUN_KINDS: readonly RunKind[] = ['task', 'loop', 'workflow', 'superagent', 'chat'];

interface ListFlags {
  limit: number;
  status?: RunRecordStatus;
  kind?: RunKind;
  /** Inclusive lower bound for `endedAt`, from `--since <n>s|m|h|d` or an ISO date. */
  since?: { cutoff: number; label: string };
  json: boolean;
}

const SINCE_UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `--since` accepts a duration window (`90s`, `30m`, `24h`, `7d`) or an ISO/`YYYY-MM-DD` date. */
export function parseSinceValue(
  raw: string,
  now = Date.now()
): { cutoff: number; label: string } | null {
  const value = raw.trim().toLowerCase();
  const duration = /^(\d+)([smhd])$/.exec(value);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = SINCE_UNITS[duration[2] as string];
    if (unit && Number.isFinite(amount) && amount > 0) {
      return { cutoff: now - amount * unit, label: raw.trim() };
    }
    return null;
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return { cutoff: parsed, label: raw.trim() };
}

function parseListFlags(
  args: readonly string[],
  jsonDefault: boolean
): ListFlags | { error: string } {
  let limit = DEFAULT_LIMIT;
  let status: RunRecordStatus | undefined;
  let kind: RunKind | undefined;
  let since: { cutoff: number; label: string } | undefined;
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
    } else if (arg === '--since' || arg.startsWith('--since=')) {
      const raw = arg.includes('=') ? arg.slice('--since='.length) : (args[++i] ?? '');
      const parsed = parseSinceValue(raw);
      if (!parsed) return { error: '--since must be a duration (90s, 30m, 24h, 7d) or a date' };
      since = parsed;
    } else if (arg === '--kind' || arg.startsWith('--kind=')) {
      const raw = (
        arg.includes('=') ? arg.slice('--kind='.length) : (args[++i] ?? '')
      ).toLowerCase();
      if (!RUN_KINDS.includes(raw as RunKind)) {
        return { error: `unknown --kind ${raw}; use ${RUN_KINDS.join(', ')}` };
      }
      kind = raw as RunKind;
    } else {
      return { error: `unknown argument ${arg}` };
    }
  }
  return {
    limit,
    json,
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(since ? { since } : {}),
  };
}

function renderList(
  records: readonly RunRecord[],
  all: readonly RunRecord[],
  filterLabel = '',
  matched = records.length
): string {
  const counts = countsOf(all);
  const filterSuffix = filterLabel ? ` — ${filterLabel} (${matched})` : '';
  const header =
    uiText(
      `run ledger · ${all.length} total · ${counts.completed ?? 0} pass · ${counts.verify_failed ?? 0} fail · ${counts.blocked ?? 0} blocked · ${counts.interrupted ?? 0} paused · ${counts.incomplete ?? 0} incomplete · ${counts.unverified ?? 0} unverified${runningSuffix(counts)}`,
      `运行账本 · 共 ${all.length} · 通过 ${counts.completed ?? 0} · 失败 ${counts.verify_failed ?? 0} · 阻塞 ${counts.blocked ?? 0} · 暂停 ${counts.interrupted ?? 0} · 未完成 ${counts.incomplete ?? 0} · 未验证 ${counts.unverified ?? 0}${runningSuffixZh(counts)}`
    ) + filterSuffix;
  if (records.length === 0) {
    const empty = filterLabel
      ? uiText(`no runs match ${filterLabel}`, `没有匹配 ${filterLabel} 的运行记录`)
      : uiText(
          'no runs recorded yet — start one with `moss goal "<intent>" --accept "<cmd>"`',
          '还没有运行记录——用 `moss goal "<意图>" --accept "<命令>"` 开始一次'
        );
    return `${header}\n${empty}`;
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
    ...(record.status === 'running'
      ? [uiText('exit', '退出码') + ': —']
      : [
          uiText('duration', '耗时') + `: ${formatDuration(record.durationMs)}`,
          uiText('exit', '退出码') + `: ${record.exitCode}`,
        ]),
  ];
  if (record.model) lines.push(uiText('model', '模型') + `: ${record.model}`);
  if (record.acceptanceCommand)
    lines.push(uiText('acceptance', '验收命令') + `: ${record.acceptanceCommand}`);
  if (record.attempts !== undefined || record.repairs !== undefined || record.turns !== undefined) {
    lines.push(
      uiText('counts', '计数') +
        `: attempts ${record.attempts ?? 0} · repairs ${record.repairs ?? 0} · failures ${record.failures ?? 0} · turns ${record.turns ?? 0}`
    );
  }
  const usageLine = formatRunUsage(record.usage, zh);
  if (usageLine) lines.push(usageLine);
  for (const gate of record.gates ?? []) {
    const label = gate.kind ? `${gate.gate}/${gate.kind}` : gate.gate;
    lines.push(`${uiText('gate', '闸门')}: ${label} — ${gate.reason}`);
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

/** PR/CI-friendly Markdown for one run; English on purpose (a machine artifact). */
export function renderRunMarkdown(record: RunRecord): string {
  const lines = [
    `## Run ${record.runId} — ${record.status}`,
    '',
    `- kind: ${record.kind}`,
    `- goal: ${record.goal}`,
    `- started: ${new Date(record.startedAt).toISOString()}`,
    `- duration: ${formatDuration(record.durationMs)}`,
    `- exit code: ${record.exitCode}`,
  ];
  if (record.acceptanceCommand) lines.push(`- acceptance: ${record.acceptanceCommand}`);
  if (
    record.attempts !== undefined ||
    record.repairs !== undefined ||
    record.failures !== undefined ||
    record.turns !== undefined
  ) {
    lines.push(
      `- attempts: ${record.attempts ?? 0} · repairs: ${record.repairs ?? 0} · failures: ${record.failures ?? 0} · turns: ${record.turns ?? 0}`
    );
  }
  if (record.model) lines.push(`- model: ${record.model}`);
  const usageLine = formatRunUsage(record.usage, false);
  if (usageLine) lines.push(`- ${usageLine}`);
  for (const gate of record.gates ?? []) {
    const label = gate.kind ? `${gate.gate}/${gate.kind}` : gate.gate;
    lines.push(`- gate: ${label} — ${gate.reason}`);
  }
  if (record.reason) lines.push(`- reason: ${record.reason}`);
  if (record.next) lines.push(`- next: \`${record.next}\``);
  const artifacts = Object.entries(record.artifacts ?? {})
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => `${key}=${String(value)}`);
  if (artifacts.length > 0) lines.push(`- artifacts: ${artifacts.join(' · ')}`);
  lines.push('', `<sub>generated by \`moss runs export ${record.runId}\`</sub>`);
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

function filterRuns(all: readonly RunRecord[], parsed: ListFlags): RunRecord[] {
  return all.filter(
    (record) =>
      (!parsed.status || record.status === parsed.status) &&
      (!parsed.kind || record.kind === parsed.kind) &&
      (!parsed.since || record.endedAt >= parsed.since.cutoff)
  );
}

function filterLabelFor(parsed: ListFlags): string {
  return [
    ...(parsed.status ? [`status ${parsed.status}`] : []),
    ...(parsed.kind ? [`kind ${parsed.kind}`] : []),
    ...(parsed.since ? [`since ${parsed.since.label}`] : []),
  ].join(', ');
}

interface RunTotals {
  runs: number;
  pass: number;
  fail: number;
  other: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  withUsage: number;
  withCost: number;
}

function buildRunTotals(records: readonly RunRecord[]): RunTotals {
  const totals: RunTotals = {
    runs: records.length,
    pass: 0,
    fail: 0,
    other: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0,
    withUsage: 0,
    withCost: 0,
  };
  for (const record of records) {
    if (record.status === 'completed') totals.pass += 1;
    else if (record.status === 'verify_failed' || record.status === 'incomplete') totals.fail += 1;
    else totals.other += 1;
    if (!record.usage) continue;
    totals.withUsage += 1;
    totals.inputTokens += record.usage.inputTokens;
    totals.outputTokens += record.usage.outputTokens;
    totals.cacheReadTokens += record.usage.cacheReadTokens ?? 0;
    if (typeof record.usage.costUsd === 'number') {
      totals.withCost += 1;
      totals.costUsd += record.usage.costUsd;
    }
  }
  totals.costUsd = Number(totals.costUsd.toFixed(6));
  return totals;
}

function formatTokenCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export type SummaryGranularity = 'day' | 'week' | 'model';

/** Local-day or ISO-week label for a run's end time (UTC for weeks, local for days). */
export function bucketKeyForRun(endedAt: number, by: Exclude<SummaryGranularity, 'model'>): string {
  const date = new Date(endedAt);
  if (by === 'day') {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${String(year)}-${month}-${day}`;
  }
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (utc.getUTCDay() + 6) % 7; // Monday = 0
  utc.setUTCDate(utc.getUTCDate() - weekday);
  const year = utc.getUTCFullYear();
  const month = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const day = String(utc.getUTCDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day} (week)`;
}

function bucketSummaries(
  records: readonly RunRecord[],
  by: SummaryGranularity
): Array<{ bucket: string } & RunTotals> {
  const buckets = new Map<string, RunRecord[]>();
  for (const record of records) {
    const key = by === 'model' ? (record.model ?? 'unknown') : bucketKeyForRun(record.endedAt, by);
    const rows = buckets.get(key);
    if (rows) rows.push(record);
    else buckets.set(key, [record]);
  }
  const entries = [...buckets.entries()].map(([bucket, rows]) => ({
    bucket,
    ...buildRunTotals(rows),
  }));
  if (by === 'model') {
    return entries.sort(
      (left, right) => right.runs - left.runs || left.bucket.localeCompare(right.bucket)
    );
  }
  return entries.sort((left, right) =>
    left.bucket < right.bucket ? 1 : left.bucket > right.bucket ? -1 : 0
  );
}

function renderSummary(
  all: readonly RunRecord[],
  filtered: readonly RunRecord[],
  kinds: readonly ({ kind: RunKind } & RunTotals)[],
  total: RunTotals,
  filterLabel: string,
  zh: boolean,
  by?: SummaryGranularity
): string {
  const counts = countsOf(all);
  const t = (en: string, cn: string): string => (zh ? cn : en);
  const header =
    uiText(
      `run summary · ${all.length} total · ${counts.completed ?? 0} pass · ${counts.verify_failed ?? 0} fail · ${counts.blocked ?? 0} blocked · ${counts.interrupted ?? 0} paused · ${counts.incomplete ?? 0} incomplete · ${counts.unverified ?? 0} unverified${runningSuffix(counts)}`,
      `运行汇总 · 共 ${all.length} · 通过 ${counts.completed ?? 0} · 失败 ${counts.verify_failed ?? 0} · 阻塞 ${counts.blocked ?? 0} · 暂停 ${counts.interrupted ?? 0} · 未完成 ${counts.incomplete ?? 0} · 未验证 ${counts.unverified ?? 0}${runningSuffixZh(counts)}`
    ) + (filterLabel ? ` — ${filterLabel} (${filtered.length})` : '');
  const lines = [header];
  if (filtered.length === 0) {
    lines.push(
      filterLabel
        ? t(`no runs match ${filterLabel}`, `没有匹配 ${filterLabel} 的运行记录`)
        : t('no runs recorded yet', '还没有运行记录')
    );
    return lines.join('\n');
  }
  const costText = (totals: RunTotals): string => {
    if (totals.withUsage === 0) return t('usage: n/a', '用量：无');
    const tokens = `${t('usage', '用量')}: ${formatTokenCount(totals.inputTokens)} ${t('in', '入')} / ${formatTokenCount(totals.outputTokens)} ${t('out', '出')}`;
    if (totals.withCost === 0) return `${tokens} · ${t('cost: unpriced', '费用：无公开价')}`;
    return `${tokens} · ${t('est.', '估算')} $${totals.costUsd.toFixed(4)} (${totals.withCost}/${totals.withUsage} ${t('priced', '有价')})`;
  };
  if (by) {
    for (const bucket of bucketSummaries(filtered, by)) {
      lines.push(
        `  ${bucket.bucket.padEnd(18)} ${String(bucket.runs).padStart(3)} ${t('runs', '次')} · ${bucket.pass} ${t('pass', '通过')} · ${bucket.fail} ${t('fail', '失败')} · ${bucket.other} ${t('other', '其他')} · ${costText(bucket)}`
      );
    }
  } else {
    for (const entry of kinds) {
      if (entry.runs === 0) continue;
      lines.push(
        `  ${entry.kind.padEnd(10)} ${String(entry.runs).padStart(3)} ${t('runs', '次')} · ${entry.pass} ${t('pass', '通过')} · ${entry.fail} ${t('fail', '失败')} · ${entry.other} ${t('other', '其他')} · ${costText(entry)}`
      );
    }
  }
  lines.push(
    `  ${t('total', '合计').padEnd(10)} ${String(total.runs).padStart(3)} ${t('runs', '次')} · ${total.pass} ${t('pass', '通过')} · ${total.fail} ${t('fail', '失败')} · ${total.other} ${t('other', '其他')} · ${costText(total)}`
  );
  return lines.join('\n');
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
    const filtered = filterRuns(all, parsed);
    const filterLabel = filterLabelFor(parsed);
    const page = filtered.slice(0, parsed.limit);
    if (parsed.json) {
      output(
        'stdout',
        `${JSON.stringify({ version: 1, total: filtered.length, runs: page, counts: countsOf(all), ...(parsed.status ? { status: parsed.status } : {}), ...(parsed.kind ? { kind: parsed.kind } : {}), ...(parsed.since ? { since: new Date(parsed.since.cutoff).toISOString() } : {}) }, null, 2)}\n`
      );
    } else {
      output('stdout', `${renderList(page, all, filterLabel, filtered.length)}\n`);
    }
    return 0;
  }

  if (sub === 'summary') {
    let by: SummaryGranularity | undefined;
    const restNoBy: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index] as string;
      if (arg === '--by' || arg.startsWith('--by=')) {
        const value = (arg.includes('=') ? arg.slice('--by='.length) : (rest[++index] ?? ''))
          .trim()
          .toLowerCase();
        if (value !== 'day' && value !== 'week' && value !== 'model') {
          output('stderr', `--by must be day, week or model\n\n${renderRunsUsage(zh)}\n`);
          return 2;
        }
        by = value;
      } else restNoBy.push(arg);
    }
    const parsed = parseListFlags(restNoBy, ctx.outputJson === true);
    if ('error' in parsed) {
      output('stderr', `${parsed.error}\n\n${renderRunsUsage(zh)}\n`);
      return 2;
    }
    const all = await listRunRecords(ctx.workspace);
    const filtered = filterRuns(all, parsed);
    const kinds = RUN_KINDS.map((kind) => ({
      kind,
      ...buildRunTotals(filtered.filter((r) => r.kind === kind)),
    }));
    const total = buildRunTotals(filtered);
    const filterLabel = filterLabelFor(parsed);
    if (parsed.json) {
      output(
        'stdout',
        `${JSON.stringify(
          {
            version: 1,
            totalRuns: filtered.length,
            ledgerRuns: all.length,
            counts: countsOf(all),
            total,
            kinds,
            ...(by ? { by, buckets: bucketSummaries(filtered, by) } : {}),
            ...(parsed.status ? { status: parsed.status } : {}),
            ...(parsed.kind ? { kind: parsed.kind } : {}),
            ...(parsed.since ? { since: new Date(parsed.since.cutoff).toISOString() } : {}),
          },
          null,
          2
        )}\n`
      );
    } else {
      output('stdout', `${renderSummary(all, filtered, kinds, total, filterLabel, zh, by)}\n`);
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

  if (sub === 'export') {
    let json = ctx.outputJson === true;
    let out: string | undefined;
    let target: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i] as string;
      if (arg === '--json') json = true;
      else if (arg === '--format' || arg.startsWith('--format=')) {
        const value = (
          arg.includes('=') ? arg.slice('--format='.length) : (rest[++i] ?? '')
        ).toLowerCase();
        if (value === 'json') json = true;
        else if (value === 'md' || value === 'markdown') json = false;
        else {
          output('stderr', `unknown --format ${value}; use md or json\n`);
          return 2;
        }
      } else if (arg === '--out' || arg.startsWith('--out=')) {
        const value = arg.includes('=') ? arg.slice('--out='.length) : (rest[++i] ?? '');
        if (!value) {
          output('stderr', '--out needs a file path\n');
          return 2;
        }
        out = value;
      } else if (arg.startsWith('-')) {
        output('stderr', `unknown argument ${arg}\n\n${renderRunsUsage(zh)}\n`);
        return 2;
      } else if (target === undefined) target = arg;
      else {
        output('stderr', `unexpected argument ${arg}\n`);
        return 2;
      }
    }
    const record = await readRunRecord(ctx.workspace, target ?? 'latest');
    if (!record) {
      output(
        'stderr',
        uiText(
          `no run found for "${target ?? 'latest'}"`,
          `没有找到运行记录 "${target ?? 'latest'}"`
        ) + '\n'
      );
      return 2;
    }
    const text = json ? `${JSON.stringify(record, null, 2)}\n` : `${renderRunMarkdown(record)}\n`;
    if (out) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { dirname, resolve } = await import('node:path');
      const absolute = resolve(ctx.workspace, out);
      try {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, text, 'utf8');
      } catch (err) {
        output('stderr', `moss runs export: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      output('stdout', `${uiText('wrote', '已写入')} ${out}\n`);
    } else {
      output('stdout', text);
    }
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
