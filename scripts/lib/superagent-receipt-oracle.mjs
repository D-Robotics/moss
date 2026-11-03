// Independent control-plane proof. This is not an operations business oracle.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { runGit } from '../../dist/utils/git-spawn.js';

const at = process.argv.indexOf('--case');
const caseName = at < 0 ? 'telemetry' : process.argv[at + 1];
try {
  assert.equal(await fs.readFile('receipt.txt', 'utf8'), 'RECEIVED\n');
  const changed = await runGit(['diff', '--name-only', 'HEAD'], { cwd: process.cwd() });
  const extra = await runGit(['ls-files', '--others', '--exclude-standard'], {
    cwd: process.cwd(),
  });
  assert.ok(
    (changed.stdout + '\n' + extra.stdout)
      .split('\n')
      .filter(Boolean)
      .every((name) => name === 'receipt.txt')
  );
  console.log(
    JSON.stringify({
      case: caseName,
      passed: true,
      checks: [{ name: 'exact receipt and original file scope', passed: true }],
    })
  );
} catch (error) {
  console.log(
    JSON.stringify({
      case: caseName,
      passed: false,
      checks: [
        {
          name: 'exact receipt and original file scope',
          passed: false,
          error: String(error.message).slice(0, 500),
        },
      ],
    })
  );
  process.exitCode = 1;
}
