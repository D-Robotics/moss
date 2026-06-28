#!/usr/bin/env node
/**
 * Installs git hooks from scripts/hooks/ into the active .git/hooks directory.
 * Works in both standalone repos (.git is a directory) and submodules
 * (.git is a file containing "gitdir: <path>").
 * Silently skips if .git doesn't exist (e.g. CI environments with shallow clones).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitEntry = path.join(repoRoot, '.git');

let hooksDir;
try {
  const stat = fs.statSync(gitEntry);
  if (stat.isDirectory()) {
    hooksDir = path.join(gitEntry, 'hooks');
  } else {
    // Submodule: .git is a file with "gitdir: <relative-path>"
    const content = fs.readFileSync(gitEntry, 'utf8').trim();
    const gitdir = content.startsWith('gitdir: ') ? content.slice('gitdir: '.length) : content;
    hooksDir = path.join(path.isAbsolute(gitdir) ? gitdir : path.join(repoRoot, gitdir), 'hooks');
  }
} catch {
  console.log('[install-hooks] .git not found, skipping hook installation');
  process.exit(0);
}

const srcDir = path.join(repoRoot, 'scripts', 'hooks');
let installed = 0;
for (const name of fs.readdirSync(srcDir)) {
  const src = path.join(srcDir, name);
  if (!fs.statSync(src).isFile()) continue;
  fs.mkdirSync(hooksDir, { recursive: true });
  const dst = path.join(hooksDir, name);
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
  console.log(`[install-hooks] installed ${name} -> ${dst}`);
  installed++;
}
if (installed === 0) console.log('[install-hooks] no hooks found in scripts/hooks/');
