/**
 * D10: local skill usage counters. `/skills` and `moss skill list` show which
 * skills are actually loaded, so a big-but-unused skill is visible before it
 * eats catalog budget. Stored under `.moss/` (runtime artifact, gitignored by
 * the workspace template); best-effort — a read-only workspace never fails a
 * skill load over stats.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface SkillUsageEntry {
  count: number;
  lastUsedAt: string;
}

export type SkillUsage = Record<string, SkillUsageEntry>;

const MAX_ENTRIES = 200;

export function skillUsagePath(workspaceDir: string): string {
  return path.join(workspaceDir, '.moss', 'skills-usage.json');
}

export function loadSkillUsage(workspaceDir: string): SkillUsage {
  try {
    const raw = JSON.parse(fs.readFileSync(skillUsagePath(workspaceDir), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const usage: SkillUsage = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const entry = value as { count?: unknown; lastUsedAt?: unknown };
      const count =
        typeof entry.count === 'number' && Number.isFinite(entry.count) ? entry.count : 0;
      usage[name] = {
        count,
        lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : '',
      };
    }
    return usage;
  } catch {
    return {};
  }
}

/** Record one successful skill load. Never throws. */
export function recordSkillUse(workspaceDir: string, skillName: string): void {
  try {
    const usage = loadSkillUsage(workspaceDir);
    const previous = usage[skillName];
    usage[skillName] = {
      count: (previous?.count ?? 0) + 1,
      lastUsedAt: new Date().toISOString(),
    };
    const names = Object.keys(usage);
    if (names.length > MAX_ENTRIES) {
      names
        .sort((a, b) => (usage[a]?.lastUsedAt ?? '').localeCompare(usage[b]?.lastUsedAt ?? ''))
        .slice(0, names.length - MAX_ENTRIES)
        .forEach((name) => delete usage[name]);
    }
    const file = skillUsagePath(workspaceDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(usage, null, 2)}\n`, 'utf8');
  } catch {
    // Stats are advisory; never fail a skill load because the workspace is read-only.
  }
}
