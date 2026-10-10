import fs from 'node:fs';
import path from 'node:path';

export interface MossWorkspacePaths {
  workspaceDir: string;
  runtimeDir: string;
  sessionsDir: string;
  memoryDir: string;
  checkpointsDir: string;
  attachmentsDir: string;
  projectConfigPath: string;
  skillsDir: string;
  learnedSkillsDir: string;
  skillCandidatesDir: string;
  agentSkillsDir: string;
  legacySkillsDir: string;
  legacyLearnedSkillsDir: string;
  legacySkillCandidatesDir: string;
  legacyAgentSkillsDir: string;
}

export interface WorkspacePathMigrationResult {
  paths: MossWorkspacePaths;
  migratedPaths: string[];
  skippedPaths: string[];
}

export function getMossWorkspacePaths(workspaceDir: string): MossWorkspacePaths {
  const root = path.resolve(workspaceDir);
  const runtimeDir = path.join(root, '.moss');
  const skillsDir = path.join(runtimeDir, 'skills');
  const legacySkillsDir = path.join(root, 'skills');
  return {
    workspaceDir: root,
    runtimeDir,
    sessionsDir: path.join(runtimeDir, 'sessions'),
    memoryDir: path.join(runtimeDir, 'memory'),
    checkpointsDir: path.join(runtimeDir, 'checkpoints'),
    attachmentsDir: path.join(runtimeDir, 'attachments'),
    projectConfigPath: path.join(runtimeDir, 'config.json'),
    skillsDir,
    learnedSkillsDir: path.join(skillsDir, 'learned'),
    skillCandidatesDir: path.join(skillsDir, 'candidates'),
    agentSkillsDir: path.join(runtimeDir, 'agent', 'skills'),
    legacySkillsDir,
    legacyLearnedSkillsDir: path.join(legacySkillsDir, 'learned'),
    legacySkillCandidatesDir: path.join(root, 'skill-candidates'),
    legacyAgentSkillsDir: path.join(root, 'agent', 'skills'),
  };
}

export function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function removeIfEmpty(dir: string): void {
  if (!pathExists(dir)) return;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

function migratePath(src: string, dest: string, result: WorkspacePathMigrationResult): void {
  if (!pathExists(src)) return;
  const srcStat = fs.lstatSync(src);
  if (!pathExists(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    fs.renameSync(src, dest);
    result.migratedPaths.push(`${src} -> ${dest}`);
    return;
  }

  const destStat = fs.lstatSync(dest);
  if (srcStat.isDirectory() && destStat.isDirectory()) {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      migratePath(path.join(src, entry.name), path.join(dest, entry.name), result);
    }
    removeIfEmpty(src);
    return;
  }

  result.skippedPaths.push(`${src} -> ${dest}`);
}

function migrateLegacySkillDirs(
  paths: MossWorkspacePaths,
  result: WorkspacePathMigrationResult
): void {
  if (!pathExists(paths.legacySkillsDir)) return;
  for (const entry of fs.readdirSync(paths.legacySkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'learned') continue;
    const legacySkillDir = path.join(paths.legacySkillsDir, entry.name);
    if (!pathExists(path.join(legacySkillDir, 'SKILL.md'))) continue;
    migratePath(legacySkillDir, path.join(paths.skillsDir, entry.name), result);
  }
}

/**
 * Runtime files under `.moss/`. Shared project files (config.json, mcp.json,
 * skills/, agents/, commands/, tools/, devices.json, soul.md) stay visible.
 * Patterns are relative to `.moss/`. Written once; a file the user already
 * has is left alone. Never edits `.git`.
 */
const RUNTIME_GITIGNORE = `# Moss runtime artifacts. Not a substitute for a project .gitignore.
# Shared files stay visible: config.json, mcp.json, skills/, agents/,
# commands/, tools/, devices.json, soul.md. New shared files show in git status.
sessions/
memory/
checkpoints/
attachments/
inbox/
events/
context-epoch/
logs/
experience/
worktrees/
patches/
runtime/
skills/learned/
skills/candidates/
.gitignore
prompt-history.jsonl
tasks.jsonl
evidence.jsonl
deployments.jsonl
acceptance.jsonl
task-events.jsonl
task-failures.jsonl
task-repairs.jsonl
*.lock
`;

/** A directory that git would accept as a git dir: it has a HEAD file. */
function isGitDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory() && fs.statSync(path.join(dir, 'HEAD')).isFile();
  } catch {
    return false;
  }
}

/** A `.git` directory, or a gitfile whose `gitdir:` target is a git dir. */
function resolvesAsGitMetadata(gitPath: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(gitPath);
  } catch {
    return false;
  }
  // git itself ignores a .git directory without HEAD; so do we.
  if (st.isDirectory()) return isGitDir(gitPath);
  if (!st.isFile()) return false;
  let text: string;
  try {
    text = fs.readFileSync(gitPath, 'utf8');
  } catch {
    return false;
  }
  const gitdir = /^gitdir:\s*(.+)\s*$/m.exec(text)?.[1]?.trim();
  if (!gitdir) return false;
  try {
    return isGitDir(path.resolve(path.dirname(gitPath), gitdir));
  } catch {
    return false;
  }
}

function insideGitWorkTree(start: string): boolean {
  let current = path.resolve(start);
  for (;;) {
    if (resolvesAsGitMetadata(path.join(current, '.git'))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Write `.moss/.gitignore` the first time a runtime artifact is written.
 * Skips symlinks. `wx` does not follow a final-component symlink. Read-only
 * commands must not call this. Never edits `.git`.
 */
export function ensureMossRuntimeGitignore(workspaceDir: string): void {
  try {
    const root = path.resolve(workspaceDir);
    if (!insideGitWorkTree(root)) return;
    const dir = path.join(root, '.moss');
    const file = path.join(dir, '.gitignore');
    let dirStat: fs.Stats | undefined;
    try {
      dirStat = fs.lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    if (dirStat && !dirStat.isDirectory()) return;
    try {
      const fileStat = fs.lstatSync(file);
      if (fileStat.isSymbolicLink() || !fileStat.isFile()) return;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
    }
    if (!dirStat) fs.mkdirSync(dir);
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(fd, RUNTIME_GITIGNORE);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // EEXIST or a symlink race: leave the target untouched.
  }
}

export function migrateLegacyWorkspacePaths(workspaceDir: string): WorkspacePathMigrationResult {
  const paths = getMossWorkspacePaths(workspaceDir);
  const result: WorkspacePathMigrationResult = {
    paths,
    migratedPaths: [],
    skippedPaths: [],
  };

  migratePath(paths.legacyLearnedSkillsDir, paths.learnedSkillsDir, result);
  migrateLegacySkillDirs(paths, result);
  migratePath(paths.legacySkillCandidatesDir, paths.skillCandidatesDir, result);
  migratePath(paths.legacyAgentSkillsDir, paths.agentSkillsDir, result);

  const migratedOutOf = (dir: string) =>
    result.migratedPaths.some(
      (entry) => entry.startsWith(`${dir}${path.sep}`) || entry.startsWith(`${dir} ->`)
    );
  if (migratedOutOf(paths.legacySkillsDir)) removeIfEmpty(paths.legacySkillsDir);
  const legacyAgentDir = path.join(paths.workspaceDir, 'agent');
  if (migratedOutOf(legacyAgentDir)) removeIfEmpty(legacyAgentDir);

  return result;
}
