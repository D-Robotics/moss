import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const agentSourceRoot = path.join(repoRoot, 'packages/moss-agent/src');

async function sourceFiles(root) {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test('runtime child processes are imported only by the shared process boundary', async () => {
  const violations = [];
  for (const filename of await sourceFiles(agentSourceRoot)) {
    const relative = path.relative(repoRoot, filename).replaceAll('\\', '/');
    if (relative === 'packages/moss-agent/src/utils/run-process.ts') continue;
    const source = await fs.readFile(filename, 'utf8');
    if (/node:child_process/.test(source)) violations.push(relative);
  }

  assert.deepEqual(
    violations,
    [],
    `route runtime child processes through utils/run-process.ts:\n${violations.join('\n')}`
  );
});

test('complete verification treats documentation warnings as failures', async () => {
  const rootPackage = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const corePackage = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'packages/moss/package.json'), 'utf8')
  );
  const agentPackage = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'packages/moss-agent/package.json'), 'utf8')
  );
  const agentTypeDoc = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'packages/moss-agent/typedoc.json'), 'utf8')
  );

  assert.match(rootPackage.scripts.verify, /npm run docs/);
  assert.match(corePackage.scripts.docs, /--treatWarningsAsErrors/);
  assert.match(agentPackage.scripts.docs, /--options typedoc\.json/);
  assert.equal(agentTypeDoc.treatWarningsAsErrors, true);
  assert.ok(agentTypeDoc.intentionallyNotExported.length > 0);
});
