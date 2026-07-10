/**
 * Auto-backup manager for Moss.
 *
 * Automatically backs up files before write_file, edit_file, or apply_patch
 * modifications. Stores backups in .moss/backups/<timestamp>/ preserving the
 * relative path structure. Supports rollback via /undo.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';

export interface BackupEntry {
  /** Original workspace-relative path */
  workspacePath: string;
  /** Absolute path to the backup file */
  backupPath: string;
  /** Timestamp of the backup */
  timestamp: number;
  /** Tool that triggered the backup */
  tool: string;
}

export class BackupManager {
  private backups: BackupEntry[] = [];
  private backupDir: string | null = null;
  private maxBackups: number;

  constructor(maxBackups = 50) {
    this.maxBackups = maxBackups;
  }

  /**
   * Initialize the backup directory for a workspace session.
   */
  async init(workspaceDir: string): Promise<void> {
    const paths = getMossWorkspacePaths(workspaceDir);
    this.backupDir = path.join(paths.backupsDir, String(Date.now()));
    await fs.mkdir(this.backupDir, { recursive: true });
  }

  /**
   * Back up a file before modification. Auto-initializes on first call.
   */
  async backupBeforeWrite(
    workspaceDir: string,
    workspacePath: string,
    tool: string,
  ): Promise<void> {
    // Lazy initialization on first backup call
    if (!this.backupDir) {
      await this.init(workspaceDir);
    }

    // Resolve the absolute path
    const absolutePath = path.resolve(workspaceDir, workspacePath);
    // Ensure it's within the workspace
    if (!absolutePath.startsWith(path.resolve(workspaceDir))) return;

    try {
      const content = await fs.readFile(absolutePath);
      // Preserve directory structure: src/foo.ts → .moss/backups/<ts>/src/foo.ts
      // Append a counter to avoid overwriting previous backups of the same file
      const basePath = path.join(this.backupDir!, workspacePath);
      const dir = path.dirname(basePath);
      const ext = path.extname(basePath);
      const name = path.basename(basePath, ext);
      const seq = this.backups.filter((b) => b.workspacePath === workspacePath).length;
      const relBackupPath = seq === 0
        ? basePath
        : path.join(dir, `${name}.${seq}${ext}`);
      await fs.mkdir(path.dirname(relBackupPath), { recursive: true });
      await fs.writeFile(relBackupPath, content);

      this.backups.push({
        workspacePath,
        backupPath: relBackupPath,
        timestamp: Date.now(),
        tool,
      });

      // Prune old backups if over limit
      if (this.backups.length > this.maxBackups) {
        const oldest = this.backups.shift()!;
        try {
          await fs.unlink(oldest.backupPath);
        } catch {
          // Already gone
        }
      }
    } catch {
      // File doesn't exist yet (new file) — nothing to back up
    }
  }

  /**
   * Restore the most recent backup. Returns the workspace path that was restored.
   */
  async undoLast(workspaceDir: string): Promise<string | null> {
    const entry = this.backups.pop();
    if (!entry) return null;

    const targetPath = path.resolve(workspaceDir, entry.workspacePath);
    try {
      const content = await fs.readFile(entry.backupPath, 'utf-8');
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content);
      // Clean up the backup file
      await fs.unlink(entry.backupPath);
      return entry.workspacePath;
    } catch (err) {
      return null;
    }
  }

  /**
   * Get all backup entries for the current session.
   */
  getBackups(): ReadonlyArray<BackupEntry> {
    return this.backups;
  }

  /**
   * Get the current backup directory path.
   */
  getBackupDir(): string | null {
    return this.backupDir;
  }

  /**
   * Clean up all backups.
   */
  async cleanup(): Promise<void> {
    if (this.backupDir) {
      try {
        await fs.rm(this.backupDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    this.backups = [];
    this.backupDir = null;
  }
}

/** Global singleton — one backup manager per process */
export const globalBackupManager = new BackupManager();