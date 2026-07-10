/**
 * Dedicated Git tools for Moss.
 *
 * These provide structured, sandbox-safe git operations instead of routing
 * everything through the generic exec tool. Benefits:
 * - Read-only tools (git_diff, git_status, git_log) run without approval
 * - Write tools (git_commit, git_branch) have structured input validation
 * - Git operations are sandboxed to the workspace directory
 */
import type { Tool } from '../core/tools/tool-types.js';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { childEnv } from './tool-helpers.js';
import { toolError } from './tool-helpers.js';

async function gitExec(
  workspaceDir: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await runProcess('git', {
      args,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      cwd: workspaceDir,
      env: childEnv(workspaceDir),
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: 0 };
  } catch (err) {
    if (err instanceof ProcessError) {
      return { stdout: err.stdout.trim(), stderr: err.stderr.trim(), exitCode: err.exitCode ?? 1 };
    }
    throw err;
  }
}

// ── git_status ──────────────────────────────────────────────────────────────

export const gitStatusTool: Tool = {
  name: 'git_status',
  description:
    'Show the working tree status — staged, unstaged, and untracked files. ' +
    'Read-only; no approval needed.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Subdirectory to check status in (default: workspace root)',
      },
    },
  },
  async execute(input, ctx) {
    try {
      const args = ['status', '--porcelain'];
      if (input.path) args.push('--', String(input.path));
      const { stdout, stderr } = await gitExec(ctx.workspaceDir, args);
      if (stderr) return `git status error:\n${stderr}`;
      return stdout || '(clean — no changes)';
    } catch (err) {
      throw toolError('Error running git status', err);
    }
  },
};

// ── git_diff ────────────────────────────────────────────────────────────────

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description:
    'Show changes in the working tree. Without arguments, shows unstaged diff. ' +
    'Pass --staged to see staged changes. Read-only; no approval needed.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      staged: {
        type: 'boolean',
        description: 'Show staged changes instead of unstaged (default: false)',
      },
      path: {
        type: 'string',
        description: 'Limit diff to a specific file or directory',
      },
      context_lines: {
        type: 'number',
        description: 'Number of context lines (default: 3)',
      },
    },
  },
  async execute(input, ctx) {
    try {
      const args = ['diff'];
      if (input.staged) args.push('--staged');
      const contextLines = Number(input.context_lines) || 3;
      args.push(`-U${Math.min(Math.max(contextLines, 0), 20)}`);
      if (input.path) args.push('--', String(input.path));

      const { stdout, stderr } = await gitExec(ctx.workspaceDir, args, 60_000);
      if (stderr) return `git diff error:\n${stderr}`;
      return stdout || '(no changes)';
    } catch (err) {
      throw toolError('Error running git diff', err);
    }
  },
};

// ── git_log ─────────────────────────────────────────────────────────────────

export const gitLogTool: Tool = {
  name: 'git_log',
  description:
    'Show commit history. Supports --oneline format and limiting by count. ' +
    'Read-only; no approval needed.',
  metadata: {
    sideEffectClass: 'readonly',
    planMode: 'allow',
  },
  inputSchema: {
    type: 'object',
    properties: {
      count: {
        type: 'number',
        description: 'Number of recent commits to show (default: 10, max: 100)',
      },
      oneline: {
        type: 'boolean',
        description: 'One-line format (default: true)',
      },
      path: {
        type: 'string',
        description: 'Limit log to commits affecting a specific file or directory',
      },
      author: {
        type: 'string',
        description: 'Filter by author name or email',
      },
      since: {
        type: 'string',
        description: 'Show commits since date (e.g. "2024-01-01", "1 week ago")',
      },
    },
  },
  async execute(input, ctx) {
    try {
      const args = ['log'];
      const count = Math.min(Number(input.count) || 10, 100);
      args.push(`-${count}`);
      if (input.oneline !== false) args.push('--oneline');
      if (input.author) args.push('--author', String(input.author));
      if (input.since) args.push('--since', String(input.since));
      if (input.path) args.push('--', String(input.path));

      const { stdout, stderr } = await gitExec(ctx.workspaceDir, args, 30_000);
      if (stderr) return `git log error:\n${stderr}`;
      return stdout || '(no commits)';
    } catch (err) {
      throw toolError('Error running git log', err);
    }
  },
};

