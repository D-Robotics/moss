#!/usr/bin/env node
/**
 * Emit dist/ without deleting it first. `npm test` uses this so a warm tree
 * does not pay for a clean tsc. `npm run build` stays the clean release build.
 * After a successful emit, drop outputs whose source file is gone — tsc
 * incremental does not always remove those.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const srcDir = path.join(root, 'src');
const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
// Keep the incremental info out of dist/. `package.json` `files` publishes
// everything under dist/ except maps, and the pack test rejects anything else.
const buildInfoDir = path.join(root, 'node_modules', '.cache');
const buildInfo = path.join(buildInfoDir, 'moss.tsbuildinfo');

fs.mkdirSync(buildInfoDir, { recursive: true });
fs.rmSync(path.join(distDir, '.tsbuildinfo'), { force: true });

const compiled = spawnSync(
  process.execPath,
  [
    tsc,
    '-p',
    'tsconfig.build.json',
    '--pretty',
    'false',
    '--incremental',
    '--tsBuildInfoFile',
    buildInfo,
  ],
  { cwd: root, stdio: 'inherit' }
);
if (compiled.error) {
  console.error(`[build] ${compiled.error.message}`);
  process.exit(1);
}
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

function hasSource(rel) {
  let base = rel;
  if (base.endsWith('.d.ts.map')) base = base.slice(0, -'.d.ts.map'.length);
  else if (base.endsWith('.js.map')) base = base.slice(0, -'.js.map'.length);
  else if (base.endsWith('.d.ts')) base = base.slice(0, -'.d.ts'.length);
  else if (base.endsWith('.js')) base = base.slice(0, -'.js'.length);
  else return true;
  return ['.ts', '.tsx'].some((ext) => fs.existsSync(path.join(srcDir, `${base}${ext}`)));
}

function sweep(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sweep(file);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(distDir, file);
    if (!hasSource(rel)) fs.rmSync(file);
  }
}

sweep(distDir);

const stamp = spawnSync(process.execPath, [path.join(root, 'scripts', 'write-build-stamp.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (stamp.error) {
  console.error(`[build] ${stamp.error.message}`);
  process.exit(1);
}
if (stamp.status !== 0) process.exit(stamp.status ?? 1);
fs.chmodSync(path.join(distDir, 'cli.js'), 0o755);
