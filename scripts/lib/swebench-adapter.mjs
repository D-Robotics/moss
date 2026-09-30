#!/usr/bin/env node
/**
 * SWE-bench adapter: runs moss headless INSIDE the official SWE-bench eval
 * container for an instance, then extracts the model patch.
 *
 * Why inside the container: the eval image carries the exact python/conda
 * environment for the repo at base_commit, so moss can run the project's real
 * tests while composing its fix — same operating conditions as mainstream
 * harnesses.
 *
 * Grading is deliberately NOT done here: predictions are written in the
 * official format and graded by the upstream `swebench.harness.run_evaluation`
 * (see bench-swebench.mjs --eval) so the scoring rule is the public one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const NODE_RUNTIME_URL = 'https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.gz';
const NODE_RUNTIME_TARBALL = 'node-v22.16.0-linux-x64.tar.gz';

function docker(args, { timeoutMs = 120_000, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { stdio: quiet ? 'ignore' : 'pipe' });
    let out = '';
    let err = '';
    if (!quiet) {
      child.stdout?.on('data', (d) => (out += d));
      child.stderr?.on('data', (d) => (err += d));
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function execContainer(name, cmd, { timeoutMs = 60_000 } = {}) {
  const res = await docker(['exec', name, 'bash', '-lc', cmd], { timeoutMs });
  return { code: res.code, out: res.out.trim(), err: res.err.trim() };
}

export function buildPrompt(instance) {
  const statement = String(instance.problem_statement ?? '');
  const clipped =
    statement.length > 12_000
      ? `${statement.slice(0, 12_000)}\n\n[... issue text truncated ...]`
      : statement;
  return [
    `You are working in the git repository ${instance.repo} at /testbed (base commit ${instance.base_commit}).`,
    'Fix the issue below. Make a minimal, correct change to the source code.',
    "A conda environment 'testbed' with the project installed is active; you can run the project's tests and commands to verify your fix.",
    'Do NOT modify, add, or delete test files. Do not create commits or branches; leave your changes uncommitted in the working tree.',
    'End with a one-paragraph summary of the root cause and your fix.',
    '',
    'ISSUE:',
    clipped,
  ].join('\n');
}

/** Paths touched by the official test patch — the model patch must not include them. */
export function testPatchPaths(instance) {
  const paths = new Set();
  for (const line of String(instance.test_patch ?? '').split('\n')) {
    const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line) || /^\+\+\+ b\/(\S+)/.exec(line);
    if (m) paths.add(m[2] ?? m[1]);
  }
  return [...paths];
}

export async function prepareContainer(instance, opts) {
  const { containerName, mossDistDir, mossNodeModulesDir, nodeTarballPath } = opts;
  await docker(['rm', '-f', containerName], { quiet: true });
  const run = await docker([
    'run',
    '-d',
    '--platform',
    'linux/amd64',
    '--name',
    containerName,
    '--memory',
    '6g',
    instance.image,
    'sleep',
    'infinity',
  ]);
  if (run.code !== 0) throw new Error(`docker run failed: ${run.err || run.out}`);

  await execContainer(
    containerName,
    [
      'git config --global --add safe.directory /testbed || true',
      'cd /testbed && git reset --hard && git clean -fdq',
      `cd /testbed && git checkout -q ${instance.base_commit} 2>/dev/null || true`,
    ].join(' && ')
  );
  await docker(['cp', nodeTarballPath, `${containerName}:/tmp/${NODE_RUNTIME_TARBALL}`]);
  await docker(['cp', `${mossDistDir}/.`, `${containerName}:/opt/moss/`]);
  await docker(['cp', `${mossNodeModulesDir}`, `${containerName}:/opt/moss/node_modules`]);
  const setup = await execContainer(
    containerName,
    `mkdir -p /opt/node && tar -xzf /tmp/${NODE_RUNTIME_TARBALL} -C /opt/node --strip-components=1 && chmod +x /opt/moss/cli.js`
  );
  if (setup.code !== 0) throw new Error(`container setup failed: ${setup.err}`);
}

export async function writeProviderConfig(containerName, provider) {
  const config = {
    provider: 'openai-compatible',
    model: provider.model,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
  };
  const cmd = `mkdir -p /root/.config/moss && cat > /root/.config/moss/config.json <<'MOSSCFG'\n${JSON.stringify(
    config,
    null,
    2
  )}\nMOSSCFG`;
  const res = await execContainer(containerName, cmd);
  if (res.code !== 0) throw new Error(`provider config write failed: ${res.err}`);
}

