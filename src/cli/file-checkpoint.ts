import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Claude Code keeps the 100 most recent checkpoints per session and stores them
 * with the conversation, so `/rewind` still works after a resume. Moss matches
 * the retention window and persists the metadata next to the backups; pruning
 * a checkpoint also deletes its backup files, so the bound is real on disk.
 */
const MAX_CHECKPOINTS = 100;
const META_FILE = 'checkpoints.json';

interface FileBackup {
  backupName: string | null;
  origHash: string | null;
  postHash?: string;
  postMissing?: boolean;
}

interface Checkpoint {
  seq: number;
  label: string;
  ts: number;
  files: Record<string, FileBackup>;
  messageCount: number;
}

export interface CheckpointSummary {
  seq: number;
  label: string;
  ts: number;
  fileCount: number;
  messageCount: number;
}

export interface RewindResult {
  found: boolean;

  restored: string[];

  skipped: string[];

  /**
   * The conversation message count recorded when this checkpoint was opened
   * (i.e. the number of messages BEFORE the prompt that opened it). The TUI
   * passes this to agent.rewindConversation so /rewind also discards the
   * prompt's turn + everything after it from the LLM context (grok-style
   * conversation rewind), not only restoring files. Undefined when the
   * checkpoint predates message-count tracking.
   */
  messageCount?: number;
}

