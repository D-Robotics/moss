/**
 * Lightweight per-turn git snapshot for the dynamic prompt-cache bucket.
 *
 * Startup `buildEnvironmentContextLayer` freezes git status once; long coding
 * sessions then see a stale "clean" or outdated dirty list. This snapshot is
 * cheap (porcelain only, 3s timeout) and is injected into extraContext each
 * turn so the model protects uncommitted work like Claude Code / Codex.
 */
import { runProcess } from '../utils/run-process.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

const GIT_TIMEOUT_MS = 2500;
const MAX_STATUS_LINES = 16;

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const r = await runProcess('git', {
      args,
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: safeChildEnv({ GIT_OPTIONAL_LOCKS: '0' }),
    });
    return r.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Build a short dynamic git status block, or '' when not in a repo / git fails.
 */
export async function buildGitStatusSnapshot(workspaceDir: string): Promise<string> {
  const inside = (await git(['rev-parse', '--is-inside-work-tree'], workspaceDir)) === 'true';
  if (!inside) return '';

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir)) || 'unknown';
  const status = await git(['status', '--porcelain'], workspaceDir);
  if (status === null) return '';

  const lines: string[] = ['## Live Git Status (this turn)', `- Branch: ${branch}`];

  const changed = status ? status.split('\n').filter(Boolean) : [];
  if (changed.length === 0) {
    lines.push('- Working tree: clean');
  } else {
    lines.push(
      `- Working tree: ${changed.length} uncommitted change(s) — protect the user's work:`
    );
    for (const c of changed.slice(0, MAX_STATUS_LINES)) {
      lines.push(`    ${c}`);
    }
    if (changed.length > MAX_STATUS_LINES) {
      lines.push(`    ... and ${changed.length - MAX_STATUS_LINES} more`);
    }
    lines.push(
      '- Prefer surgical edits; do not discard, force-push, or overwrite uncommitted changes unless the user asks.'
    );
  }

  return lines.join('\n');
}
