/** Fixed startup notices: untrusted paths and error messages never reach the terminal. */
export function formatWorkspaceMigrationNotices(
  hasSkippedPaths: boolean,
  hasCleanupWarnings: boolean,
  zh: boolean
): string[] {
  const notices: string[] = [];
  if (hasSkippedPaths) {
    notices.push(
      zh
        ? '[moss] 部分旧技能条目未迁移，可能不会加载；其他条目可能已经迁移。'
        : '[moss] Some legacy skill entries were not migrated and may not load; other entries may already have moved.'
    );
    notices.push(
      zh
        ? '[moss] 请在可信环境检查工作区的 skills/、skill-candidates/、agent/skills/ 以及 .moss/skills/、.moss/agent/skills/。检查软链接和冲突后，可保留原状或手动移动、复制所需内容。'
        : '[moss] In a trusted environment, review workspace skills/, skill-candidates/, agent/skills/ and destinations .moss/skills/ and .moss/agent/skills/. Check links and conflicts, then keep entries or manually move or copy needed content.'
    );
  }
  if (hasCleanupWarnings) {
    notices.push(
      zh
        ? '[moss] 部分旧技能目录无法检查或清理，可能仍然存在；其他条目可能已经迁移。'
        : '[moss] Some old skill directories could not be checked or cleaned and may still exist; other entries may already have moved.'
    );
    notices.push(
      zh
        ? '[moss] 请在可信环境检查工作区的 skills/、skill-candidates/ 和 agent/skills/，确认权限和内容后再决定是否删除。'
        : '[moss] In a trusted environment, review workspace skills/, skill-candidates/ and agent/skills/. Check permissions and contents before removing anything.'
    );
  }
  return notices;
}
