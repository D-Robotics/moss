import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Package metadata reads live in the inner layer so both the CLI and the core
 * runtime can use them without a core → cli import (boundary rule).
 */
export function getPackageJsonPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
}

export function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(getPackageJsonPath(), 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Commit and UTC date written beside this module at build time. */
export interface BuildStamp {
  readonly commit?: string;
  readonly date?: string;
}

function validCommit(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const commit = value.trim();
  return /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : undefined;
}

function validDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

/**
 * Read `dist/utils/build-stamp.json`. Missing, unreadable, or empty stamps
 * return null so `--version` can fall back to the package version alone.
 */
export function readBuildStamp(stampPath?: string): BuildStamp | null {
  const file =
    stampPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'build-stamp.json');
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as { commit?: unknown; date?: unknown };
    const commit = validCommit(record.commit);
    const date = validDate(record.date);
    if (!commit && !date) return null;
    return { ...(commit ? { commit } : {}), ...(date ? { date } : {}) };
  } catch {
    return null;
  }
}

/**
 * `moss v0.26.0 (e8dc2e3, 2026-10-10)`. The parenthetical is omitted when the
 * commit is missing, including when only a date was recorded.
 */
export function formatVersionLine(version: string, stamp: BuildStamp | null): string {
  if (version === 'unknown') return 'moss (unknown version)';
  const commit = stamp?.commit;
  const date = stamp?.date;
  if (commit && date) return `moss v${version} (${commit}, ${date})`;
  if (commit) return `moss v${version} (${commit})`;
  return `moss v${version}`;
}
