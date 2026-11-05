#!/usr/bin/env node
/**
 * Claude Code `--add-dir` parity probe.
 *
 * Before: Moss's own file tools were hard-confined to the workspace in every
 * mode, so a repo that lives next to a sibling checkout (RDK Studio + moss,
 * app + firmware) could not be edited from one session. `--add-dir` now widens
 * exactly that boundary for one run, and nothing else: no AGENTS.md/skills are
 * loaded from the added tree, and the sandbox's symlink/realpath defenses still
 * apply.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '../..');
const addDir = await import(pathToFileURL(path.join(root, 'dist/cli/add-dir.js')).href);
const sandbox = await import(pathToFileURL(path.join(root, 'dist/safety/sandbox-paths.js')).href);
const envModule = await import(pathToFileURL(path.join(root, 'dist/context/environment.js')).href);
const helpers = await import(pathToFileURL(path.join(root, 'dist/tools/tool-helpers.js')).href);

const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'moss-add-dir-')));
const workspace = path.join(realRoot, 'ws');
const sibling = path.join(realRoot, 'sibling');
const nested = path.join(sibling, 'nested');
const file = path.join(realRoot, 'plain.txt');
for (const dir of [workspace, sibling, nested]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(file, 'x');
fs.symlinkSync(sibling, path.join(realRoot, 'sibling-link'));

let checks = 0;
const ok = (name) => {
  checks += 1;
  console.log(`[add-dir] ok ${name}`);
};

// 1. Resolution: relative to the workspace, realpath'd, deduped, workspace dropped,
//    and a bad value fails instead of silently shrinking the boundary.
{
  const dirs = addDir.resolveAdditionalDirectories(workspace, [
    '../sibling',
    sibling,
    path.join(realRoot, 'sibling-link'),
    workspace,
    '.',
  ]);
  assert.deepEqual(
    dirs,
    [sibling],
    'relative/absolute/symlink duplicates collapse to one realpath'
  );
  assert.deepEqual(addDir.resolveAdditionalDirectories(workspace, undefined), []);

  assert.throws(
    () => addDir.resolveAdditionalDirectories(workspace, [path.join(realRoot, 'missing')]),
    /does not exist/
  );
  assert.throws(() => addDir.resolveAdditionalDirectories(workspace, [file]), /is not a directory/);
  ok('resolves, realpaths, dedupes, drops the workspace, and rejects missing paths/files');
}

// 2. The sandbox accepts the added root and keeps rejecting everything else.
{
  const inside = await sandbox.assertSandboxPath({
    filePath: path.join(nested, 'a.txt'),
    cwd: workspace,
    root: workspace,
    extraRoots: [sibling],
  });
  assert.equal(inside.resolved, path.join(nested, 'a.txt'));

  await assert.rejects(
    sandbox.assertSandboxPath({ filePath: nested, cwd: workspace, root: workspace }),
    /escapes workspace/,
    'without the extra root the same path is still out of bounds'
  );
  await assert.rejects(
    sandbox.assertSandboxPath({
      filePath: path.join(realRoot, 'elsewhere', 'x.txt'),
      cwd: workspace,
      root: workspace,
      extraRoots: [sibling],
    }),
    /escapes workspace/
  );
  // The symlink defense is not relaxed for added roots: a symlinked root is
  // refused outright.
  await assert.rejects(
    sandbox.assertSandboxPath({
      filePath: path.join(realRoot, 'sibling-link', 'x.txt'),
      cwd: workspace,
      root: workspace,
      extraRoots: [path.join(realRoot, 'sibling-link')],
    }),
    /symlink/i
  );
  ok('added roots are contained, other paths still escape, and symlinked roots stay refused');
}

// 3. Tool helper: safePath threads the same roots.
{
  const resolved = await helpers.safePath(path.join(sibling, 'b.txt'), workspace, [sibling]);
  assert.equal(resolved, path.join(sibling, 'b.txt'));
  await assert.rejects(
    helpers.safePath(path.join(sibling, 'b.txt'), workspace),
    /escapes workspace/
  );
  ok('safePath accepts extra roots and keeps the workspace-only default');
}

// 4. The model is told the boundary exists, and that discovery files do not load.
{
  const layer = await envModule.buildEnvironmentContextLayer(workspace, {
    includeGit: false,
    additionalDirectories: [sibling],
  });
  assert.match(layer, new RegExp(`Additional directories \\(file tools may read and write`));
  assert.ok(layer.includes(sibling), 'the added path is named');
  assert.match(layer, /AGENTS\.md\/skills are not loaded from them/);
  const plain = await envModule.buildEnvironmentContextLayer(workspace, { includeGit: false });
  assert.doesNotMatch(plain, /Additional directories/);
  ok(
    'environment layer names added dirs, states the no-discovery caveat, and stays silent otherwise'
  );
}

fs.rmSync(realRoot, { recursive: true, force: true });
console.log(`[add-dir] ${checks}/4 checks passed`);
