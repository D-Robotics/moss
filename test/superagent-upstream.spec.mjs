import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

test('vendored DeepSeek core matches its pinned provenance and has no plugin/runtime dependencies', async () => {
  const manifest = JSON.parse(
    await fs.readFile(new URL('../docs/specs/superagent-upstream.json', import.meta.url), 'utf8')
  );
  assert.equal(manifest.repository, 'https://github.com/deepseek-ai/dsh-superagent-prototype');
  assert.equal(manifest.commit, '6337fc823ce20251c8de8085948165c81aaa701e');
  const root = new URL('../src/core/superagent/upstream/', import.meta.url);
  assert.deepEqual((await fs.readdir(root)).sort(), Object.keys(manifest.files).sort());
  for (const [name, record] of Object.entries(manifest.files)) {
    const text = await fs.readFile(new URL(name, root), 'utf8');
    assert.match(record.upstreamSha256, /^[a-f0-9]{64}$/);
    assert.equal(createHash('sha256').update(text).digest('hex'), record.vendoredSha256, name);
    for (const match of text.matchAll(/from ['"]([^'"]+)['"]/g)) {
      const dependency = match[1];
      if (dependency === 'node:crypto') continue;
      assert.match(dependency, /^\.\/[a-z-]+\.js$/, name);
      assert.ok(manifest.files[dependency.slice(2).replace(/\.js$/, '.ts')], dependency);
    }
  }
  const notices = await fs.readFile(new URL('../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8');
  assert.match(notices, /MIT License/);
  assert.match(notices, /DeepSeek/);
});
