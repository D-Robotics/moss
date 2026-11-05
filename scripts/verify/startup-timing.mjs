#!/usr/bin/env node
/**
 * H2 probe — `MOSS_STARTUP_TIMING=1` prints one phased startup line; off by
 * default. Uses the offline mock provider, so no model call.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProcess } from './lib/proc.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const cli = path.join(root, 'dist/cli.js');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-timing-ws-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-timing-home-'));
fs.mkdirSync(path.join(home, '.config/moss'), { recursive: true });

const run = (env) =>
  captureProcess(process.execPath, [cli, '-p', 'Reply with the single word ok.', '--mock'], {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: home,
      MOSS_NO_RDK_DOCS: '1',
      MOSS_NO_TUI: '1',
      ...env,
    },
    timeoutMs: 120_000,
  });

/**
 * B18: what the boot graph actually loads, observed with a resolve hook instead
 * of a wall-clock timer (module load is the cost; the timer is noise).
 */
const preload = path.join(os.tmpdir(), `moss-modcount-${process.pid}.mjs`);
fs.writeFileSync(
  preload,
  [
    "import fs from 'node:fs';",
    "import module from 'node:module';",
    'const seen = new Set();',
    'module.registerHooks({',
    '  resolve(specifier, context, nextResolve) {',
    '    const result = nextResolve(specifier, context);',
    "    if (result && typeof result.url === 'string' && result.url.startsWith('file:')) seen.add(result.url);",
    '    return result;',
    '  },',
    '});',
    "process.on('exit', () => fs.writeFileSync(process.env.MOSS_MODCOUNT_OUT, JSON.stringify([...seen])));",
    '',
  ].join('\n')
);

let moduleCountRun = 0;
const bootGraph = async (extraEnv) => {
  const out = path.join(workspace, `modcount-${(moduleCountRun += 1)}.json`);
  await captureProcess(process.execPath, ['--import', preload, cli], {
    // Interactive boot (REPL): stdin is empty, so the readline loop hits EOF and
    // exits — the graph loaded up to that point is the startup graph.
    cwd: workspace,
    env: {
      ...process.env,
      HOME: home,
      MOSS_CONFIG_DIR: path.join(home, '.config/moss'),
      MOSS_NO_TUI: '1',
      MOSS_NO_RDK_DOCS: '1',
      MOSS_TRUST_WORKSPACE: '1',
      MOSS_MODCOUNT_OUT: out,
      ...extraEnv,
    },
    timeoutMs: 60_000,
  });
  if (!fs.existsSync(out)) throw new Error('module-count hook did not record the boot graph');
  return JSON.parse(fs.readFileSync(out, 'utf8'));
};

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(`PASS ${name}`);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const LINE_RE =
  /\[startup\] timing: (entry=\d+ms )?(proxy=\d+ms )?config=\d+ms (env=\d+ms )?prompt=\d+ms agent=\d+ms mcp=\d+ms (probe=\d+ms )?skills=\d+ms total=\d+ms/;

await check('MOSS_STARTUP_TIMING=1 prints a phased, monotonic startup line', async () => {
  // One run covers both the shape and the ordering: a second spawn only
  // repeated the same provider round-trip and cost ~1s of the verify budget.
  const result = await run({ MOSS_STARTUP_TIMING: '1' });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const line = `${result.stderr}`.split('\n').find((entry) => entry.includes('[startup] timing:'));
  assert.ok(line, `no timing line in stderr:\n${result.stderr}`);
  assert.match(line, LINE_RE);
  const values = Object.fromEntries(
    [...line.matchAll(/(\w+)=(\d+)ms/g)].map((match) => [match[1], Number(match[2])])
  );
  // `entry` is process uptime at first mark, not a delta on the phase clock.
  if (values.entry !== undefined) assert.ok(values.entry > 0, line);
  const labels = [...line.matchAll(/(\w+)=\d+ms/g)].map((match) => match[1]);
  assert.equal(new Set(labels).size, labels.length, `duplicate phase label: ${line}`);
  if (values.env !== undefined) assert.ok(values.config <= values.env, line);
  if (values.env !== undefined) assert.ok(values.env <= values.prompt, line);
  assert.ok(values.config <= values.prompt, line);
  assert.ok(values.prompt <= values.agent, line);
  assert.ok(values.agent <= values.mcp, line);
  assert.ok(values.mcp <= values.skills, line);
  if (values.probe !== undefined) assert.ok(values.probe <= values.skills, line);
  assert.ok(values.skills <= values.total, line);
});

await check(
  'boot without a proxy does not load undici (dispatcher installs at first request)',
  async () => {
    const files = await bootGraph({});
    assert.ok(
      files.some((file) => file.includes('/dist/cli/runtime.js')),
      'the REPL boot graph must include cli/runtime.js (probe did not reach the real boot path)'
    );
    assert.equal(
      files.some((file) => file.includes('/node_modules/undici/')),
      false,
      `undici loaded during boot (${files.filter((file) => file.includes('/node_modules/undici/')).length} modules): ${files
        .filter((file) => file.includes('/node_modules/undici/'))
        .slice(0, 3)
        .join(', ')}`
    );
  }
);

await check('a configured proxy still installs the dispatcher during boot', async () => {
  const files = await bootGraph({
    HTTPS_PROXY: 'http://127.0.0.1:9',
    HTTP_PROXY: 'http://127.0.0.1:9',
    no_proxy: '',
    NO_PROXY: '',
  });
  assert.ok(
    files.some((file) => file.includes('/node_modules/undici/')),
    'with HTTPS_PROXY set the dispatcher must be installed before any request'
  );
});

await check('timing is off by default', async () => {
  const result = await run({});
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('[startup] timing:'));
});

await check('the flag is read as a boolean, not any non-empty string', async () => {
  const result = await run({ MOSS_STARTUP_TIMING: '0' });
  assert.equal(result.status, 0);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('[startup] timing:'));
});

fs.rmSync(preload, { force: true });
for (const line of checks) console.log(`[startup-timing] ${line}`);
fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[startup-timing] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[startup-timing] ${checks.length} checks passed`);
