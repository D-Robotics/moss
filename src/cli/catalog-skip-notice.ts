/**
 * One dim session notice for a skill or command file that was not registered.
 * English and Chinese only; the reason is a stable code from the loader.
 * The `_template` notice is recorded once per project so later launches stay quiet.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isZhLocale } from './cli-locale.js';
import type { SkillSkipReason } from '../core/skills/skill-registry.js';
import { ensureMossRuntimeGitignore } from '../utils/workspace-paths.js';

const REASONS_EN: Record<SkillSkipReason, string> = {
  placeholder: 'name or description is an unfilled template placeholder',
  empty: 'name or description is empty',
  'invalid-name': 'name does not match letters, digits, and . _ : -',
  'hidden-dir': 'folder name starts with "_" or "."',
};

const REASONS_ZH: Record<SkillSkipReason, string> = {
  placeholder: '名称或描述仍是未填写的模板占位符',
  empty: '名称或描述为空',
  'invalid-name': '名称不符合字母、数字以及 . _ : -',
  'hidden-dir': '目录名以 "_" 或 "." 开头',
};

export function formatCatalogSkipNotice(
  file: string,
  reason: SkillSkipReason,
  locale?: string
): string {
  const why = isZhLocale(locale) ? REASONS_ZH[reason] : REASONS_EN[reason];
  return isZhLocale(locale) ? `已跳过 ${file}：${why}` : `Skipped ${file}: ${why}`;
}

/** True for the dim session notice produced above (either locale). */
export function isCatalogSkipNotice(message: string): boolean {
  return message.startsWith('Skipped ') || message.startsWith('已跳过 ');
}

/**
 * Show a catalog skip once per project. Later launches stay quiet for the same
 * file: `_template`, `.hidden`, `_drafts`, and invalid command names included.
 */
export function announceCatalogSkip(
  workspaceDir: string,
  file: string,
  reason: SkillSkipReason,
  locale: string | undefined,
  emit: (line: string) => void
): void {
  if (catalogSkipAnnounced(workspaceDir, file)) return;
  emit(formatCatalogSkipNotice(file, reason, locale));
  rememberCatalogSkip(workspaceDir, file);
}

function noticeRecord(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), '.moss', 'runtime', 'catalog-skip-notices');
}

/** A missing path can be created. A symlink is not followed. */
function missingOrRealDirectory(dir: string): boolean {
  try {
    return fs.lstatSync(dir).isDirectory();
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** True when this project already showed the notice for `file`. */
export function catalogSkipAnnounced(workspaceDir: string, file: string): boolean {
  const record = noticeRecord(workspaceDir);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(record);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  try {
    return fs.readFileSync(record, 'utf8').split('\n').includes(path.resolve(file));
  } catch {
    return false;
  }
}

/**
 * Remember a catalog skip for this project. Failures and symlinks are ignored
 * so startup still runs and a link is not followed out of `.moss/runtime`.
 */
export function rememberCatalogSkip(workspaceDir: string, file: string): void {
  const root = path.resolve(workspaceDir);
  const moss = path.join(root, '.moss');
  const runtime = path.join(moss, 'runtime');
  const record = path.join(runtime, 'catalog-skip-notices');
  const target = path.resolve(file);
  try {
    if (!missingOrRealDirectory(moss) || !missingOrRealDirectory(runtime)) return;
    ensureMossRuntimeGitignore(root);
    if (!fs.existsSync(moss)) fs.mkdirSync(moss);
    if (!fs.lstatSync(moss).isDirectory()) return;
    if (!fs.existsSync(runtime)) fs.mkdirSync(runtime);
    if (!fs.lstatSync(runtime).isDirectory()) return;
    try {
      const existing = fs.lstatSync(record);
      if (!existing.isFile()) return;
      if (fs.readFileSync(record, 'utf8').split('\n').includes(target)) {
        return;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    const fd = fs.openSync(
      record,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | noFollow,
      0o600
    );
    try {
      fs.writeFileSync(fd, `${target}\n`);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // ELOOP from O_NOFOLLOW, or a symlink race: leave the target untouched.
  }
}
