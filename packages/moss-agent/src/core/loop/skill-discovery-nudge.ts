/**
 * SkillDiscoveryNudge (Grok SkillDiscoveryReminder light).
 *
 * After the model reads/lists paths under the workspace, walk a few ancestor
 * directories for skill folders (`.moss/skills`, `.claude/skills`, `.agents/skills`,
 * `.cursor/skills`) that contain SKILL.md entries. If any skill name is new
 * this run, inject one soft system reminder to `load_skill`.
 *
 * Soft: max 1 fire per run; never blocks completion.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Message } from '../session/session-jsonl.js';

export const SKILL_DISCOVERY_MAX_ATTEMPTS = 1;
export const SKILL_DISCOVERY_MAX_HOPS = 5;
export const SKILL_DISCOVERY_MAX_NAMES = 8;

/** Skill-bearing directory names (relative segment), Grok SKILL_CONFIG_DIRS parity. */
export const SKILL_CONFIG_DIR_NAMES = ['.moss', '.claude', '.agents', '.cursor'] as const;

export interface SkillDiscoveryNudgeRequest {
  messages: Message[];
  workspaceDir: string;
  attempts: number;
  /** Skill names already reported this run (mutated by caller after fire). */
  reportedNames: Set<string>;
  /** Skills already injected by the active composer plan. */
  activeSkillNames?: Set<string>;
}

export type SkillDiscoveryNudgeResult =
  | { fire: false }
  | { fire: true; correction: string; names: string[] };

function isInsideWorkspace(absPath: string, workspaceDir: string): boolean {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(absPath);
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Collect absolute file/dir paths the model recently touched via tool_use
 * (read_file / list_directory / search_files / search_code).
 * @internal exported for tests
 */
export function collectRecentToolPaths(messages: Message[], limit = 12): string[] {
  const paths: string[] = [];
  for (let i = messages.length - 1; i >= 0 && paths.length < limit; i--) {
    const m = messages[i];
    if (!m || m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as {
        type?: string;
        name?: string;
        input?: Record<string, unknown>;
      };
      if (b?.type !== 'tool_use' || !b.name) continue;
      if (
        b.name !== 'read_file' &&
        b.name !== 'list_directory' &&
        b.name !== 'search_files' &&
        b.name !== 'search_code' &&
        b.name !== 'edit_file' &&
        b.name !== 'write_file' &&
        b.name !== 'multi_edit' &&
        b.name !== 'apply_patch'
      ) {
        continue;
      }
      const input = b.input ?? {};
      const p = input.path ?? input.directory ?? input.dir;
      if (typeof p === 'string' && p.trim()) paths.push(p.trim());
      // multi_edit: collect every edits[].path
      if (Array.isArray(input.edits)) {
        for (const item of input.edits) {
          if (
            item &&
            typeof item === 'object' &&
            typeof (item as { path?: unknown }).path === 'string'
          ) {
            const ep = String((item as { path: string }).path).trim();
            if (ep) paths.push(ep);
          }
        }
      }
      // apply_patch: first Update/Add/Delete file path(s) from patch body
      if (typeof input.patch === 'string' && input.patch.trim()) {
        const re = /\*\*\*\s+(?:Update|Delete|Add)\s+File:\s*(\S+)/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(input.patch)) !== null) {
          if (m[1]) paths.push(m[1].trim());
        }
      }
    }
  }
  return paths;
}

function listSkillNamesInDir(skillRoot: string): string[] {
  if (!fs.existsSync(skillRoot) || !fs.statSync(skillRoot).isDirectory()) return [];
  const names: string[] = [];
  try {
    for (const entry of fs.readdirSync(skillRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = path.join(skillRoot, entry.name, 'SKILL.md');
      const skillMdAlt = path.join(skillRoot, entry.name, 'skill.md');
      if (fs.existsSync(skillMd) || fs.existsSync(skillMdAlt)) {
        names.push(entry.name);
      }
    }
  } catch {
    // ignore unreadable
  }
  return names;
}

/**
 * Walk from startAbs up toward workspace root, collecting skill names under
 * `.moss/skills`, `.claude/skills`, etc.
 * @internal exported for tests
 */
export function discoverSkillNamesNearPath(
  startAbs: string,
  workspaceDir: string,
  maxHops = SKILL_DISCOVERY_MAX_HOPS
): string[] {
  const root = path.resolve(workspaceDir);
  let dir = path.resolve(startAbs);
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) {
      dir = path.dirname(dir);
    }
  } catch {
    dir = path.dirname(dir);
  }

  const found: string[] = [];
  const seen = new Set<string>();
  for (let hop = 0; hop < maxHops; hop++) {
    if (!isInsideWorkspace(dir, root)) break;
    for (const configName of SKILL_CONFIG_DIR_NAMES) {
      // .moss/skills vs .claude/skills — config dir then skills/
      const candidates = [
        path.join(dir, configName, 'skills'),
        path.join(dir, configName), // allow SKILL.md directly under .claude/<name>/ in some layouts
      ];
      for (const skillRoot of candidates) {
        for (const name of listSkillNamesInDir(skillRoot)) {
          if (seen.has(name)) continue;
          seen.add(name);
          found.push(name);
        }
      }
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export function evaluateSkillDiscoveryNudge(
  request: SkillDiscoveryNudgeRequest
): SkillDiscoveryNudgeResult {
  if (request.attempts >= SKILL_DISCOVERY_MAX_ATTEMPTS) return { fire: false };

  const relPaths = collectRecentToolPaths(request.messages);
  if (relPaths.length === 0) return { fire: false };

  const fresh: string[] = [];
  const freshSeen = new Set<string>();
  for (const rel of relPaths) {
    const abs = path.isAbsolute(rel) ? rel : path.resolve(request.workspaceDir, rel);
    if (!isInsideWorkspace(abs, request.workspaceDir)) continue;
    for (const name of discoverSkillNamesNearPath(abs, request.workspaceDir)) {
      if (
        request.reportedNames.has(name) ||
        request.activeSkillNames?.has(name.toLowerCase()) ||
        freshSeen.has(name)
      )
        continue;
      freshSeen.add(name);
      fresh.push(name);
      if (fresh.length >= SKILL_DISCOVERY_MAX_NAMES) break;
    }
    if (fresh.length >= SKILL_DISCOVERY_MAX_NAMES) break;
  }

  if (fresh.length === 0) return { fire: false };

  const list = fresh.map((n) => `\`${n}\``).join(', ');
  return {
    fire: true,
    names: fresh,
    correction:
      `[System] Nearby project skills detected while exploring the workspace: ${list}. ` +
      'If any match the current task, call `load_skill` with that name to load full instructions before continuing. ' +
      'Skip if the skill is already loaded or clearly irrelevant.',
  };
}
