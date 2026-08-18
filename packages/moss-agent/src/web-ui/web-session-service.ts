import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import type { MossAgent } from '../core/agent/moss-agent.js';
import type { TaskRunLedger } from '../core/task-run/task-run-ledger.js';
import { renderSessionMarkdown, searchSessions } from '../cli/command-dispatcher.js';
import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import type {
  MossWebSessionSearchHit,
  MossWebSessionSummary,
  MossWebWorkspaceSummary,
} from './web-contracts.js';

interface WebSessionMetadataFile {
  readonly schemaVersion: 1;
  readonly titles: Readonly<Record<string, string>>;
}

interface MossWebSessionServiceOptions {
  readonly metadataFile?: string;
  readonly workspaceDir?: string;
}

/** Host-owned Web session application service. @internal */
export class MossWebSessionService {
  private readonly titles = new Map<string, string>();

  private readonly ready: Promise<void>;

  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly agent: MossAgent,
    private readonly taskRuns: TaskRunLedger,
    private readonly options: MossWebSessionServiceOptions = {}
  ) {
    this.ready = this.loadMetadata();
  }

  async listWorkspaces(): Promise<readonly MossWebWorkspaceSummary[]> {
    const workspaceDir = path.resolve(
      this.options.workspaceDir ?? this.agent.config.workspaceDir ?? '.'
    );
    return [
      {
        id: 'current',
        name: path.basename(workspaceDir) || workspaceDir,
        current: true,
      },
    ];
  }

  async listSessions(): Promise<MossWebSessionSummary[]> {
    await this.ready;
    const stored = await this.agent.config.sessionStore.listSessions();
    const runs = this.taskRuns.list();
    const bySession = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      if (!bySession.has(run.sessionId)) bySession.set(run.sessionId, run);
    }
    return stored
      .map((session) => {
        const run = bySession.get(session.sessionKey);
        return {
          sessionId: session.sessionKey,
          title:
            this.titles.get(session.sessionKey) ?? session.title ?? run?.title ?? 'Untitled task',
          updatedAt: Math.max(session.updatedAt, run?.updatedAt ?? 0),
          messageCount: session.messageCount,
          ...(run ? { runId: run.id, runStatus: run.status } : {}),
        };
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async search(query: string): Promise<MossWebSessionSearchHit[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const [sessions, contentHits] = await Promise.all([
      this.listSessions(),
      searchSessions(this.agent.config.sessionStore, query),
    ]);
    const bySession = new Map<string, MossWebSessionSearchHit>();
    for (const hit of contentHits) {
      const summary = sessions.find(({ sessionId }) => sessionId === hit.key);
      bySession.set(hit.key, {
        sessionId: hit.key,
        title: summary?.title ?? 'Untitled task',
        updatedAt: hit.updatedAt,
        messageCount: hit.messageCount,
        snippet: hit.snippet,
      });
    }
    for (const session of sessions) {
      if (!session.title.toLowerCase().includes(needle) || bySession.has(session.sessionId))
        continue;
      bySession.set(session.sessionId, { ...session, snippet: session.title });
    }
    return [...bySession.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async create(workspaceId = 'current'): Promise<MossWebSessionSummary> {
    if (workspaceId !== 'current') this.invalid(`unknown workspace "${workspaceId}"`);
    const sessionId = `web-${randomUUID()}`;
    await this.agent.config.sessionStore.replaceMessages(sessionId, []);
    try {
      await this.mutateMetadata(() => this.titles.set(sessionId, 'New task'));
    } catch (error) {
      await this.agent.config.sessionStore.deleteSession(sessionId).catch(() => {});
      throw error;
    }
    return (await this.summary(sessionId))!;
  }

  async rename(sessionId: string, title: string): Promise<MossWebSessionSummary> {
    await this.assertExists(sessionId);
    const normalized = title.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 120) {
      this.invalid('session title must contain 1 to 120 characters');
    }
    await this.mutateMetadata(() => this.titles.set(sessionId, normalized));
    return (await this.summary(sessionId))!;
  }

  async titleFromPrompt(sessionId: string, prompt: string): Promise<void> {
    await this.assertExists(sessionId);
    const title = prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (title) await this.mutateMetadata(() => this.titles.set(sessionId, title));
  }

  async exportMarkdown(sessionId: string): Promise<string> {
    await this.assertExists(sessionId);
    const messages = await this.agent.config.sessionStore.loadMessages(sessionId);
    return renderSessionMarkdown(sessionId, messages);
  }

  async delete(sessionId: string, confirmation: string): Promise<void> {
    await this.assertExists(sessionId);
    if (confirmation !== sessionId) {
      this.invalid(`delete confirmation must exactly match session id "${sessionId}"`);
    }
    await this.ready;
    const previousTitle = this.titles.get(sessionId);
    await this.mutateMetadata(() => this.titles.delete(sessionId));
    try {
      await this.agent.config.sessionStore.deleteSession(sessionId);
    } catch (error) {
      if (previousTitle) {
        await this.mutateMetadata(() => this.titles.set(sessionId, previousTitle)).catch(() => {});
      }
      throw wrapAsMoss(error, ErrorCode.SESSION_PERSIST_FAILED, {
        message: `Failed to delete session "${sessionId}"`,
      });
    }
  }

  async fork(sessionId: string): Promise<MossWebSessionSummary> {
    await this.assertExists(sessionId);
    const messages = await this.agent.config.sessionStore.loadMessages(sessionId);
    const forkId = `web-fork-${randomUUID()}`;
    await this.agent.config.sessionStore.replaceMessages(forkId, messages);
    const source = await this.summary(sessionId);
    try {
      await this.mutateMetadata(() =>
        this.titles.set(forkId, `${source?.title ?? 'Untitled task'} (fork)`.slice(0, 120))
      );
    } catch (error) {
      await this.agent.config.sessionStore.deleteSession(forkId).catch(() => {});
      throw error;
    }
    return (await this.summary(forkId))!;
  }

  async rewind(
    sessionId: string,
    messageCount: number
  ): Promise<{
    readonly session: MossWebSessionSummary;
    readonly sourceSessionId: string;
    readonly truncated: number;
  }> {
    await this.assertExists(sessionId);
    if (!Number.isSafeInteger(messageCount) || messageCount < 0) {
      this.invalid('messageCount must be a non-negative integer');
    }
    const messages = await this.agent.config.sessionStore.loadMessages(sessionId);
    if (messageCount > messages.length) {
      this.invalid(`messageCount cannot exceed the session length (${messages.length})`);
    }
    const rewindId = `web-rewind-${randomUUID()}`;
    await this.agent.config.sessionStore.replaceMessages(rewindId, messages);
    let result: { truncated: number };
    try {
      result = await this.agent.rewindConversation(rewindId, messageCount);
      const source = await this.summary(sessionId);
      await this.mutateMetadata(() =>
        this.titles.set(rewindId, `${source?.title ?? 'Untitled task'} (rewind)`.slice(0, 120))
      );
    } catch (error) {
      await this.agent.config.sessionStore.deleteSession(rewindId).catch(() => {});
      throw error;
    }
    return {
      session: (await this.summary(rewindId))!,
      sourceSessionId: sessionId,
      truncated: result.truncated,
    };
  }

  private async summary(sessionId: string): Promise<MossWebSessionSummary | undefined> {
    return (await this.listSessions()).find((session) => session.sessionId === sessionId);
  }

  private async assertExists(sessionId: string): Promise<void> {
    if (!(await this.agent.config.sessionStore.exists(sessionId))) {
      this.invalid(`session "${sessionId}" was not found`);
    }
  }

  private async loadMetadata(): Promise<void> {
    if (!this.options.metadataFile) return;
    try {
      const parsed = JSON.parse(await readFile(this.options.metadataFile, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const candidate = parsed as Partial<WebSessionMetadataFile>;
      if (
        candidate.schemaVersion !== 1 ||
        !candidate.titles ||
        typeof candidate.titles !== 'object'
      ) {
        return;
      }
      for (const [sessionId, title] of Object.entries(candidate.titles)) {
        if (typeof title === 'string' && title.trim()) this.titles.set(sessionId, title);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
          message: 'Failed to load Web session metadata',
        });
      }
    }
  }

  private async mutateMetadata(mutation: () => void): Promise<void> {
    await this.ready;
    const operation = this.mutationTail.then(async () => {
      const previous = new Map(this.titles);
      try {
        mutation();
        if (!this.options.metadataFile) return;
        const body: WebSessionMetadataFile = {
          schemaVersion: 1,
          titles: Object.fromEntries(this.titles),
        };
        await atomicWriteFile(this.options.metadataFile, `${JSON.stringify(body, null, 2)}\n`);
      } catch (error) {
        this.titles.clear();
        for (const [sessionId, title] of previous) this.titles.set(sessionId, title);
        throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
          message: 'Failed to persist Web session metadata',
        });
      }
    });
    this.mutationTail = operation.catch(() => {});
    await operation;
  }

  private invalid(message: string): never {
    throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
  }
}
