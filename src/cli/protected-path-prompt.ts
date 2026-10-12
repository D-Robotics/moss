/**
 * O94: copy + dialog for protected-path confirmations. Deny is the first
 * option (the TUI cursor starts at 0, so Enter denies) and the string prompt
 * treats an empty answer as deny. "Always" is scoped to this path for this
 * session only and is never persisted.
 */
import * as os from 'node:os';
import * as path from 'node:path';

import { PROTECTED_CATEGORY_LABEL, type ProtectedPathHit } from '../safety/protected-paths.js';
import { sanitizeSecrets } from '../safety/secret-sanitizer.js';
import type { CliApprovalView } from './approval-view.js';

const OP_EN: Record<ProtectedPathHit['operation'], string> = {
  write: 'write to',
  delete: 'delete',
  move: 'move',
  shell: 'run a shell command that writes to',
};
const OP_ZH: Record<ProtectedPathHit['operation'], string> = {
  write: '写入',
  delete: '删除',
  move: '移动',
  shell: '用 shell 命令写入',
};

function shown(hit: ProtectedPathHit): string {
  return sanitizeSecrets(hit.raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 200);
}

/** O101: "deploy.py line 12 would write ~/.ssh/authorized_keys". */
function sourceClause(hit: ProtectedPathHit, zh: boolean): string {
  const src = hit.source;
  if (!src) return '';
  const script = src.script.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
  if (src.kind === 'inline') {
    return zh
      ? `（内联 ${script}${src.line ? ` 第 ${src.line} 行` : ''}）`
      : ` (inline ${script}${src.line ? ` line ${src.line}` : ''})`;
  }
  return zh
    ? `（\`${script}\`${src.line ? ` 第 ${src.line} 行` : ''}）`
    : ` (\`${script}\`${src.line ? ` line ${src.line}` : ''})`;
}

/**
 * O103: why-clause per hit. Normal → "X 是受保护路径（label）"; hooksPath →
 * "X 会改 git 钩子目录（core.hooksPath）"; unresolved download target → one
 * honest line that it cannot be classified.
 */
function whyClause(hit: ProtectedPathHit, zh: boolean): string {
  if (hit.kind === 'hooks-path') {
    return zh
      ? `${shown(hit)} 会改 git 钩子目录（core.hooksPath）`
      : `${shown(hit)} would redirect git hooks (core.hooksPath)`;
  }
  const label = PROTECTED_CATEGORY_LABEL[hit.category];
  if (hit.category === 'unresolved')
    return `${shown(hit)}${zh ? '：' : ': '}${zh ? label.zh : label.en}`;
  return zh
    ? `${shown(hit)} 是受保护路径（${label.zh}）`
    : `${shown(hit)} is a protected path (${label.en})`;
}

/** First line: operation + the path as named + why (+ O101 script/line). */
export function protectedPathHeadline(hit: ProtectedPathHit, zh: boolean): string {
  const label = PROTECTED_CATEGORY_LABEL[hit.category];
  const src = sourceClause(hit, zh);
  if (hit.kind === 'hooks-path') {
    return zh
      ? `要执行 \`${shown(hit)}\`：会改 git 钩子目录（core.hooksPath）`
      : `About to run \`${shown(hit)}\`: would redirect git hooks (core.hooksPath)`;
  }
  if (hit.category === 'unresolved') {
    return zh
      ? `要${OP_ZH[hit.operation]} \`${shown(hit)}\`${src}：${label.zh}`
      : `About to ${OP_EN[hit.operation]} \`${shown(hit)}\`${src}: ${label.en}`;
  }
  return zh
    ? `要${OP_ZH[hit.operation]} \`${shown(hit)}\`${src}（${label.zh}，受保护路径）`
    : `About to ${OP_EN[hit.operation]} \`${shown(hit)}\`${src} (${label.en}, a protected path)`;
}

