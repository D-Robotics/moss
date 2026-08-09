import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findAgentEntryViolations, findDocumentationViolations } from '../lib/workspace-policy.mjs';

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

test('agent entry accepts executable setup, focused, fast, and full verification contracts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-agent-entry-valid-'));
  const rootPackage = {
    engines: { node: '>=22.16.0' },
    scripts: { check: 'check', verify: 'verify' },
  };
  const entry = [
    '# AGENTS.md',
    'Node ≥ 22.16.0.',
    '| `npm ci` | setup | exit code 0 |',
    '| `npm run check` | fast | exit code 0 |',
    '| `npm run verify` | full | exit code 0 |',
    '`npm run test:filter -w @rdk-moss/agent -- --filter example`。至少匹配 1 个 spec，所有匹配 spec 均 exit code 0；无匹配报错退出。',
  ].join('\n');

  try {
    await fs.writeFile(path.join(tempRoot, 'AGENTS.md'), entry, 'utf8');
    assert.deepEqual(findAgentEntryViolations(tempRoot, rootPackage), []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('agent entry reports missing setup and success contracts', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-agent-entry-negative-'));
  const rootPackage = {
    engines: { node: '>=22.16.0' },
    scripts: { check: 'check', verify: 'verify' },
  };
  const brokenEntry = [
    '# AGENTS.md',
    'Node ≥ 22.16.0.',
    '`npm run check`',
    '| `npm run verify` | full | exit code 0 |',
    '`npm run test:filter -w @rdk-moss/agent -- --filter example`；无匹配报错退出。',
  ].join('\n');

  try {
    await fs.writeFile(path.join(tempRoot, 'AGENTS.md'), brokenEntry, 'utf8');
    const findings = findAgentEntryViolations(tempRoot, rootPackage);
    assert.ok(
      findings.some((finding) => finding.includes('npm ci')),
      findings.join('\n')
    );
    assert.ok(
      findings.some((finding) => finding.includes('success contract for: npm run check')),
      findings.join('\n')
    );
    assert.ok(
      findings.some((finding) => finding.includes('at least one match')),
      findings.join('\n')
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
