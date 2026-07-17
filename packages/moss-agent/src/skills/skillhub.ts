/**
 * SkillHub marketplace helpers (https://skillhub.cn).
 *
 * Used by agent tools (`skillhub_search` / `skillhub_install`) and the Soul
 * CLI path. All subprocess work goes through `runProcess` (AbortSignal +
 * timeout) — never `execFileSync` on the tool path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessError, runProcess, type RunProcessResult } from '../utils/run-process.js';
import { getMossWorkspacePaths } from '../utils/workspace-paths.js';

const SKILLHUB_INSTALLER_URL =
  'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh';
const SKILLHUB_KIT_URL =
  'https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/latest.tar.gz';

export { SKILLHUB_INSTALLER_URL, SKILLHUB_KIT_URL };

export interface SkillHubSearchHit {
  slug: string;
  name: string;
  description: string;
  version?: string;
  source?: string;
}

export function resolveSkillHubCommand(): string {
  const executable = process.platform === 'win32' ? 'skillhub.exe' : 'skillhub';
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates = [
    ...pathEntries.map((entry) => path.join(entry, executable)),
    path.join(os.homedir(), '.local', 'bin', executable),
    path.join(os.homedir(), 'bin', executable),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? 'skillhub';
}

/** True when the resolved command is an absolute path that exists on disk. */
export function skillHubCliAvailable(): boolean {
  const command = resolveSkillHubCommand();
  if (command === 'skillhub' || command === 'skillhub.exe') return false;
  try {
    return fs.existsSync(command);
  } catch {
    return false;
  }
}

export function skillHubInstallHint(): string {
  return [
    'SkillHub CLI is not installed. Install with:',
    '  curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash -s -- --cli-only',
    `Guide: https://skillhub.cn/install/skillhub.md · installer: ${SKILLHUB_INSTALLER_URL}`,
    'Moss can also auto-install the CLI-only kit on first skillhub_search/skillhub_install (non-Windows).',
  ].join('\n');
}

/** Once-per-process guard so we do not thrash the network on every tool call. */
let skillHubEnsureAttempted = false;

/** Reset ensure attempt flag — for tests only. */
export function resetSkillHubEnsureForTests(): void {
  skillHubEnsureAttempted = false;
}

/**
 * Ensure the SkillHub CLI is on disk (https://skillhub.cn/install/skillhub.md).
 *
 * When missing on non-Windows hosts, downloads and runs the official
 * `--cli-only` installer once per process, then re-probes. Injected `run` is
 * for tests. Never uses execFileSync — all work goes through runProcess.
 */
export async function ensureSkillHubCli(
  options: {
    force?: boolean;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    run?: (command: string, args: string[], opts?: { timeout?: number; signal?: AbortSignal }) => Promise<RunProcessResult>;
  } = {}
): Promise<{ ok: true; command: string; installed: boolean } | { ok: false; message: string }> {
  if (skillHubCliAvailable()) {
    return { ok: true, command: resolveSkillHubCommand(), installed: false };
  }
  if (process.platform === 'win32') {
    return {
      ok: false,
      message:
        skillHubInstallHint() +
        '\n(Auto-install is not supported on Windows — install the CLI manually and ensure it is on PATH.)',
    };
  }
  if (skillHubEnsureAttempted && !options.force) {
    return { ok: false, message: skillHubInstallHint() };
  }
  skillHubEnsureAttempted = true;

  const timeout = options.timeoutMs ?? 120_000;
  const runner =
    options.run ??
    ((command, args, opts) =>
      runProcess(command, {
        args,
        timeout: opts?.timeout ?? timeout,
        signal: opts?.signal ?? options.abortSignal,
      }));

  try {
    // Official SkillHub installer (CN COS). --cli-only skips default skill packs.
    // Shell pipeline is intentional: this is the vendor-documented install path.
    await runner(
      '/bin/bash',
      [
        '-c',
        `curl -fsSL "${SKILLHUB_INSTALLER_URL}" | bash -s -- --cli-only`,
      ],
      { timeout, signal: options.abortSignal }
    );
  } catch (err) {
    if (err instanceof ProcessError) {
      const detail = err.stderr.trim() || err.stdout.trim() || err.message;
      return {
        ok: false,
        message: `SkillHub auto-install failed: ${detail}\n${skillHubInstallHint()}`,
      };
    }
    return {
      ok: false,
      message: `SkillHub auto-install failed: ${err instanceof Error ? err.message : String(err)}\n${skillHubInstallHint()}`,
    };
  }

  // Installer typically writes ~/.local/bin/skillhub — re-probe without relying
  // on PATH updates in this process.
  const localBin = path.join(os.homedir(), '.local', 'bin', 'skillhub');
  if (fs.existsSync(localBin)) {
    return { ok: true, command: localBin, installed: true };
  }
  if (skillHubCliAvailable()) {
    return { ok: true, command: resolveSkillHubCommand(), installed: true };
  }
  return {
    ok: false,
    message: `SkillHub installer finished but the CLI was not found under ~/.local/bin.\n${skillHubInstallHint()}`,
  };
}

export function workspaceSkillsDir(workspaceDir: string): string {
  return getMossWorkspacePaths(workspaceDir).skillsDir;
}

