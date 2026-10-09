/**
 * Copy a bench workspace's `.moss/` tree before the workspace is deleted.
 * The benchmark harness is frozen (Tier C); Moss must not weaken this copy.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Copy `<workspace>/.moss` to `dest`. Returns false when there is nothing to copy. */
export function copyMossArtifacts(workspace, dest) {
  const moss = path.join(workspace, '.moss');
  if (!fs.existsSync(moss)) return false;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(moss, dest, { recursive: true });
  return true;
}

/**
 * Capability-bench cleanup: copy artifacts first, then delete the workspace
 * unless `--keep` asked to retain it.
 */
export function releaseBenchWorkspace({ workspace, artifactDest, keep, keepArtifacts }) {
  if (keepArtifacts && artifactDest) copyMossArtifacts(workspace, artifactDest);
  if (!keep) fs.rmSync(workspace, { recursive: true, force: true });
}
