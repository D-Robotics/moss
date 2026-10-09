/**
 * Device task benchmark.
 *
 * Dry mode drives Moss's task engine (`runTask`) with a scripted turn and the
 * command verdict. Live modes spawn `moss task run` against a sim ssh2 server
 * or a real board. PASS is the engine outcome, never agent prose.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { approvalEnv } from './device-bench-approval.mjs';
import { commandText, findForbidden, redactSecrets, shellQuote } from './device-bench-safety.mjs';
import { execOnTarget, newBenchPassword, startSimSsh } from './device-bench-target.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEVICE_TASK_DIR = path.join(repoRoot, 'bench', 'device-tasks');
const ACCEPT_SCRIPT = path.join(repoRoot, 'scripts', 'lib', 'device-bench-accept.mjs');
const REQUIRED = [
  'id',
  'title',
  'sideEffect',
  'prompt',
  'prerequisites',
  'setup',
  'oracle',
  'acceptance',
  'cleanup',
  'evidence',
];

export function validateDeviceTasks(tasks) {
  const problems = [];
  const seen = new Set();
  for (const task of tasks) {
    for (const key of REQUIRED) {
      if (task[key] === undefined) problems.push(`${task.id ?? task.file ?? '?'}: missing ${key}`);
    }
    if (task.sideEffect !== 'readonly' && task.sideEffect !== 'mutating') {
      problems.push(`${task.id}: sideEffect must be readonly or mutating`);
    }
    if (
      task.sideEffect === 'mutating' &&
      (!Array.isArray(task.cleanup) || task.cleanup.length === 0)
    ) {
      problems.push(`${task.id}: mutating tasks need cleanup`);
    }
    if (seen.has(task.id)) problems.push(`${task.id}: duplicate id`);
    seen.add(task.id);
    const hits = findForbidden(commandText(task));
    if (hits.length > 0) problems.push(`${task.id}: forbidden command (${hits.join(',')})`);
    for (const spec of task.evidence ?? []) {
      if (!spec.metric || !spec.probe) problems.push(`${task.id}: evidence needs metric and probe`);
    }
  }
  return problems;
}

export function loadDeviceTasks(dir = DEVICE_TASK_DIR) {
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const tasks = files.map((name) => {
    const file = path.join(dir, name);
    const task = JSON.parse(fs.readFileSync(file, 'utf8'));
    task.file = file;
    return task;
  });
  const problems = validateDeviceTasks(tasks);
  if (problems.length > 0) {
    throw new Error(`device task suite invalid:\n${problems.join('\n')}`);
  }
  return tasks;
}

function filterTasks(tasks, filters) {
  if (!filters || filters.length === 0) return tasks;
  const matched = tasks.filter((task) => filters.some((filter) => task.id.includes(filter)));
  if (matched.length === 0) throw new Error(`no device tasks matched ${filters.join(',')}`);
  return matched;
}

function substitutePrompt(task, ctx) {
  const evidence = (task.evidence ?? [])
    .map(
      (spec) =>
        `- metric ${spec.metric}: observed must equal the trimmed stdout of \`${spec.probe}\``
    )
    .join('\n');
  return [
    task.prompt
      .replaceAll('{{ROOT}}', ctx.root)
      .replaceAll('{{TOKEN}}', ctx.token)
      .replaceAll('{{PORT}}', String(ctx.port)),
    '',
    `Board files for this task live under ${ctx.root}.`,
    'Do not reboot, power off, reflash, change passwords, or edit ssh, firewall, or network configuration.',
    'Record evidence with record_evidence and the task_id before you stop:',
    evidence,
    'The acceptance command is the authority. Prose is not a pass.',
  ].join('\n');
}

function acceptanceCommand(task, ctx) {
  const flags = [
    'node',
    shellQuote(ACCEPT_SCRIPT),
    '--task',
    shellQuote(task.file),
    '--workspace',
    shellQuote(ctx.workspace),
    '--root',
    shellQuote(ctx.root),
    '--state',
    shellQuote(ctx.stateDir),
    '--token',
    shellQuote(ctx.token),
    '--port',
    String(ctx.port),
    '--mode',
    ctx.mode,
  ];
  if (ctx.sim && ctx.mode === 'local') flags.push('--sim');
  if (ctx.simCamera) flags.push('--sim-camera');
  if (ctx.simRos) flags.push('--sim-ros');
  return flags.join(' ');
}

async function runCommands(commands, ctx) {
  if (!commands || commands.length === 0) return { code: 0, stdout: '', stderr: '' };
  return execOnTarget(commands.join('\n'), ctx);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Torn line: ignore.
    }
  }
  return rows;
}

function passEvidenceCount(workspace, taskId) {
  return readJsonl(path.join(workspace, '.moss', 'evidence.jsonl')).filter(
    (record) => record.result === 'pass' && record.taskId === taskId
  ).length;
}

function eventCount(workspace) {
  return readJsonl(path.join(workspace, '.moss', 'task-events.jsonl')).length;
}

function lastPhase(workspace) {
  const events = readJsonl(path.join(workspace, '.moss', 'task-events.jsonl'));
  return events.length > 0 ? events[events.length - 1].phase : undefined;
}

function sideEffectRollup(rows) {
  const rollup = {};
  for (const kind of ['readonly', 'mutating']) {
    const group = rows.filter((row) => row.sideEffect === kind);
    const passed = group.filter((row) => row.status === 'pass').length;
    const failed = group.filter((row) => row.status === 'fail').length;
    const skipped = group.filter((row) => row.status === 'skipped').length;
    const scored = passed + failed;
    rollup[kind] = {
      passed,
      failed,
      skipped,
      successRate: scored === 0 ? null : passed / scored,
    };
  }
  return rollup;
}

function costUsd(tokensIn, tokensOut) {
  const rate = Number(process.env.MOSS_BENCH_USD_PER_MILLION_TOKENS);
  if (!Number.isFinite(rate) || rate < 0) return null;
  if (tokensIn == null && tokensOut == null) return null;
  return (((tokensIn ?? 0) + (tokensOut ?? 0)) / 1e6) * rate;
}

function tokensFromText(text) {
  let tokensIn = null;
  let tokensOut = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed);
      const input = event.input_tokens ?? event.inputTokens;
      const output = event.output_tokens ?? event.outputTokens;
      if (event.type === 'llm_usage' || input != null || output != null) {
        if (event.type !== 'llm_usage' && input == null && output == null) continue;
        tokensIn = (tokensIn ?? 0) + Number(input ?? 0);
        tokensOut = (tokensOut ?? 0) + Number(output ?? 0);
      }
    } catch {
      // Non-JSON diagnostic line.
    }
  }
  return { tokensIn, tokensOut };
}

function gitSha() {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function loadQoderDeepseek() {
  const settingsPath = path.join(os.homedir(), '.qoder-cn', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const entry of Object.values(settings.providers ?? {})) {
      const models = Array.isArray(entry.models) ? entry.models.map((item) => item.model) : [];
      const names = [entry.model, ...models].filter(Boolean);
      if (names.some((name) => String(name).toLowerCase().startsWith('deepseek'))) {
        return {
          model: names.find((name) => String(name).toLowerCase().startsWith('deepseek')),
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey,
        };
      }
    }
  } catch {
    // No qoder settings.
  }
  return null;
}

export function resolveBenchProvider(options = {}) {
  const qoder = options.allowSettings === false ? null : loadQoderDeepseek();
  const apiKey =
    'apiKey' in options ? options.apiKey : process.env.MOSS_BENCH_API_KEY || qoder?.apiKey;
  const model = options.model || qoder?.model;
  const baseUrl = options.baseUrl || qoder?.baseUrl;
  if (!apiKey || !model || !baseUrl) {
    return {
      ok: false,
      missing: [
        !apiKey ? 'MOSS_BENCH_API_KEY (or a deepseek apiKey in ~/.qoder-cn/settings.json)' : null,
        !model ? '--model (or a deepseek model id in that settings file)' : null,
        !baseUrl ? '--base-url (or a deepseek baseUrl in that settings file)' : null,
      ].filter(Boolean),
    };
  }
  return { ok: true, apiKey, model, baseUrl };
}

async function loadEngine() {
  const engineUrl = pathToFileURL(
    path.join(repoRoot, 'dist', 'core', 'task', 'task-engine.js')
  ).href;
  const storeUrl = pathToFileURL(path.join(repoRoot, 'dist', 'core', 'task', 'task-store.js')).href;
  const artifactsUrl = pathToFileURL(
    path.join(repoRoot, 'dist', 'core', 'task-runtime', 'artifacts.js')
  ).href;
  const engine = await import(engineUrl);
  const store = await import(storeUrl);
  const artifacts = await import(artifactsUrl);
  return { runTask: engine.runTask, listTaskEvents: store.listTaskEvents, artifacts };
}

async function scriptedTurn(phase, task, ctx, engine) {
  const events = await engine.listTaskEvents(ctx.workspace);
  const taskId = events[0]?.taskId;
  if (phase === 'executing' || phase === 'repairing') {
    if (task.oracle.length > 0) await runCommands(task.oracle, ctx);
    for (const spec of task.evidence ?? []) {
      const probe = await execOnTarget(spec.probe, ctx);
      const observed = probe.stdout.trim();
      if (!taskId || probe.code !== 0 || observed === '') continue;
      await engine.artifacts.appendEvidenceRecord(ctx.workspace, {
        evidenceId: `ev_${task.id}_${spec.metric}_${randomBytes(3).toString('hex')}`,
        taskId,
        source: 'device-bench-dry-oracle',
        metric: spec.metric,
        expected: 'exists',
        observed,
        comparator: 'exists',
        result: 'pass',
        timestamp: Date.now(),
      });
    }
  }
  if (taskId) {
    await engine.artifacts.appendTaskRecord(ctx.workspace, {
      taskId,
      goal: task.title,
      acceptanceCriteria: [],
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return `scripted ${phase}`;
}

function spawnMoss(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args.argv, {
      cwd: args.cwd,
      env: args.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }, args.timeoutMs);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: redactSecrets(error.message), timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: redactSecrets(Buffer.concat(stdout).toString('utf8')),
        stderr: redactSecrets(Buffer.concat(stderr).toString('utf8')),
        timedOut,
      });
    });
  });
}

function writeProviderConfig(dir, provider) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        provider: 'openai-compatible',
        model: provider.model,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
}

async function runLiveMoss(task, ctx, provider, approval) {
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new Error('dist/cli.js missing — run npm run build');
  }
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-cfg-'));
  writeProviderConfig(configDir, provider);
  const prompt = substitutePrompt(task, ctx);
  const argv = [
    cli,
    '--model',
    provider.model,
    '--base-url',
    provider.baseUrl,
    ...(approval.fullFlag ? ['--full-access'] : []),
    'task',
    'run',
    prompt,
    '--accept',
    acceptanceCommand(task, ctx),
    '--max-turns',
    String(task.maxTurns ?? 12),
    '--max-repairs',
    String(task.maxRepairs ?? 2),
    '--device',
    process.env.MOSS_DEVICE_ID || 'device-bench',
  ];
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: 'C',
    LC_ALL: 'C',
    TMPDIR: os.tmpdir(),
    MOSS_CONFIG_DIR: configDir,
    MOSS_RUN_ID: `device-bench/${task.id}`,
    ...approval.env,
  };
  for (const key of [
    'MOSS_DEVICE_HOST',
    'MOSS_DEVICE_PORT',
    'MOSS_DEVICE_USER',
    'MOSS_DEVICE_PASSWORD',
    'MOSS_DEVICE_KEY',
    'MOSS_DEVICE_KEY_PASSPHRASE',
    'MOSS_DEVICE_KIND',
    'MOSS_DEVICE_ID',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  try {
    return await spawnMoss({ argv, cwd: ctx.workspace, env, timeoutMs: task.timeoutMs ?? 180_000 });
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

function makeContext(task, options, paths) {
  const sim = options.mode !== 'real';
  return {
    mode: options.mode === 'dry' ? 'local' : 'ssh',
    sim,
    simCamera: options.simCamera === true,
    simRos: options.simRos === true,
    root: paths.root,
    stateDir: paths.stateDir,
    workspace: paths.workspace,
    token: options.token ?? `mb${randomBytes(4).toString('hex')}`,
    port: options.port ?? 20_000 + Math.floor(Math.random() * 20_000),
    timeoutMs: 60_000,
  };
}

async function runOne(task, options, engine) {
  const workspace = path.join(options.resultsDir, 'workspaces', task.id);
  const root =
    options.mode === 'real'
      ? `/tmp/moss-bench/${options.runId}/${task.id}`
      : path.join(options.rootBase, task.id);
  const stateDir = path.join(root, '.state');
  fs.mkdirSync(workspace, { recursive: true });
  if (options.mode !== 'real') fs.mkdirSync(stateDir, { recursive: true });
  if (!task.file) {
    task.file = path.join(workspace, 'task.json');
    fs.writeFileSync(task.file, JSON.stringify(task));
  }
  const ctx = makeContext(task, options, { root, stateDir, workspace });
  if (ctx.simCamera && options.mode !== 'real') {
    fs.mkdirSync(path.join(stateDir, 'camera'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'camera', 'name'), 'sim-camera0\n');
  }
  const started = Date.now();
  let cleanup = 'ok';
  const finishCleanup = async () => {
    const result = await runCommands(task.cleanup, ctx);
    if (result.code !== 0) cleanup = 'failed';
    if (options.mode !== 'real') fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const prereq = await runCommands(task.prerequisites, ctx);
    if (prereq.code !== 0) {
      await finishCleanup();
      return {
        id: task.id,
        title: task.title,
        sideEffect: task.sideEffect,
        status: 'skipped',
        skipReason:
          redactSecrets(`${prereq.stderr}\n${prereq.stdout}`).trim().slice(-400) ||
          'prerequisite failed',
        phase: null,
        turns: 0,
        steps: 0,
        wallMs: Date.now() - started,
        tokensIn: null,
        tokensOut: null,
        tokensSource: options.mode === 'dry' ? 'dry-no-model' : 'not-emitted-by-task-cli',
        costUsd: null,
        evidence: [],
        taskId: null,
        cleanup,
        falseSuccess: false,
        verdictDetail: null,
      };
    }
    const setup = await runCommands(task.setup, ctx);
    if (setup.code !== 0) {
      await finishCleanup();
      return baseFail(
        task,
        ctx,
        started,
        cleanup,
        `setup failed: ${setup.stderr}`.slice(-400),
        options
      );
    }
    let outcome = 'fail';
    let turns = null;
    let phase = null;
    let taskId = null;
    let verdictDetail = null;
    let tokensIn = null;
    let tokensOut = null;
    const t0 = Date.now();
    if (options.mode === 'dry') {
      const result = await engine.runTask(
        {
          workspaceDir: ctx.workspace,
          maxRepairAttempts: 0,
          maxTurns: task.maxTurns ?? 8,
          runTurn: (_prompt, turnPhase) => scriptedTurn(turnPhase, task, ctx, engine),
        },
        substitutePrompt(task, ctx),
        { acceptanceCommand: acceptanceCommand(task, ctx), targetDeviceId: 'device-bench-dry' }
      );
      outcome = result.outcome;
      turns = result.turns;
      phase = result.snapshot.phase;
      taskId = result.snapshot.taskId;
      verdictDetail = result.verdictDetail ?? null;
    } else {
      const run = await runLiveMoss(task, ctx, options.provider, options.approval);
      outcome = run.code === 0 && !run.timedOut ? 'pass' : 'fail';
      const parsed = tokensFromText(`${run.stdout}\n${run.stderr}`);
      tokensIn = parsed.tokensIn;
      tokensOut = parsed.tokensOut;
      const turnsMatch = /turns:\s*(\d+)/.exec(run.stdout);
      turns = turnsMatch ? Number(turnsMatch[1]) : null;
      phase = lastPhase(ctx.workspace) ?? null;
      verdictDetail = redactSecrets(run.timedOut ? 'timed out' : run.stderr.slice(-500));
      const events = readJsonl(path.join(ctx.workspace, '.moss', 'task-events.jsonl'));
      taskId = events[0]?.taskId ?? null;
    }
    const wallMs = Date.now() - t0;
    await finishCleanup();
    const evidencePass = taskId ? passEvidenceCount(ctx.workspace, taskId) : 0;
    const status = outcome === 'pass' ? 'pass' : 'fail';
    return {
      id: task.id,
      title: task.title,
      sideEffect: task.sideEffect,
      status,
      skipReason: null,
      phase,
      turns,
      steps: eventCount(ctx.workspace),
      wallMs,
      tokensIn,
      tokensOut,
      tokensSource: options.mode === 'dry' ? 'dry-no-model' : 'not-emitted-by-task-cli',
      costUsd: costUsd(tokensIn, tokensOut),
      evidence: evidenceLinks(task.id),
      taskId,
      cleanup,
      falseSuccess: status === 'pass' && evidencePass === 0,
      verdictDetail: verdictDetail ? redactSecrets(verdictDetail).slice(-800) : null,
    };
  } catch (error) {
    await finishCleanup().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    return baseFail(task, ctx, started, cleanup, redactSecrets(message).slice(-400), options);
  }
}

function evidenceLinks(taskId) {
  return [
    `workspaces/${taskId}/.moss/evidence.jsonl`,
    `workspaces/${taskId}/.moss/acceptance.jsonl`,
    `workspaces/${taskId}/.moss/task-events.jsonl`,
  ];
}

function baseFail(task, ctx, started, cleanup, detail, options) {
  return {
    id: task.id,
    title: task.title,
    sideEffect: task.sideEffect,
    status: 'fail',
    skipReason: null,
    phase: lastPhase(ctx.workspace) ?? null,
    turns: null,
    steps: eventCount(ctx.workspace),
    wallMs: Date.now() - started,
    tokensIn: null,
    tokensOut: null,
    tokensSource: options.mode === 'dry' ? 'dry-no-model' : 'not-emitted-by-task-cli',
    costUsd: null,
    evidence: evidenceLinks(task.id),
    taskId: null,
    cleanup,
    falseSuccess: false,
    verdictDetail: detail,
  };
}

function buildSummary(rows, meta) {
  const passed = rows.filter((row) => row.status === 'pass').length;
  const failed = rows.filter((row) => row.status === 'fail').length;
  const skipped = rows.filter((row) => row.status === 'skipped').length;
  const scored = passed + failed;
  return {
    meta: {
      kind: 'device-bench',
      mode: meta.mode,
      gitSha: gitSha(),
      startedAt: meta.startedAt,
      finishedAt: new Date().toISOString(),
      host: meta.host,
      model: meta.model,
      passwordStored: false,
      approval: meta.approval,
    },
    successRate: scored === 0 ? null : passed / scored,
    scored,
    passed,
    failed,
    skipped,
    falseSuccess: rows.filter((row) => row.falseSuccess).length,
    bySideEffect: sideEffectRollup(rows),
    rows,
  };
}

const DEVICE_ENV_KEYS = [
  'MOSS_DEVICE_HOST',
  'MOSS_DEVICE_PORT',
  'MOSS_DEVICE_USER',
  'MOSS_DEVICE_PASSWORD',
  'MOSS_DEVICE_KEY',
  'MOSS_DEVICE_KIND',
  'MOSS_DEVICE_ID',
];

function snapshotEnv(keys) {
  const saved = {};
  for (const key of keys) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function runDeviceBench(options = {}) {
  const mode = options.mode ?? (process.env.MOSS_DEVICE_HOST ? 'real' : 'dry');
  if (mode !== 'dry' && mode !== 'sim' && mode !== 'real') {
    throw new Error(`unknown mode ${mode}`);
  }
  const tasks = filterTasks(options.tasks ?? loadDeviceTasks(options.taskDir), options.filters);
  const problems = validateDeviceTasks(tasks);
  if (problems.length > 0) throw new Error(`device task suite invalid:\n${problems.join('\n')}`);
  const provider = mode === 'dry' ? null : resolveBenchProvider(options);
  if (provider && provider.ok === false) {
    return {
      exitCode: 2,
      summary: null,
      summaryPath: null,
      missing: provider.missing,
    };
  }
  if (mode === 'real' && !process.env.MOSS_DEVICE_HOST?.trim()) {
    return {
      exitCode: 2,
      summary: null,
      summaryPath: null,
      missing: ['MOSS_DEVICE_HOST'],
    };
  }
  const stamp =
    options.label ?? `device-${mode}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}`;
  const resultsDir = options.resultsDir ?? path.join(repoRoot, 'bench', 'results', stamp);
  fs.mkdirSync(resultsDir, { recursive: true });
  const runId = options.runId ?? `run${Date.now().toString(36)}`;
  const ownsRoot = options.rootBase == null;
  const rootBase = options.rootBase ?? fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-'));
  const approvalMode = options.approval ?? process.env.MOSS_DEVICE_BENCH_APPROVAL ?? 'full';
  const approval = {
    mode: approvalMode,
    env: approvalEnv(approvalMode),
    fullFlag: approvalMode === 'full',
  };
  let sim = null;
  const savedEnv = snapshotEnv(DEVICE_ENV_KEYS);
  const log = options.onLine ?? (() => {});
  const startedAt = new Date().toISOString();
  try {
    if (mode === 'sim') {
      const password = newBenchPassword();
      const templateRoot = path.join(rootBase, '_sim');
      fs.mkdirSync(path.join(templateRoot, '.state'), { recursive: true });
      sim = await startSimSsh({
        password,
        ctx: {
          root: templateRoot,
          stateDir: path.join(templateRoot, '.state'),
          workspace: resultsDir,
          token: 'unset',
          port: 0,
          sim: true,
          simCamera: options.simCamera === true,
          simRos: options.simRos === true,
          timeoutMs: 60_000,
        },
      });
      process.env.MOSS_DEVICE_HOST = sim.host;
      process.env.MOSS_DEVICE_PORT = String(sim.port);
      process.env.MOSS_DEVICE_USER = sim.user;
      process.env.MOSS_DEVICE_PASSWORD = password;
      process.env.MOSS_DEVICE_KIND = 'linux';
      process.env.MOSS_DEVICE_ID = 'sim-rdk';
    } else if (mode === 'real') {
      const password = process.env.RDK_S600_PASSWORD || process.env.MOSS_DEVICE_PASSWORD;
      if (password) process.env.MOSS_DEVICE_PASSWORD = password;
      if (!process.env.MOSS_DEVICE_USER) process.env.MOSS_DEVICE_USER = 'root';
      if (!process.env.MOSS_DEVICE_PORT) process.env.MOSS_DEVICE_PORT = '22';
    }
    const engine = mode === 'dry' ? await loadEngine() : null;
    const rows = [];
    for (const task of tasks) {
      const row = await runOne(
        task,
        {
          ...options,
          mode,
          resultsDir,
          runId,
          rootBase,
          provider,
          approval,
        },
        engine
      );
      rows.push(row);
      log(
        `[device-bench] ${row.status.toUpperCase()} ${row.id} phase=${row.phase ?? '-'} turns=${row.turns ?? '-'} wall=${row.wallMs}ms`
      );
    }
    const host =
      mode === 'dry'
        ? 'local-sandbox'
        : mode === 'sim'
          ? `${sim.host}:${sim.port}`
          : `${process.env.MOSS_DEVICE_USER}@${process.env.MOSS_DEVICE_HOST}:${process.env.MOSS_DEVICE_PORT}`;
    const summary = buildSummary(rows, {
      mode,
      startedAt,
      host,
      model: provider?.model ?? null,
      approval: approvalMode,
    });
    const summaryText = redactSecrets(JSON.stringify(summary, null, 2));
    const summaryPath = path.join(resultsDir, 'summary.json');
    fs.writeFileSync(summaryPath, `${summaryText}\n`);
    const failed = rows.some((row) => row.status === 'fail');
    return { exitCode: failed ? 1 : 0, summary: JSON.parse(summaryText), summaryPath, missing: [] };
  } finally {
    if (sim) await sim.close();
    restoreEnv(savedEnv);
    if (ownsRoot) fs.rmSync(rootBase, { recursive: true, force: true });
  }
}

export function formatMissing(missing) {
  return [
    'device-bench: refusing to invent a score.',
    `Missing: ${missing.join('; ')}.`,
    'Re-run with --dry (no model, no device), or export the key and target and rerun.',
  ].join('\n');
}