export async function skillHubSearch(
  query: string,
  options: {
    limit?: number;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    run?: (command: string, args: string[], opts?: { timeout?: number; signal?: AbortSignal }) => Promise<RunProcessResult>;
  } = {}
): Promise<{ ok: true; hits: SkillHubSearchHit[]; raw?: string } | { ok: false; message: string }> {
  const q = query.trim();
  if (!q) return { ok: false, message: 'Error: search query is required.' };
  // Injected `run` is for tests / hosts that wrap the CLI — skip local binary check.
  if (!options.run && !skillHubCliAvailable()) {
    const ensured = await ensureSkillHubCli({
      abortSignal: options.abortSignal,
      timeoutMs: options.timeoutMs,
    });
    if (!ensured.ok) return { ok: false, message: ensured.message };
  }
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit ?? 10)));
  const timeout = options.timeoutMs ?? 15_000;
  const runner =
    options.run ??
    ((command, args, opts) =>
      runProcess(command, {
        args,
        timeout: opts?.timeout ?? timeout,
        signal: opts?.signal ?? options.abortSignal,
      }));
  try {
    const result = await runner(
      resolveSkillHubCommand(),
      ['search', q, '--json', '--search-limit', String(limit)],
      { timeout, signal: options.abortSignal }
    );
    const stdout = result.stdout.trim();
    if (!stdout) return { ok: true, hits: [] };
    try {
      const parsed = JSON.parse(stdout) as {
        results?: Array<Record<string, unknown>>;
        count?: number;
      };
      const hits = (parsed.results ?? []).map((row) => ({
        slug: String(row.slug ?? row.name ?? ''),
        name: String(row.name ?? row.slug ?? ''),
        description: String(row.description ?? '').replace(/\s+/g, ' ').trim(),
        version: typeof row.version === 'string' ? row.version : undefined,
        source: typeof row.source === 'string' ? row.source : undefined,
      })).filter((h) => h.slug);
      return { ok: true, hits, raw: stdout };
    } catch {
      // CLI may print plain text if --json is ignored on older versions.
      return {
        ok: true,
        hits: [],
        raw: stdout.slice(0, 4000),
      };
    }
  } catch (err) {
    if (err instanceof ProcessError) {
      const detail = err.stderr.trim() || err.stdout.trim() || err.message;
      if (/enoent|not found/i.test(detail)) return { ok: false, message: skillHubInstallHint() };
      return { ok: false, message: `SkillHub search failed: ${detail}` };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function skillHubInstall(
  slug: string,
  options: {
    workspaceDir: string;
    force?: boolean;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    run?: (command: string, args: string[], opts?: { timeout?: number; signal?: AbortSignal }) => Promise<RunProcessResult>;
  }
): Promise<{ ok: true; dir: string; message: string } | { ok: false; message: string }> {
  const id = slug.trim();
  if (!id) return { ok: false, message: 'Error: skill slug is required.' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    return { ok: false, message: 'Error: invalid skill slug. Use letters, numbers, dots, underscores, or hyphens.' };
  }
  if (!options.run && !skillHubCliAvailable()) {
    const ensured = await ensureSkillHubCli({
      abortSignal: options.abortSignal,
      timeoutMs: options.timeoutMs,
    });
    if (!ensured.ok) return { ok: false, message: ensured.message };
  }
  const skillsDir = workspaceSkillsDir(options.workspaceDir);
  fs.mkdirSync(skillsDir, { recursive: true, mode: 0o700 });
  const timeout = options.timeoutMs ?? 120_000;
  const args = ['install', id, '--dir', skillsDir];
  if (options.force) args.push('--force');
  const runner =
    options.run ??
    ((command, cmdArgs, opts) =>
      runProcess(command, {
        args: cmdArgs,
        timeout: opts?.timeout ?? timeout,
        signal: opts?.signal ?? options.abortSignal,
      }));
  try {
    const result = await runner(resolveSkillHubCommand(), args, {
      timeout,
      signal: options.abortSignal,
    });
    const installedPath = path.join(skillsDir, id);
    const skillMd = path.join(installedPath, 'SKILL.md');
    const hasSkillMd = fs.existsSync(skillMd);
    // SkillHub may install under slug or a nested name — verify something landed.
    if (!hasSkillMd && !fs.existsSync(installedPath)) {
      // Search skillsDir for a newly written SKILL.md matching the slug.
      const found = findInstalledSkillDir(skillsDir, id);
      if (!found) {
        const detail = result.stdout.trim() || result.stderr.trim() || 'no files written';
        return { ok: false, message: `SkillHub install completed but skill was not found under .moss/skills: ${detail}` };
      }
      return {
        ok: true,
        dir: found,
        message: `Installed SkillHub skill "${id}" at ${path.relative(options.workspaceDir, found) || found}. Call load_skill name="${path.basename(found)}" to use it.`,
      };
    }
    return {
      ok: true,
      dir: installedPath,
      message: `Installed SkillHub skill "${id}" at .moss/skills/${id}/. Call load_skill name="${id}" to load full instructions.`,
    };
  } catch (err) {
    if (err instanceof ProcessError) {
      const detail = err.stderr.trim() || err.stdout.trim() || err.message;
      if (/enoent|not found/i.test(detail)) return { ok: false, message: skillHubInstallHint() };
      return { ok: false, message: `SkillHub install failed: ${detail}` };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

function findInstalledSkillDir(skillsDir: string, slug: string): string | undefined {
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    const lower = slug.toLowerCase();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.toLowerCase() === lower || entry.name.toLowerCase().includes(lower)) {
        const dir = path.join(skillsDir, entry.name);
        if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}
