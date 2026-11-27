import type { ToolResultOutcome } from '../contracts/messages.js';

const MARKER = '[命令执行结果]';

type ShellExecutionStatus = { outcome?: ToolResultOutcome; exitCode?: number | null };

export const SHELL_SOFT_FAILURE_TOOL_NAMES = new Set(['exec', 'device_exec']);

export function shouldAppendShellContinueHint(
  result: string,
  status?: ShellExecutionStatus
): boolean {
  if (!result || result.includes(MARKER)) return false;
  if (status?.outcome && status.outcome !== 'error') return false;
  if (status?.exitCode !== undefined) return status.exitCode !== null && status.exitCode !== 0;
  return parseShellNonZeroExit(result);
}

function parseShellNonZeroExit(result: string): boolean {
  const tail = result.trimEnd();
  const device = /\[exit code:\s*(\d+)\]\s*$/i.exec(tail);
  if (device) return Number(device[1]) !== 0;
  const local = /\[EXIT CODE\]\s*(\d+)\s*$/.exec(tail);
  if (local) return Number(local[1]) !== 0;
  return false;
}

export function appendShellContinueHint(
  toolName: string,
  result: string,
  status?: ShellExecutionStatus
): string {
  if (!shouldAppendShellContinueHint(result, status)) return result;
  const location = toolName === 'device_exec' ? '设备端' : '本机';
  return (
    result +
    `\n\n${MARKER} ${location}命令返回非零退出码。请根据用户目标判断该结果：可选探测的否定结果可以作为结论；必要步骤失败时可恢复、说明缺少的资源或明确无法继续。审批或安全阻止仍然有效。`
  );
}