// ── git_commit ──────────────────────────────────────────────────────────────

export const gitCommitTool: Tool = {
  name: 'git_commit',
  description:
    'Create a git commit with staged changes. Requires user confirmation. ' +
    'Commit messages should follow conventional commits format.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'Commit message (required). Use conventional commits: type(scope): description',
      },
      all: {
        type: 'boolean',
        description: 'Automatically stage all modified and deleted files (git commit -a)',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific files to stage before committing',
      },
    },
    required: ['message'],
  },
  async execute(input, ctx) {
    try {
      const message = String(input.message || '').trim();
      if (!message) return 'Error: commit message is required.';

      // Stage specific files if requested
      if (input.files && Array.isArray(input.files) && input.files.length > 0) {
        const addArgs = ['add', '--', ...input.files.map(String)];
        const addResult = await gitExec(ctx.workspaceDir, addArgs);
        if (addResult.exitCode !== 0) {
          return `Error staging files:\n${addResult.stderr}`;
        }
      }

      // Commit
      const args = ['commit', '-m', message];
      if (input.all) args.splice(1, 0, '-a');

      const { stdout, stderr, exitCode } = await gitExec(ctx.workspaceDir, args);
      if (exitCode !== 0) {
        return `Error creating commit:\n${stderr || stdout}`;
      }
      return `${stdout}\n${stderr}`.trim() || 'Commit created successfully.';
    } catch (err) {
      throw toolError('Error creating git commit', err);
    }
  },
};

// ── git_branch ──────────────────────────────────────────────────────────────

export const gitBranchTool: Tool = {
  name: 'git_branch',
  description:
    'List, create, or switch git branches. Creating/switching branches requires confirmation.',
  metadata: {
    sideEffectClass: 'local_write',
    planMode: 'requires_user_confirmation',
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'create', 'switch'],
        description: 'Action: list branches, create a new branch, or switch to a branch',
      },
      name: {
        type: 'string',
        description: 'Branch name (required for create/switch)',
      },
      create_from: {
        type: 'string',
        description: 'Base branch/commit for new branch (default: current HEAD)',
      },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    try {
      const action = String(input.action || 'list');

      switch (action) {
        case 'list': {
          const { stdout, stderr } = await gitExec(ctx.workspaceDir, ['branch', '--list']);
          if (stderr) return `git branch error:\n${stderr}`;
          return stdout || '(no branches)';
        }

        case 'create': {
          const name = String(input.name || '').trim();
          if (!name) return 'Error: branch name is required for create.';
          const args = ['checkout', '-b', name];
          if (input.create_from) args.push(String(input.create_from));
          const { stdout, stderr, exitCode } = await gitExec(ctx.workspaceDir, args);
          if (exitCode !== 0) return `Error creating branch:\n${stderr || stdout}`;
          return `Switched to a new branch '${name}'.\n${stdout}`.trim();
        }

        case 'switch': {
          const name = String(input.name || '').trim();
          if (!name) return 'Error: branch name is required for switch.';
          const { stdout, stderr, exitCode } = await gitExec(ctx.workspaceDir, ['checkout', name]);
          if (exitCode !== 0) return `Error switching branch:\n${stderr || stdout}`;
          return `Switched to branch '${name}'.\n${stdout}`.trim();
        }

        default:
          return `Error: unknown action "${action}". Use list, create, or switch.`;
      }
    } catch (err) {
      throw toolError('Error running git branch', err);
    }
  },
};

// ── All git tools ───────────────────────────────────────────────────────────

export const gitTools: Tool[] = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitCommitTool,
  gitBranchTool,
];