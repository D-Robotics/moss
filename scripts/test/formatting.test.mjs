import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const prettierBin = fileURLToPath(
  new URL('../../node_modules/prettier/bin/prettier.cjs', import.meta.url)
);

function checkFormatting(source) {
  return spawnSync(
    process.execPath,
    [prettierBin, '--check', '--stdin-filepath', 'scripts/format-regression-fixture.mjs'],
    { cwd: repoRoot, input: source, encoding: 'utf8' }
  );
}

test('an unformatted covered file fails the formatting gate', () => {
  const result = checkFormatting('const value={answer:42}\nexport {value}\n');
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
});

test('formatted source passes the formatting gate', () => {
  const result = checkFormatting('const value = { answer: 42 };\nexport { value };\n');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
