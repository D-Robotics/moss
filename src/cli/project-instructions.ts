import fs from 'node:fs';
import path from 'node:path';

/**
 * Project instructions (AGENTS.md) — the workspace-level system prompt layer.
 *
 * The CLI has advertised "AGENTS.md auto-loaded from workspace root" since
 * v0.14; this module is what makes that claim true. Loaded once per process at
 * agent init, after the environment layer and before the runtime capability
 * layers, so every turn (chat, /task, sub-agents inheriting the parent prompt)
 * sees the project's build/test commands, layout and conventions.
 */

/** Hard cap: a project file beyond this is truncated with an explicit notice. */
export const AGENTS_MD_MAX_BYTES = 16 * 1024;

const CANDIDATES = ['AGENTS.md', 'agents.md'] as const;

export function findAgentsMdPath(workspaceDir: string): string | undefined {
  for (const name of CANDIDATES) {
    const candidate = path.join(workspaceDir, name);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not present — try the next spelling
    }
  }
  return undefined;
}

/**
 * The prompt layer for the workspace's AGENTS.md, or '' when there is none.
 * An oversized file is cut at the byte cap with a visible notice — silent
 * truncation would let the model assume it saw conventions it did not.
 */
export function buildAgentsMdLayer(workspaceDir: string): string {
  const file = findAgentsMdPath(workspaceDir);
  if (!file) return '';
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const bytes = Buffer.byteLength(trimmed, 'utf8');
  if (bytes <= AGENTS_MD_MAX_BYTES) {
    return `[Project instructions — ${path.basename(file)}]\n${trimmed}`;
  }
  const kept = Buffer.from(trimmed, 'utf8').subarray(0, AGENTS_MD_MAX_BYTES).toString('utf8');
  // A cut can land mid-code-unit: drop the trailing replacement char it would
  // produce rather than shipping a broken glyph into the prompt.
  const safe = kept.endsWith('\ufffd') ? kept.slice(0, -1) : kept;
  const droppedKb = Math.round((bytes - AGENTS_MD_MAX_BYTES) / 1024);
  return (
    `[Project instructions — ${path.basename(file)} (truncated, ~${droppedKb}KB dropped — ` +
    `edit the file under ${Math.floor(AGENTS_MD_MAX_BYTES / 1024)}KB to load it fully)]\n${safe}`
  );
}