function hashFile(absPath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

export class FileCheckpointStore {
  private readonly dir: string;
  private checkpoints: Checkpoint[] = [];
  private seq = 0;

  constructor(opts: { runtimeDir: string; sessionKey: string }) {
    this.dir = path.join(opts.runtimeDir, 'checkpoints', encodeURIComponent(opts.sessionKey));
    this.load();
  }

  /** Persist the metadata: backups already live in `this.dir`; without this the
   *  list disappeared on exit even though the files were still on disk. */
  private load(): void {
    try {
      const raw = fs.readFileSync(path.join(this.dir, META_FILE), 'utf8');
      const parsed = JSON.parse(raw) as { checkpoints?: Checkpoint[] };
      if (!Array.isArray(parsed.checkpoints)) return;
      this.checkpoints = parsed.checkpoints
        .filter(
          (cp): cp is Checkpoint =>
            Boolean(cp) &&
            typeof cp.seq === 'number' &&
            typeof cp.label === 'string' &&
            typeof cp.ts === 'number' &&
            typeof cp.messageCount === 'number' &&
            Boolean(cp.files) &&
            typeof cp.files === 'object'
        )
        .slice(-MAX_CHECKPOINTS);
      this.seq = this.checkpoints.reduce((max, cp) => Math.max(max, cp.seq), 0);
    } catch {
      // Missing or unreadable metadata means no rewind points, never a boot
      // failure: the restore tool must stay conservative about what it claims.
      this.checkpoints = [];
      this.seq = 0;
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `${META_FILE}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, checkpoints: this.checkpoints }));
      fs.renameSync(tmp, path.join(this.dir, META_FILE));
    } catch {
      // Disk trouble must not break the tool path; rewind simply won't survive.
    }
  }

  /** Delete backups that no retained checkpoint references. */
  private pruneBackups(): void {
    try {
      const referenced = new Set<string>();
      for (const cp of this.checkpoints) {
        for (const backup of Object.values(cp.files)) {
          if (backup.backupName) referenced.add(backup.backupName);
        }
      }
      for (const name of fs.readdirSync(this.dir)) {
        if (name === META_FILE || name === `${META_FILE}.tmp`) continue;
        if (!referenced.has(name)) fs.rmSync(path.join(this.dir, name), { force: true });
      }
    } catch {}
  }

  open(label: string, messageCount = 0): void {
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last && Object.keys(last.files).length === 0) this.checkpoints.pop();
    this.checkpoints.push({
      seq: ++this.seq,
      label: label.slice(0, 60),
      ts: Date.now(),
      files: {},
      messageCount,
    });
    if (this.checkpoints.length > MAX_CHECKPOINTS) {
      this.checkpoints = this.checkpoints.slice(-MAX_CHECKPOINTS);
    }
    this.pruneBackups();
    this.save();
  }

  trackBeforeWrite(absPath: string): void {
    const cp = this.checkpoints[this.checkpoints.length - 1];
    if (!cp || cp.files[absPath] !== undefined) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      let exists = true;
      try {
        fs.accessSync(absPath);
      } catch {
        exists = false;
      }
      if (!exists) {
        cp.files[absPath] = { backupName: null, origHash: null };
        this.save();
        return;
      }
      const backupName = `${crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16)}@${cp.seq}`;
      fs.copyFileSync(absPath, path.join(this.dir, backupName));
      cp.files[absPath] = { backupName, origHash: hashFile(absPath) };
    } catch {}
    this.save();
  }

  noteAfterWrite(absPath: string): void {
    const cp = this.checkpoints[this.checkpoints.length - 1];
    const entry = cp?.files[absPath];
    if (!entry) return;
    const h = hashFile(absPath);
    if (h === null) {
      entry.postMissing = true;
      entry.postHash = undefined;
    } else {
      entry.postMissing = false;
      entry.postHash = h;
    }
    this.save();
  }

  hasCheckpoints(): boolean {
    return this.checkpoints.some((c) => Object.keys(c.files).length > 0);
  }

  list(): CheckpointSummary[] {
    return this.checkpoints
      .filter((c) => Object.keys(c.files).length > 0)
      .map((c) => ({
        seq: c.seq,
        label: c.label,
        ts: c.ts,
        fileCount: Object.keys(c.files).length,
        messageCount: c.messageCount,
      }));
  }

  rewindTo(seq: number): RewindResult {
    const idx = this.checkpoints.findIndex((c) => c.seq === seq);
    if (idx < 0) return { found: false, restored: [], skipped: [] };
    const cp = this.checkpoints[idx];
    const restored: string[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (let i = this.checkpoints.length - 1; i >= idx; i--) {
      for (const [absPath, backup] of Object.entries(this.checkpoints[i].files)) {
        if (seen.has(absPath)) continue;
        seen.add(absPath);
        if (!this.isSafeToRestore(absPath, backup)) {
          skipped.push(absPath);
          continue;
        }
        try {
          if (backup.backupName === null) fs.rmSync(absPath, { force: true });
          else fs.copyFileSync(path.join(this.dir, backup.backupName), absPath);
          restored.push(absPath);
        } catch {
          skipped.push(absPath);
        }
      }
    }
    this.checkpoints = this.checkpoints.slice(0, idx);
    this.pruneBackups();
    this.save();
    return { found: true, restored, skipped, messageCount: cp.messageCount };
  }

  private isSafeToRestore(absPath: string, backup: FileBackup): boolean {
    const liveHash = hashFile(absPath);
    if (backup.postMissing) return liveHash === null;
    if (backup.postHash !== undefined) return liveHash === backup.postHash;
    if (backup.origHash === null) return liveHash === null;
    return liveHash === backup.origHash;
  }
}

export function checkpointTargetPaths(
  toolName: string,
  input: Record<string, unknown>,
  workspaceDir: string,
  parsePatchPaths: (patch: string) => string[]
): string[] {
  const resolve = (p: unknown): string | null =>
    typeof p === 'string' && p.trim() ? path.resolve(workspaceDir, p) : null;
  if (toolName === 'write_file') {
    const p = resolve(input.path ?? input.file_path);
    return p ? [p] : [];
  }
  if (toolName === 'move_file') {
    const out: string[] = [];
    const from = resolve(input.source ?? input.from);
    const to = resolve(input.destination ?? input.to);
    if (from) out.push(from);
    if (to) out.push(to);
    return out;
  }
  if (toolName === 'apply_patch' && typeof input.patch === 'string') {
    return parsePatchPaths(input.patch).map((rel) => path.resolve(workspaceDir, rel));
  }
  return [];
}
