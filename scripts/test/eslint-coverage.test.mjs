import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const eslintBin = fileURLToPath(
  new URL('../../node_modules/eslint/bin/eslint.js', import.meta.url)
);

function lintSource(source, filename = 'scripts/lint-regression-fixture.mjs') {
  return spawnSync(
    process.execPath,
    [eslintBin, '--stdin', '--stdin-filename', filename, '--max-warnings', '0'],
    {
      cwd: repoRoot,
      input: source,
      encoding: 'utf8',
    }
  );
}

function lintTypedFile(source, filename) {
  const fixturePath = join(repoRoot, filename);
  writeFileSync(fixturePath, source, 'utf8');

  try {
    return spawnSync(process.execPath, [eslintBin, filename, '--max-warnings', '0'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } finally {
    rmSync(fixturePath, { force: true });
  }
}

test('covered MJS violations fail lint', () => {
  const result = lintSource('const unused = 1;\n');
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /no-unused-vars/);
});

test('warnings fail lint', () => {
  const result = lintSource(
    "// eslint-disable-next-line no-console -- intentional unused directive\nconsole.log('covered');\n"
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /Unused eslint-disable directive/);
  assert.match(output, /too many warnings/i);
});

test('typed promise handling violations fail lint', () => {
  const result = lintTypedFile(
    'async function work(): Promise<void> {}\nwork();\nexport { work };\n',
    'packages/moss-agent/src/eslint-promise-regression-fixture.ts'
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /@typescript-eslint\/no-floating-promises/);
});

test('malformed TSDoc fails lint', () => {
  const result = lintTypedFile(
    '/** Read a value.\n * @param value missing hyphen\n */\nexport function read(value: string): string { return value; }\n',
    'packages/moss/src/eslint-tsdoc-regression-fixture.ts'
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /tsdoc\/syntax/);
});

test('catch variables explicitly typed as any fail lint', () => {
  const result = lintTypedFile(
    'export function read(): void { try { throw new Error("boom"); } catch (error: any) { console.error(error); } }\n',
    'packages/moss-agent/src/eslint-catch-any-regression-fixture.ts'
  );
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.status, 1, output);
  assert.match(output, /Catch values must remain unknown/);
});
