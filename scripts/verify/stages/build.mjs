/**
 * Build stage: emit `dist/` from `src/`.
 *
 * Incremental by default (keeps `dist/` warm, sweeps outputs whose source is
 * gone). `--clean` removes `dist/` first, which is what `npm run build` does.
 * The TypeScript incremental state lives in `node_modules/.cache/` so it never
 * rides along with the published package.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { formatDuration } from '../lib/proc.mjs';

const SRC_EXTENSIONS = ['.ts', '.tsx'];

function hasSource(srcDir, rel) {
  let base = rel;
  if (base.endsWith('.d.ts.map')) base = base.slice(0, -'.d.ts.map'.length);
  else if (base.endsWith('.js.map')) base = base.slice(0, -'.js.map'.length);
  else if (base.endsWith('.d.ts')) base = base.slice(0, -'.d.ts'.length);
  else if (base.endsWith('.js')) base = base.slice(0, -'.js'.length);
  else return true;
  return SRC_EXTENSIONS.some((ext) => fs.existsSync(path.join(srcDir, `${base}${ext}`)));
}

function sweepStaleOutputs(distDir, srcDir) {
  if (!fs.existsSync(distDir)) return;
  const stack = [distDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(file);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!hasSource(srcDir, path.relative(distDir, file))) fs.rmSync(file);
    }
  }
}

export const stage = {
  name: 'build',
  requires: [],
  description: 'compile src/ into dist/ (incremental by default)',
  async run(context) {
    const root = context.root;
    const distDir = path.join(root, 'dist');
    const srcDir = path.join(root, 'src');
    const buildInfoDir = path.join(root, 'node_modules', '.cache');
    const buildInfo = path.join(buildInfoDir, 'moss.tsbuildinfo');
    const tsc = path.join(root, 'node_modules', 'typescript', 'lib', 'tsc.js');
    if (!fs.existsSync(tsc)) {
      return { ok: false, detail: 'typescript is not installed (run npm ci)' };
    }

    if (context.clean) {
      // A clean build must also drop the incremental state: otherwise tsc
      // believes the deleted outputs are up to date and emits nothing.
      fs.rmSync(distDir, { recursive: true, force: true });
      fs.rmSync(buildInfo, { force: true });
    }
    fs.mkdirSync(buildInfoDir, { recursive: true });
    fs.rmSync(path.join(distDir, '.tsbuildinfo'), { force: true });

    const startedAt = Date.now();
    const compile = () =>
      spawnSync(
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
    let compiled = compile();
    if (compiled.error) {
      return { ok: false, detail: `tsc failed to start: ${compiled.error.message}` };
    }
    if (compiled.status !== 0) {
      return { ok: false, detail: `tsc exited ${compiled.status ?? compiled.signal}` };
    }

    // An interrupted build can leave build info that claims outputs exist.
    // Detect the missing entry point and fall back to one clean rebuild.
    if (!fs.existsSync(path.join(distDir, 'cli.js')) && !context.clean) {
      console.warn('[build] dist/cli.js missing after incremental build; rebuilding clean');
      fs.rmSync(distDir, { recursive: true, force: true });
      fs.rmSync(buildInfo, { force: true });
      compiled = compile();
      if (compiled.error) {
        return { ok: false, detail: `clean rebuild failed to start: ${compiled.error.message}` };
      }
      if (compiled.status !== 0) {
        return { ok: false, detail: `clean rebuild exited ${compiled.status ?? compiled.signal}` };
      }
    }
    if (!fs.existsSync(path.join(distDir, 'cli.js'))) {
      return { ok: false, detail: 'dist/cli.js was not produced by the build' };
    }

    sweepStaleOutputs(distDir, srcDir);

    const stamp = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'write-build-stamp.mjs')],
      {
        cwd: root,
        stdio: 'inherit',
      }
    );
    if (stamp.error) {
      return { ok: false, detail: `build stamp failed to start: ${stamp.error.message}` };
    }
    if (stamp.status !== 0) {
      return { ok: false, detail: `build stamp exited ${stamp.status ?? stamp.signal}` };
    }
    fs.chmodSync(path.join(distDir, 'cli.js'), 0o755);

    console.log(
      `[build] ${context.clean ? 'clean' : 'incremental'} build ok in ${formatDuration(Date.now() - startedAt)}`
    );
    return { ok: true };
  },
};
