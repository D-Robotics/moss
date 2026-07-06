











import fs from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceMemoryConfig {
  workspaceDir: string;
}

export interface WorkspaceMemoryContext {
  /** Content of AGENTS.md — the single project-instructions entry point. */
  agentRules: string | null;
}

const MAX_FILE_SIZE = 10_000;

export class WorkspaceMemory {
  private readonly dir: string;

  constructor(config: WorkspaceMemoryConfig) {
    this.dir = config.workspaceDir;
  }

  async loadContext(): Promise<WorkspaceMemoryContext> {
    const ctx: WorkspaceMemoryContext = { agentRules: null };

    try {
      const filePath = path.join(this.dir, 'AGENTS.md');
      const content = await fs.readFile(filePath, 'utf-8');
      if (content.trim()) {
        ctx.agentRules =
          content.length > MAX_FILE_SIZE
            ? content.slice(0, MAX_FILE_SIZE) + '\n\n[... truncated]'
            : content;
      }
    } catch {
      // File absent — not an error, just no project instructions.
    }

    return ctx;
  }

  buildPromptLayer(ctx: WorkspaceMemoryContext): string {
    if (!ctx.agentRules) return '';
    return `# Project Instructions (AGENTS.md)\n\n${ctx.agentRules}`;
  }
}
