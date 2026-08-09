import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findPackageBoundaryViolations } from '../lib/package-boundaries.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function writeFixture(root, files) {
  for (const [relativePath, body] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, body, 'utf8');
  }
}

test('reverse workspace dependencies and imports fail with actionable diagnostics', async () => {
  const fixture = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, 'scripts/test/fixtures/code-standards/reverse-package-dependency.json'),
      'utf8'
    )
  );
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-boundary-negative-'));

  try {
    await writeFixture(tempRoot, fixture.files);
    const findings = findPackageBoundaryViolations(tempRoot);
    for (const expected of fixture.expectedDiagnostics) {
      assert.ok(
        findings.some((finding) => finding.includes(expected)),
        findings.join('\n')
      );
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('the documented create-app to agent to core direction is accepted', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-boundary-positive-'));
  const files = {
    'packages/moss/package.json': JSON.stringify({ name: '@rdk-moss/core' }),
    'packages/moss/src/index.ts': 'export const core = true;\n',
    'packages/moss-agent/package.json': JSON.stringify({
      name: '@rdk-moss/agent',
      dependencies: { '@rdk-moss/core': 'workspace:*' },
    }),
    'packages/moss-agent/src/index.ts': "export { core } from '@rdk-moss/core';\n",
    'packages/create-moss-app/package.json': JSON.stringify({
      name: 'create-moss-app',
      dependencies: { '@rdk-moss/agent': 'workspace:*' },
    }),
    'packages/create-moss-app/src/index.mjs': "import '@rdk-moss/agent';\n",
  };

  try {
    await writeFixture(tempRoot, files);
    assert.deepEqual(findPackageBoundaryViolations(tempRoot), []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
