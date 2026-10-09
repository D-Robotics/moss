/**
 * Configurable status line: which fields to show, and an optional shell
 * command whose stdout replaces the line (Claude Code `statusLine`).
 * The command is bounded by a timeout and any failure falls back to the fields.
 */
import { ProcessError, runProcess } from '../utils/run-process.js';
import { safeChildEnv } from '../utils/safe-child-env.js';
import { formatCompactTokenCount } from './usage-display.js';

export const STATUS_LINE_FIELDS = [
  'model',
  'cwd',
  'tokens',
  'cost',
  'context',
  'device',
  'task',
] as const;

export type StatusLineField = (typeof STATUS_LINE_FIELDS)[number];

/** Model, directory/branch, tokens, cost, and context. Device and task stay off until asked. */
export const DEFAULT_STATUS_LINE_FIELDS: readonly StatusLineField[] = [
  'model',
  'cwd',
  'tokens',
  'cost',
  'context',
];

export const DEFAULT_STATUS_COMMAND_TIMEOUT_MS = 1000;

export interface StatusLineConfig {
  fields?: readonly string[];
  /** Shell command. The first stdout line becomes the status line. */
  command?: string;
  timeoutMs?: number;
}

export interface StatusLineSettings {
  fields: readonly StatusLineField[];
  command?: string;
  timeoutMs: number;
}

const FIELD_ALIAS: Readonly<Record<string, StatusLineField>> = {
  branch: 'cwd',
  'context%': 'context',
  contextpct: 'context',
};

const TASK_ZH: Readonly<Record<string, string>> = {
  IDLE: '空闲',
  PLANNING: '规划',
  EXECUTING: '执行',
  BLOCKED: '受阻',
  COMPLETED: '完成',
};

function parseField(raw: string): StatusLineField | undefined {
  const key = raw.trim().toLowerCase();
  if ((STATUS_LINE_FIELDS as readonly string[]).includes(key)) return key as StatusLineField;
  return FIELD_ALIAS[key];
}

export function parseStatusLineConfig(raw: StatusLineConfig | undefined): StatusLineSettings {
  const seen = new Set<StatusLineField>();
  const fields: StatusLineField[] = [];
  if (Array.isArray(raw?.fields)) {
    for (const item of raw.fields) {
      if (typeof item !== 'string') continue;
      const field = parseField(item);
      if (!field || seen.has(field)) continue;
      seen.add(field);
      fields.push(field);
    }
  } else {
    fields.push(...DEFAULT_STATUS_LINE_FIELDS);
  }
  const command = typeof raw?.command === 'string' ? raw.command.trim() : '';
  const timeout =
    typeof raw?.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
      ? Math.min(10_000, Math.max(100, Math.round(raw.timeoutMs)))
      : DEFAULT_STATUS_COMMAND_TIMEOUT_MS;
  return {
    fields,
    ...(command ? { command } : {}),
    timeoutMs: timeout,
  };
}

export interface StatusLineInput {
  model?: string;
  cwd?: string;
  branch?: string;
  tokensIn?: number;
  tokensOut?: number;
  costLabel?: string;
  contextPct?: number;
  device?: string;
  task?: string;
  zh?: boolean;
}

export interface StatusLinePiece {
  field: StatusLineField;
  text: string;
}

export interface StatusLineBuilt {
  parts: StatusLinePiece[];
  contextPart?: string;
  contextPct?: number;
}

export function statusLineParts(
  input: StatusLineInput,
  fields: readonly StatusLineField[]
): StatusLineBuilt {
  const zh = input.zh === true;
  const parts: StatusLinePiece[] = [];
  let contextPart: string | undefined;
  const push = (field: StatusLineField, text: string): void => {
    parts.push({ field, text });
  };
  for (const field of fields) {
    if (field === 'model' && input.model) push('model', input.model);
    if (field === 'cwd') {
      const cwd = input.cwd?.trim();
      const branch = input.branch?.trim();
      if (cwd && branch) push('cwd', `${cwd} (${branch})`);
      else if (cwd) push('cwd', cwd);
      else if (branch) push('cwd', branch);
    }
    if (field === 'tokens') {
      const inn = input.tokensIn ?? 0;
      const out = input.tokensOut ?? 0;
      if (inn > 0 || out > 0) {
        const left = formatCompactTokenCount(inn);
        const right = formatCompactTokenCount(out);
        push('tokens', zh ? `${left} 入 / ${right} 出` : `${left} in / ${right} out`);
      }
    }
    if (field === 'cost' && input.costLabel) push('cost', input.costLabel);
    if (field === 'context' && input.contextPct !== undefined) {
      const pct = Math.min(100, Math.max(0, Math.round(input.contextPct)));
      contextPart = zh ? `${pct}% 上下文` : `${pct}% ctx`;
      push('context', contextPart);
    }
    if (field === 'device' && input.device) {
      push('device', zh ? `设备 ${input.device}` : `device ${input.device}`);
    }
    if (field === 'task' && input.task) {
      const state = input.task.trim();
      const label = zh ? (TASK_ZH[state] ?? state) : state.toLowerCase();
      push('task', zh ? `任务 ${label}` : `task ${label}`);
    }
  }
  return {
    parts,
    ...(contextPart ? { contextPart, contextPct: input.contextPct } : {}),
  };
}

export function formatStatusLine(
  input: StatusLineInput,
  fields: readonly StatusLineField[] = DEFAULT_STATUS_LINE_FIELDS
): string {
  return statusLineParts(input, fields)
    .parts.map((part) => part.text)
    .join(' · ');
}

export interface StatusCommandPayload {
  model?: string;
  cwd?: string;
  branch?: string;
  tokens?: { input: number; output: number };
  cost?: { amount: number; currency: string } | null;
  context?: { used: number; total: number; pct: number } | null;
  device?: string;
  task?: string;
}

export interface StatusCommandResult {
  ok: boolean;
  text?: string;
  reason?: 'timeout' | 'exit' | 'error' | 'empty';
}

const IS_WIN = process.platform === 'win32';

/** Run the user status command. Failures resolve; they never throw. */
export async function runStatusLineCommand(input: {
  command: string;
  cwd: string;
  timeoutMs?: number;
  payload?: StatusCommandPayload;
}): Promise<StatusCommandResult> {
  const command = input.command.trim();
  if (!command) return { ok: false, reason: 'empty' };
  const timeoutMs = input.timeoutMs ?? DEFAULT_STATUS_COMMAND_TIMEOUT_MS;
  const shell = IS_WIN ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh';
  const args = IS_WIN ? ['/c', command] : ['-c', command];
  try {
    const result = await runProcess(shell, {
      args,
      cwd: input.cwd,
      timeout: timeoutMs,
      env: safeChildEnv(),
      stdin: JSON.stringify(input.payload ?? {}),
      maxBuffer: 16_384,
    });
    const text = firstLine(result.stdout);
    if (!text) return { ok: false, reason: 'empty' };
    return { ok: true, text };
  } catch (err) {
    if (err instanceof ProcessError) {
      return { ok: false, reason: err.timedOut ? 'timeout' : 'exit' };
    }
    return { ok: false, reason: 'error' };
  }
}

function firstLine(stdout: string): string {
  const line = stdout.split(/\r?\n/).find((row) => row.trim().length > 0) ?? '';
  return line.trim().slice(0, 500);
}
