#!/usr/bin/env node
/**
 * Sync the bundled RDK knowledge pack from the device-knowledge repo.
 *
 * Moss ships a snapshot of the open device-knowledge skills under
 * `assets/rdk-knowledge/skills/` so that every install is RDK-aware out of the
 * box (the SkillRegistry scans it by default). device-knowledge remains the
 * upstream source of truth — this script copies FROM it, never the other way.
 *
 * Source resolution (first match wins):
 *   1. `--source <path>` CLI flag
 *   2. `DEVICE_KNOWLEDGE_DIR` env var
 *   3. sibling checkout `../../device-knowledge` next to the moss repo
 *   4. shallow `git clone` of the public repo into a temp dir
 *
 * The two vendored Anthropic tooling skills (`skill-creator`, `mcp-builder`,
 * Apache-2.0) are maintainer-only and deliberately NOT bundled — Moss ships
 * only the MIT-licensed RDK knowledge skills.
 *
 * Usage:
 *   node scripts/sync-device-knowledge.mjs [--source <path>] [--clone]
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_URL = 'https://github.com/D-Robotics/device-knowledge';

/** Vendored Apache-2.0 maintainer tooling — not RDK knowledge, not bundled. */
const EXCLUDED_SKILLS = new Set(['skill-creator', 'mcp-builder']);

/** Per-skill subtrees skipped from the runtime bundle (test fixtures, junk). */
const SKIP_ENTRIES = new Set(['evals', 'node_modules', '.git', '.DS_Store']);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(pkgRoot, '..', '..');
const workspaceRoot = path.resolve(repoRoot, '..');

const targetRoot = path.join(pkgRoot, 'assets', 'rdk-knowledge');
const targetSkills = path.join(targetRoot, 'skills');

function parseArgs(argv) {
  const out = { source: undefined, clone: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') out.source = argv[++i];
    else if (argv[i] === '--clone') out.clone = true;
  }
  return out;
}

function gitCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/** Resolve the device-knowledge source dir; clone into a temp dir if needed. */
function resolveSource(args) {
  if (!args.clone) {
    const candidates = [
      args.source,
      process.env.DEVICE_KNOWLEDGE_DIR,
      path.join(workspaceRoot, 'device-knowledge'),
    ].filter(Boolean);
    for (const c of candidates) {
      const abs = path.resolve(c);
      if (fs.existsSync(path.join(abs, 'skills'))) {
        return { dir: abs, tmp: null };
      }
    }
  }
  // Fallback: shallow clone the public repo.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'device-knowledge-'));
  console.log(`No local checkout found — cloning ${REPO_URL} …`);
  execFileSync('git', ['clone', '--depth', '1', REPO_URL, tmp], { stdio: 'inherit' });
  return { dir: tmp, tmp };
}

/** Copy a single skill dir, skipping test fixtures and junk. */
function copySkill(src, dest) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => !SKIP_ENTRIES.has(path.basename(from)),
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { dir: sourceDir, tmp } = resolveSource(args);
  const sourceSkills = path.join(sourceDir, 'skills');

  try {
    if (!fs.existsSync(sourceSkills)) {
      throw new Error(`No skills/ directory under source: ${sourceDir}`);
    }

    const names = fs
      .readdirSync(sourceSkills, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !EXCLUDED_SKILLS.has(e.name))
      .map((e) => e.name)
      .sort();

    // Rebuild the target from scratch so removed/renamed skills don't linger.
    fs.rmSync(targetSkills, { recursive: true, force: true });
    fs.mkdirSync(targetSkills, { recursive: true });

    for (const name of names) {
      copySkill(path.join(sourceSkills, name), path.join(targetSkills, name));
    }

    // Carry the upstream MIT license — redistribution requires the notice.
    const licenseSrc = path.join(sourceDir, 'LICENSE');
    if (fs.existsSync(licenseSrc)) {
      fs.copyFileSync(licenseSrc, path.join(targetRoot, 'LICENSE'));
    }

    const commit = gitCommit(sourceDir);
    fs.writeFileSync(
      path.join(targetRoot, 'SOURCE.json'),
      JSON.stringify(
        {
          repo: REPO_URL,
          commit,
          syncedAt: new Date().toISOString(),
          skills: names,
        },
        null,
        2
      ) + '\n'
    );

    fs.writeFileSync(
      path.join(targetRoot, 'README.md'),
      [
        '# Bundled RDK knowledge pack',
        '',
        '> **Generated — do not edit by hand.**',
        '',
        `Synced from [device-knowledge](${REPO_URL}) (MIT). Refresh with:`,
        '',
        '```bash',
        'npm run sync:knowledge --workspace @rdk-moss/agent',
        '```',
        '',
        'The Apache-2.0 maintainer tooling skills (`skill-creator`, `mcp-builder`)',
        'are intentionally excluded — only MIT RDK knowledge skills are bundled.',
        '',
      ].join('\n')
    );

    console.log(
      `Synced ${names.length} RDK knowledge skills → ${path.relative(repoRoot, targetSkills)}`
    );
    console.log(`Source: ${sourceDir}${commit ? ` @ ${commit.slice(0, 12)}` : ''}`);
    console.log(`Excluded (Apache-2.0 tooling): ${[...EXCLUDED_SKILLS].join(', ')}`);
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main();
