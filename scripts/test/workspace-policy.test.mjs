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
    '[README](README.md) [docs](docs/README.md) [contributing](CONTRIBUTING.md) [core agent](packages/moss/AGENTS.md) [runtime agent](packages/moss-agent/AGENTS.md) [extending](packages/moss-agent/EXTENDING.md) [scaffold agent](packages/create-moss-app/AGENTS.md)',
    '## 文档所有权与阅读顺序',
    '源码/测试/manifest 决定实现事实。',
    '## 想做 X → 去哪改',
    '## 从需求到交付',
    '## 当前事实从哪里读',
    '`npm run test:filter -w @rdk-moss/core -- --filter host-adapter`',
    '| `npm ci` | setup | exit code 0 |',
    '| `npm run check` | fast | exit code 0 |',
    '| `npm run verify` | full | exit code 0 |',
    '`npm run test:filter -w @rdk-moss/agent -- --filter example`。至少匹配 1 个 spec，所有匹配 spec 均 exit code 0；无匹配报错退出。',
  ].join('\n');

  try {
    await fs.mkdir(path.join(tempRoot, 'packages/moss/test'), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, 'packages/moss/test/host-adapter.spec.mjs'),
      '// focused route fixture\n',
      'utf8'
    );
    await fs.writeFile(path.join(tempRoot, 'AGENTS.md'), entry, 'utf8');
    assert.deepEqual(findAgentEntryViolations(tempRoot, rootPackage), []);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('source-development docs reject npm install even when npm ci is also present', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-source-setup-negative-'));
  const files = {
    'package.json': JSON.stringify({ scripts: {}, workspaces: [] }),
    'CONTRIBUTING.md':
      '# Contributing\n## Setup\n```bash\nnpm ci\nnpm install # wrong source setup\n```',
    'README.md':
      '# Moss\n## Quick start\n```bash\nnpm install @rdk-moss/agent\n```\n## Develop\n```bash\nnpm ci\nnpm install # wrong source setup\n```',
    'README_CN.md': '# Moss\n## 开发\n```bash\nnpm ci\nnpm install # wrong source setup\n```',
    'packages/moss-agent/CONTRIBUTING.md':
      '# Contributing\n## Development Setup\n```bash\nnpm ci\nnpm install # wrong source setup\n```',
    'packages/moss-agent/README.md':
      '# Agent\n## From Source\n```bash\nnpm ci\nnpm install # wrong source setup\n```',
  };

  try {
    for (const [relative, body] of Object.entries(files)) {
      const absolute = path.join(tempRoot, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, body, 'utf8');
    }
    const rootPackage = JSON.parse(await fs.readFile(path.join(tempRoot, 'package.json'), 'utf8'));
    const findings = findDocumentationViolations(tempRoot, rootPackage);
    for (const relative of Object.keys(files).filter((item) => item.endsWith('.md'))) {
      assert.ok(
        findings.includes(`${relative}: source-development setup must not use bare npm install`),
        findings.join('\n')
      );
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('source-development docs accept npm ci and ignore consumer npm install sections', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-source-setup-valid-'));
  const files = {
    'package.json': JSON.stringify({ scripts: {}, workspaces: [] }),
    'CONTRIBUTING.md': '# Contributing\n## Setup\n```bash\nnpm ci # exact lockfile\n```',
    'README.md':
      '# Moss\n## Quick start\n```bash\nnpm install @rdk-moss/agent\n```\n## Develop\n```bash\nnpm ci\n```',
    'README_CN.md': '# Moss\n## 开发\n```bash\nnpm ci\n```',
    'packages/moss-agent/CONTRIBUTING.md':
      '# Contributing\n## Development Setup\n```bash\nnpm ci\n```',
    'packages/moss-agent/README.md':
      '# Agent\n## Install\n```bash\nnpm install @rdk-moss/agent\n```\n## From Source\n```bash\nnpm ci\n```',
  };

  try {
    for (const [relative, body] of Object.entries(files)) {
      const absolute = path.join(tempRoot, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, body, 'utf8');
    }
    const rootPackage = JSON.parse(await fs.readFile(path.join(tempRoot, 'package.json'), 'utf8'));
    assert.deepEqual(findDocumentationViolations(tempRoot, rootPackage), []);
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
    assert.ok(
      findings.some((finding) => finding.includes('host-adapter focused route must match')),
      findings.join('\n')
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('package agent owner paths must match the current package layout', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-package-agent-paths-'));

  try {
    await fs.mkdir(path.join(tempRoot, 'packages/moss/src/contracts'), { recursive: true });
    await fs.mkdir(path.join(tempRoot, 'packages/moss/src/prompts'), { recursive: true });
    await fs.writeFile(path.join(tempRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
    await fs.writeFile(
      path.join(tempRoot, 'packages/moss/AGENTS.md'),
      '# Core\n- `src/contracts/`\n- `src/prompt/`\n',
      'utf8'
    );

    const findings = findAgentEntryViolations(tempRoot, {
      engines: { node: '>=22.16.0' },
      scripts: {},
    });
    assert.ok(
      findings.includes('packages/moss/AGENTS.md: missing current owner path: src/prompts'),
      findings.join('\n')
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
