import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { apiReportResultFailed, findApiInventoryViolations } from '../lib/api-governance.mjs';

test('an unreviewed export inventory change fails', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-api-inventory-'));
  const packageDir = path.join(tempRoot, 'packages/example');
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify({
      name: '@example/package',
      exports: {
        '.': { types: './dist/index.d.ts' },
        './unreviewed': { types: './dist/unreviewed.d.ts' },
      },
    })
  );

  try {
    const findings = findApiInventoryViolations(tempRoot, {
      packages: [
        {
          name: '@example/package',
          packageDir: 'packages/example',
          entrypoints: { '.': { types: './dist/index.d.ts' } },
        },
      ],
    });
    assert.ok(findings.some((finding) => finding.includes('export inventory drift')));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('API report drift fails verification but is allowed only in explicit update mode', () => {
  const changedReport = { succeeded: true, apiReportChanged: true };
  assert.equal(apiReportResultFailed(changedReport, false), true);
  assert.equal(apiReportResultFailed(changedReport, true), false);
  assert.equal(apiReportResultFailed({ succeeded: false, apiReportChanged: false }, true), true);
});
