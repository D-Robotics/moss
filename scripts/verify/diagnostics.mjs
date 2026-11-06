#!/usr/bin/env node
/**
 * D8 probe — the aggregated `diagnostics` tool.
 *
 * Before this change the only way to see compiler/linter errors was `exec` plus
 * the model re-parsing raw output. These checks pin the deterministic contract:
 * the tool is registered readonly/plan-safe, parses tsc output into normalized
 * findings with workspace-relative paths, honors `max` and `paths`, says
 * explicitly when there is nothing to report, and reports a missing toolchain
 * as actionable text instead of throwing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveNodeModulesTool } from './lib/resolve-tool.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const builtin = await import(pathToFileURL(path.join(root, 'dist/tools/builtin.js')).href);
const tool = builtin.builtinTools.find((candidate) => candidate.name === 'diagnostics');

const checks = [];
function ok(name) {
  checks.push(`PASS ${name}`);
}
async function check(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    checks.push(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const tscPath = resolveNodeModulesTool(root, 'typescript', 'bin', 'tsc');
assert.ok(tscPath, 'expected typescript to be installed (repo or hoisted node_modules)');

const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    include: ['**/*.ts'],
  },
  null,
  2
);

function makeWorkspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-diagnostics-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  }
  return dir;
}

const ctxFor = (workspaceDir) => ({ workspaceDir, sessionKey: 'diagnostics-probe' });

async function withEnv(overrides, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const renderLines = (text) =>
  text.split('\n').filter((line) => /:[0-9]+:[0-9]+ (?:error|warning) /.test(line));

// ── 1. Registration and side-effect metadata ───────────────────────────────

assert.ok(tool, 'diagnostics must be registered in builtinTools');
assert.equal(tool.metadata?.sideEffectClass, 'readonly');
assert.equal(tool.metadata?.planMode, 'allow');
assert.equal(tool.metadata?.requiresApproval, false);
assert.equal(tool.metadata?.maxResultTokens, 5_000);
assert.ok(typeof tool.metadata?.truncationHint === 'string' && tool.metadata.truncationHint);
assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['kind', 'max', 'paths']);
assert.equal(tool.inputSchema.required, undefined);
const lean = tool.metadata?.leanDescription;
assert.ok(typeof lean === 'string' && lean.length > 0, 'a >150-char description needs a lean tier');
assert.ok(
  lean.length < tool.description.length * 0.6,
  `lean description is ${lean.length} chars (full ${tool.description.length})`
);
assert.match(tool.description, /Not for arbitrary shell commands/);
ok('diagnostics is registered as a readonly, plan-safe, capped tool');

// ── 2. tsc findings are normalized and workspace-relative ──────────────────

const errorWorkspace = makeWorkspace({
  'tsconfig.json': TSCONFIG,
  'bad.ts': "const count: number = 'not a number';\nexport { count };\n",
  'bad2.ts': "const other: number = 'still a string';\nexport { other };\n",
});

let errorRunText;
await check('real type errors become normalized findings', async () => {
  const text = await withEnv({ MOSS_TSC_PATH: tscPath }, () =>
    tool.execute({}, ctxFor(errorWorkspace))
  );
  errorRunText = text;
  assert.match(text, /^2 error\(s\), 0 warning\(s\) from tsc$/m);
  const line = renderLines(text).find((entry) => entry.startsWith('bad.ts:'));
  assert.ok(line, `expected a rendered bad.ts finding, got:\n${text}`);
  assert.match(line, /^bad\.ts:1:\d+ error TS2322: /);
  assert.ok(line.includes('not assignable to type'));
  assert.ok(line.endsWith('(tsc)'));
  assert.ok(!text.includes(errorWorkspace), 'paths must be workspace-relative, not absolute');
});

// ── 3. max caps the rendered list, not the total ───────────────────────────

await check('max:1 renders one finding and reports the real total', async () => {
  const text = await withEnv({ MOSS_TSC_PATH: tscPath }, () =>
    tool.execute({ max: 1 }, ctxFor(errorWorkspace))
  );
  assert.equal(renderLines(text).length, 1, text);
  assert.match(text, /^2 error\(s\), 0 warning\(s\) from tsc$/m);
  assert.match(text, /2 diagnostics total; showing 1/);
});

// ── 4. paths filters findings after the run ────────────────────────────────

await check('paths keeps only findings under the requested path', async () => {
  const text = await withEnv({ MOSS_TSC_PATH: tscPath }, () =>
    tool.execute({ paths: ['bad2.ts'] }, ctxFor(errorWorkspace))
  );
  assert.match(text, /^1 error\(s\), 0 warning\(s\) from tsc$/m);
  assert.ok(text.includes('bad2.ts:'), text);
  assert.ok(!text.includes('bad.ts:'), 'bad.ts must be filtered out');
  assert.match(text, /Filtered to: bad2\.ts/);
});

// ── 5. Clean workspace says so explicitly ──────────────────────────────────

await check('a clean tsc project reports an explicit no-diagnostics line', async () => {
  const cleanWorkspace = makeWorkspace({
    'tsconfig.json': TSCONFIG,
    'good.ts': 'export const total: number = 1 + 2;\n',
  });
  try {
    const text = await withEnv({ MOSS_TSC_PATH: tscPath }, () =>
      tool.execute({}, ctxFor(cleanWorkspace))
    );
    assert.match(text, /^0 error\(s\), 0 warning\(s\) from tsc$/m);
    assert.match(text, /No diagnostics found/);
  } finally {
    fs.rmSync(cleanWorkspace, { recursive: true, force: true });
  }
});

// ── 6. Missing toolchain is actionable text, never a throw ─────────────────

