import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findMaintainabilityViolations } from '../lib/maintainability.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

async function withSource(files, callback) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-maintainability-'));
  try {
    for (const [relative, body] of Object.entries(files)) {
      const absolute = path.join(tempRoot, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, body, 'utf8');
    }
    await callback(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('legacy hotspot growth fails at its checked-in ceiling', async () => {
  const fixture = JSON.parse(
    await fs.readFile(
      path.join(repoRoot, 'scripts/test/fixtures/code-standards/maintainability-growth.json'),
      'utf8'
    )
  );
  await withSource(fixture.files, (tempRoot) => {
    const findings = findMaintainabilityViolations(tempRoot, fixture.config);
    for (const expected of fixture.expectedDiagnostics) {
      assert.ok(
        findings.some((finding) => finding.includes(expected)),
        findings.join('\n')
      );
    }
  });
});

test('a new oversized source file fails', async () => {
  await withSource(
    { 'packages/moss-agent/src/new-hotspot.ts': '1\n2\n3\n4\n5\n6\n7\n8\n9\n' },
    (tempRoot) => {
      const findings = findMaintainabilityViolations(tempRoot, {
        newFileMaxLines: 8,
        legacyFiles: {},
        exceptions: {},
      });
      assert.ok(findings.some((finding) => finding.includes('exceeding new-file ceiling 8')));
    }
  );
});

test('a stale legacy ceiling fails and the deliberately reduced ceiling passes', async () => {
  const relative = 'packages/moss-agent/src/legacy.ts';
  await withSource({ [relative]: '1\n2\n3\n4\n5\n6\n7\n8\n9\n' }, (tempRoot) => {
    const stale = findMaintainabilityViolations(tempRoot, {
      newFileMaxLines: 8,
      legacyFiles: { [relative]: { maxLines: 10, reason: 'Legacy hotspot.' } },
      exceptions: {},
    });
    assert.ok(stale.some((finding) => finding.includes('legacy baseline is stale at 10')));

    const reduced = findMaintainabilityViolations(tempRoot, {
      newFileMaxLines: 8,
      legacyFiles: { [relative]: { maxLines: 9, reason: 'Reduced legacy ceiling.' } },
      exceptions: {},
    });
    assert.deepEqual(reduced, []);
  });
});
