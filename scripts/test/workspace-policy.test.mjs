import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findDocumentationViolations } from '../lib/workspace-policy.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

test('missing policy files and nonexistent documented scripts fail hygiene', async () => {
  const fixture = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, 'scripts/test/fixtures/code-standards/stale-policy-reference.json'),
      'utf8'
    )
  );
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-policy-negative-'));

  try {
    for (const [relative, body] of Object.entries(fixture.files)) {
      const absolute = path.join(tempRoot, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, body, 'utf8');
    }
    const rootPackage = JSON.parse(await fs.readFile(path.join(tempRoot, 'package.json'), 'utf8'));
    const findings = findDocumentationViolations(tempRoot, rootPackage);
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