await check('a tsconfig without an installed tsc returns an actionable note', async () => {
  const bareWorkspace = makeWorkspace({
    'tsconfig.json': TSCONFIG,
    'bad.ts': "const count: number = 'x';\nexport { count };\n",
  });
  try {
    const text = await withEnv({ MOSS_TSC_PATH: undefined }, () =>
      tool.execute({}, ctxFor(bareWorkspace))
    );
    assert.match(text, /0 error\(s\), 0 warning\(s\) from no toolchain/);
    assert.match(text, /no tsc toolchain resolved/);
    assert.match(text, /MOSS_TSC_PATH/);
  } finally {
    fs.rmSync(bareWorkspace, { recursive: true, force: true });
  }
});

await check('a workspace with no config at all says nothing was executed', async () => {
  const dir = makeWorkspace({ 'README.md': '# nothing to check\n' });
  try {
    const text = await withEnv({ MOSS_TSC_PATH: undefined, MOSS_ESLINT_PATH: undefined }, () =>
      tool.execute({}, ctxFor(dir))
    );
    assert.match(text, /No diagnostics sources/);
    assert.match(text, /nothing was executed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7. ESLint JSON is normalized too (best effort: repo eslint) ────────────

const eslintPath = resolveNodeModulesTool(root, 'eslint', 'bin', 'eslint.js');
await check('eslint JSON findings are normalized', async () => {
  if (!fs.existsSync(eslintPath)) {
    console.log(`[diagnostics] skip eslint check: ${eslintPath} not installed`);
    return;
  }
  const lintWorkspace = makeWorkspace({
    'eslint.config.mjs': 'export default [{ rules: { "no-unused-vars": "error" } }];\n',
    'code.js': 'const unused = 1;\n',
  });
  try {
    const text = await withEnv({ MOSS_ESLINT_PATH: eslintPath }, () =>
      tool.execute({ paths: ['code.js'] }, ctxFor(lintWorkspace))
    );
    assert.match(text, /1 error\(s\), 0 warning\(s\) from eslint/);
    const [line] = renderLines(text);
    assert.ok(line, `expected one eslint finding, got:\n${text}`);
    assert.match(line, /^code\.js:1:\d+ error no-unused-vars: /);
    assert.ok(line.endsWith('(eslint)'));
  } finally {
    fs.rmSync(lintWorkspace, { recursive: true, force: true });
  }
});

// ── 8. Result is a bounded string, not an object dump ──────────────────────

await check('the result is compact text with a summary line first', async () => {
  const text = errorRunText;
  assert.ok(typeof text === 'string');
  assert.match(text.split('\n')[0] ?? '', /^\d+ error\(s\), \d+ warning\(s\) from /);
  assert.ok(text.length < 20_000, `result should stay compact, got ${text.length} chars`);
});

// ── 9. Python: pytest failures are normalized, auto-detected when no Node config ──

const procLib = await import(pathToFileURL(path.join(root, 'dist/utils/run-process.js')).href);
const pytestAvailable = (() => {
  try {
    return procLib.runProcessSync('python3', ['-m', 'pytest', '--version']).status === 0;
  } catch {
    return false;
  }
})();

if (pytestAvailable) {
  const PY_TEST = [
    'def test_adds():',
    '    assert 1 + 1 == 2',
    '',
    'def test_fails():',
    '    assert 2 + 2 == 5',
    '',
  ].join('\n');
  const pyWorkspace = makeWorkspace({ 'tests/test_math.py': PY_TEST });

  await check('pytest failures become normalized findings (kind:python)', async () => {
    const text = await tool.execute({ kind: 'python' }, ctxFor(pyWorkspace));
    assert.match(text, /^1 error\(s\), 0 warning\(s\) from pytest$/m);
    const line = renderLines(text)[0];
    assert.ok(line, `expected a rendered pytest finding, got:\n${text}`);
    assert.match(line, /^tests\/test_math\.py:\d+:1 error AssertionError: assert /);
    assert.ok(line.endsWith('(pytest)'));
    assert.match(text, /pytest: 1 failed, 1 passed/);
    assert.ok(!text.includes(pyWorkspace), 'paths must be workspace-relative');
  });

  await check('auto detects pytest when no tsconfig/ESLint config exists', async () => {
    const text = await tool.execute({}, ctxFor(pyWorkspace));
    assert.match(text, /^1 error\(s\), 0 warning\(s\) from pytest$/m);
  });

  await check('kind:node on a Python-only workspace reports nothing executed', async () => {
    const text = await tool.execute({ kind: 'node' }, ctxFor(pyWorkspace));
    assert.match(text, /No diagnostics were run/);
    assert.match(text, /0 error\(s\), 0 warning\(s\) from no toolchain/);
  });

  await check('a clean Python project reports pytest counts and no findings', async () => {
    const clean = makeWorkspace({ 'tests/test_ok.py': 'def test_ok():\n    assert True\n' });
    const text = await tool.execute({ kind: 'python' }, ctxFor(clean));
    assert.match(text, /^0 error\(s\), 0 warning\(s\) from pytest$/m);
    assert.match(text, /pytest: 0 failed, 1 passed/);
    assert.match(text, /No diagnostics found/);
    fs.rmSync(clean, { recursive: true, force: true });
  });

  fs.rmSync(pyWorkspace, { recursive: true, force: true });
} else {
  ok('SKIP pytest checks (python3 -m pytest unavailable)');
}

fs.rmSync(errorWorkspace, { recursive: true, force: true });

for (const line of checks) console.log(`[diagnostics] ${line}`);
const failed = checks.filter((line) => line.startsWith('FAIL'));
if (failed.length > 0) {
  console.error(`[diagnostics] ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[diagnostics] ${checks.length} checks passed`);
