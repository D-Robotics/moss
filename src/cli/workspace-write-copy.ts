/**
 * Honest description of the `workspace-write` safety mode.
 *
 * The name reads like Codex's Landlock / bubblewrap workspace or Claude Code's
 * seatbelt sandbox. It is not. Moss file tools (`write_file`, `edit_file`,
 * `multi_edit`, `move_file`, `apply_patch`) stay inside the workspace.
 * `exec` runs as the user, with no OS sandbox. A static scan of some shell
 * write targets is not that sandbox. Default stays this way; an opt-in OS
 * sandbox is specified in docs/design/os-sandbox.md.
 */

export const WORKSPACE_WRITE_FILE_TOOLS_EN = "workspace-write confines Moss's own file tools.";

export const WORKSPACE_WRITE_SHELL_EN = 'Shell commands run normally without an OS sandbox.';

/** One sentence pair: the same two facts, in one string. */
export const WORKSPACE_WRITE_LIMIT_EN = `${WORKSPACE_WRITE_FILE_TOOLS_EN} ${WORKSPACE_WRITE_SHELL_EN}`;

export const WORKSPACE_WRITE_FILE_TOOLS_ZH = '`workspace-write` 只约束 Moss 自己的文件工具。';

export const WORKSPACE_WRITE_SHELL_ZH = '终端命令照常运行，没有操作系统沙箱。';

/** One sentence pair: the same two facts, in one string. */
export const WORKSPACE_WRITE_LIMIT_ZH = `${WORKSPACE_WRITE_FILE_TOOLS_ZH}${WORKSPACE_WRITE_SHELL_ZH}`;

/**
 * D14: when the opt-in OS sandbox is on, the static sentence "no OS sandbox"
 * would be false. Keep the default copy, and add the opt-in fact only when the
 * resolved config says it is active (full-access remains a documented no-op).
 */
export function workspaceWriteLimit(zh: boolean, osSandbox = false): string {
  const base = zh ? WORKSPACE_WRITE_LIMIT_ZH : WORKSPACE_WRITE_LIMIT_EN;
  if (!osSandbox) return base;
  return zh
    ? `${WORKSPACE_WRITE_FILE_TOOLS_ZH}exec/后台 exec 走 opt-in 操作系统沙箱（seatbelt/bwrap；full-access 不进入）。`
    : `${WORKSPACE_WRITE_FILE_TOOLS_EN} exec/background exec run inside the opt-in OS sandbox (seatbelt/bwrap; full-access bypasses it).`;
}