export async function runMossInContainer(instance, opts) {
  const { containerName, provider, maxTurns = 40, timeoutMs = 25 * 60_000, extraEnv = {} } = opts;
  const prompt = buildPrompt(instance);
  const promptFile = `/tmp/moss-prompt-${Date.now()}.txt`;
  const seed = Math.random().toString(36).slice(2, 8);
  const writePrompt = `cat > ${promptFile} <<'MOSSEOF'\n${prompt.replace(
    /MOSSEOF/g,
    'MOSSEOF_'
  )}\nMOSSEOF`;
  let res = await execContainer(containerName, writePrompt);
  if (res.code !== 0) throw new Error(`prompt write failed: ${res.err}`);

  const mossCmd = [
    'export PATH=/opt/node/bin:$PATH',
    'cd /testbed',
    'export MOSS_CONFIG_DIR=/root/.config/moss',
    'export MOSS_RUN_ID=swe/' + instance.instance_id + '/' + seed,
    'export MOSS_SAFETY_MODE=workspace-write',
    'export MOSS_APPROVAL_POLICY=never',
    'export MOSS_NO_COLOR=1',
    ...Object.entries(extraEnv).map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`),
    `node /opt/moss/cli.js -p --output-format stream-json --ask-for-approval never --model ${JSON.stringify(
      provider.model
    )} --base-url ${JSON.stringify(provider.baseUrl)} --max-turns ${maxTurns} "$(cat ${promptFile})"`,
  ].join('\n');
  const started = Date.now();
  res = await docker(['exec', containerName, 'bash', '-lc', mossCmd], { timeoutMs, quiet: false });
  return {
    exitCode: res.code,
    stdout: res.out,
    stderr: res.err,
    wallMs: Date.now() - started,
  };
}

export async function extractPatch(instance, containerName) {
  await execContainer(containerName, 'rm -rf /testbed/.moss /tmp/moss-prompt-*.txt || true');
  const excludes = testPatchPaths(instance)
    .map((p) => `':(exclude)'${p}`)
    .join(' ');
  const add = await execContainer(containerName, 'cd /testbed && git add -A');
  if (add.code !== 0) throw new Error(`git add failed: ${add.err}`);
  const diff = await execContainer(
    containerName,
    `cd /testbed && git diff --cached ${instance.base_commit} -- . ${excludes}`
  );
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.err}`);
  const reset = await execContainer(
    containerName,
    'cd /testbed && git reset -q && git checkout -- . || true'
  );
  if (reset.code !== 0) throw new Error(`git reset failed: ${reset.err}`);
  return diff.out.endsWith('\n') || diff.out === '' ? diff.out : `${diff.out}\n`;
}

export async function cleanupContainer(containerName) {
  await docker(['rm', '-f', containerName], { quiet: true });
}

export function ensureNodeTarballForArch(cacheDir, arch = 'x64') {
  const mapping = {
    x64: 'node-v22.16.0-linux-x64.tar.gz',
    arm64: 'node-v22.16.0-linux-arm64.tar.gz',
  };
  const file = mapping[arch];
  if (!file) throw new Error(`unsupported node arch: ${arch}`);
  const url = `https://nodejs.org/dist/v22.16.0/${file}`;
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, file);
  if (fs.existsSync(target) && fs.statSync(target).size > 10_000_000) return target;
  const res = spawnFetch(url, target);
  if (!res.ok) throw new Error(`node runtime download failed: ${url}`);
  return target;
}

export async function ensureNodeTarball(cacheDir) {
  return ensureNodeTarballForArch(cacheDir, 'x64');
}

function spawnFetch(url, target) {
  return new Promise((resolve) => {
    const child = spawn('curl', ['-sSL', '--fail', '-o', target, url]);
    child.on('close', (code) => resolve({ ok: code === 0 }));
    child.on('error', () => resolve({ ok: false }));
  });
}

export async function ensureImage(image) {
  const present = await docker(['image', 'inspect', image], { quiet: true });
  if (present.code === 0) return true;
  const pull = await docker(['pull', '--platform', 'linux/amd64', image], {
    timeoutMs: 20 * 60_000,
    quiet: false,
  });
  return pull.code === 0;
}

export function metricsFromStreamJson(stdout) {
  const lines = stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  let lastResult = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let toolCalls = 0;
  let llmCalls = 0;
  for (const ev of lines) {
    if (ev.type === 'llm_usage') {
      tokensIn += Number(ev.input_tokens ?? 0);
      tokensOut += Number(ev.output_tokens ?? 0);
      llmCalls += 1;
    }
    if (ev.type === 'assistant') {
      const content = Array.isArray(ev.message?.content) ? ev.message.content : [];
      toolCalls += content.filter((b) => b.type === 'tool_use').length;
    }
    if (ev.type === 'result') lastResult = ev;
  }
  return { tokensIn, tokensOut, toolCalls, turns: llmCalls, lastResult, events: lines.length };
}

export { docker, execContainer };