export function protectedPathView(
  toolName: string,
  hits: readonly ProtectedPathHit[],
  zh: boolean
): CliApprovalView {
  const first = hits[0]!;
  const extra = hits.slice(1).map((h) => protectedPathHeadline(h, zh));
  return {
    title: protectedPathHeadline(first, zh),
    subject: shown(first),
    preview: [
      zh
        ? `工具：${toolName}。受保护路径即使在 full 模式下也要确认一次。`
        : `Tool: ${toolName}. Protected paths need one confirmation even in full mode.`,
      ...extra,
    ],
    question: zh ? '允许这一次操作吗？（默认拒绝）' : 'Allow this one operation? (default: deny)',
    options: [
      { key: '1', answer: 'n', label: zh ? '拒绝（默认）' : 'No, deny (default)' },
      { key: '2', answer: 'y', label: zh ? '允许这一次' : 'Yes, this once' },
      {
        key: '3',
        answer: 'a',
        label: zh ? '本会话内同一路径都允许' : 'Yes, for this path for the rest of this session',
      },
    ],
    footer: zh ? 'Esc 或回车 = 拒绝 · ↑↓ 选择' : 'Esc or Enter = deny · ↑↓ to choose',
  };
}

export function protectedPathStringPrompt(view: CliApprovalView, zh: boolean): string {
  return [
    view.title,
    ...(view.preview ?? []),
    zh
      ? `${view.question} [y] 允许这一次 / [a] 本会话同一路径都允许 / [N] 拒绝: `
      : `${view.question} [y] once / [a] this path this session / [N] deny: `,
  ].join('\n');
}

export function protectedPathDeniedReason(hit: ProtectedPathHit, zh: boolean): string {
  const special = hit.kind === 'hooks-path' || hit.category === 'unresolved';
  const whatZh = special
    ? ` ${whyClause(hit, true)}`
    : `受保护路径 ${shown(hit)}（${PROTECTED_CATEGORY_LABEL[hit.category].zh}）`;
  const whatEn = special
    ? `: ${whyClause(hit, false)}`
    : ` of protected path ${shown(hit)} (${PROTECTED_CATEGORY_LABEL[hit.category].en})`;
  return zh
    ? `已拦截：用户拒绝${OP_ZH[hit.operation]}${whatZh}。不要改用 shell、node -e 或其他工具再写这个路径；如果确实需要，请告诉用户由用户自己处理。`
    : `Blocked: the user denied the ${hit.operation}${whatEn}. Do not retry it through the shell, node -e, or another tool; if it is really needed, tell the user so they can do it themselves.`;
}

export function protectedPathHeadlessReason(hit: ProtectedPathHit, zh: boolean): string {
  return zh
    ? `已拦截：${whyClause(hit, true)}，非交互模式下无法确认，已拒绝${OP_ZH[hit.operation]}。不要改用 shell、node -e 或其他工具再写这个路径。`
    : `Blocked: ${whyClause(hit, false)}; Moss is running non-interactively and cannot confirm, so the ${hit.operation} was denied. Do not retry it through the shell, node -e, or another tool.`;
}

export function protectedPathHeadlessNotice(hit: ProtectedPathHit, zh: boolean): string {
  const label = PROTECTED_CATEGORY_LABEL[hit.category];
  if (hit.kind === 'hooks-path' || hit.category === 'unresolved') {
    return zh
      ? `[moss] 已拦截：${whyClause(hit, true)}，-p 模式无法确认。放行办法：不带 -p 交互运行 moss，在提示里确认这一次；或者自己手动处理。`
      : `[moss] Blocked: ${whyClause(hit, false)}; -p cannot ask. To allow: run moss interactively (without -p) and confirm this once, or do it yourself.`;
  }
  return zh
    ? `[moss] 已拦截：${OP_ZH[hit.operation]} ${shown(hit)}。原因：它是受保护路径（${label.zh}），-p 模式无法确认。放行办法：不带 -p 交互运行 moss，在提示里确认这一次；或者自己手动改这个文件。`
    : `[moss] Blocked: ${hit.operation} ${shown(hit)}. Why: it is a protected path (${label.en}) and -p cannot ask. To allow: run moss interactively (without -p) and confirm this once, or make the change yourself.`;
}

/** Session grant key for "always for this path". */
export function protectedGrantKey(hit: ProtectedPathHit): string {
  return path.resolve(hit.resolved).replace(/\\/g, '/').toLowerCase();
}

export function mossConfigDirs(configDir: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  return [configDir, path.join(home, '.moss')];
}
