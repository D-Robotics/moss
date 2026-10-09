/**
 * Device task benchmark.
 *
 * Dry mode drives Moss's task engine (`runTask`) with a scripted turn and the
 * command verdict. Live modes spawn `moss task run` against a sim ssh2 server
 * or a real board. A row passes only when that verdict passes and an
 * independent probe matches recorded evidence. Agent prose is not a score.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { approvalEnv, inheritPolicySnapshot } from './device-bench-approval.mjs';
import {
  commandText,
  findForbidden,
  quoteForShell,
  redactSecrets,
} from './device-bench-safety.mjs';
import {
  execOnTarget,
  newBenchPassword,
  seedBoardFixture,
  startSimSsh,
} from './device-bench-target.mjs';

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
    if (task.tier !== undefined && task.tier !== 'core' && task.tier !== 'optional') {
      problems.push(`${task.id}: tier must be core or optional`);
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
  const q = (value) => quoteForShell(value);
  const flags = [
    'node',
    q(ACCEPT_SCRIPT),
    '--task',
    q(task.file),
    '--workspace',
    q(ctx.workspace),
    '--root',
    q(ctx.root),
    '--state',
    q(ctx.stateDir),
    '--token',
    q(ctx.token),
    '--port',
    String(ctx.port),
    '--mode',
    ctx.mode,
  ];
  if (ctx.sim && ctx.mode === 'local') flags.push('--sim');
  if (ctx.simCamera) flags.push('--sim-camera');
  if (ctx.simRos) flags.push('--sim-ros');
  if (ctx.expectSha256) {
    flags.push('--expect-sha256', q(ctx.expectSha256));
  }
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

function countStatus(rows, status) {
  return rows.filter((row) => row.status === status).length;
}

function rate(passed, scored) {
  return scored === 0 ? null : passed / scored;
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Population standard deviation. One sample has spread 0. */
function spread(values) {
  if (values.length === 0) return null;
  if (values.length === 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function sideEffectRollup(rows) {
  const rollup = {};
  for (const kind of ['readonly', 'mutating']) {
    const group = rows.filter((row) => row.sideEffect === kind);
    const passed = countStatus(group, 'pass');
    const failed = countStatus(group, 'fail');
    const falseSuccess = countStatus(group, 'falseSuccess');
    const skipped = countStatus(group, 'skipped');
    const scored = passed + failed + falseSuccess;
    rollup[kind] = {
      passed,
      failed,
      falseSuccess,
      skipped,
      successRate: rate(passed, scored),
    };
  }
  return rollup;
}

function tierRollup(rows, tier) {
  const group = rows.filter((row) => (row.tier ?? 'optional') === tier);
  const passed = countStatus(group, 'pass');
  const failed = countStatus(group, 'fail');
  const falseSuccess = countStatus(group, 'falseSuccess');
  const skipped = countStatus(group, 'skipped');
  const total = group.length;
  const scored = passed + failed + falseSuccess;
  return {
    ids: group.map((row) => row.id).sort(),
    total,
    passed,
    failed,
    falseSuccess,
    skipped,
    scored,
    // Core keeps a fixed denominator (skips count as misses). Optional skips
    // stay out of the rate so a missing camera does not move the core number.
    successRate: tier === 'core' ? rate(passed, total) : rate(passed, scored),
  };
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

async function loadCliConfigModule() {
  const url = pathToFileURL(path.join(repoRoot, 'dist', 'cli', 'config.js')).href;
  return import(url);
}

/**
 * Same resolution as `moss` itself: config file under MOSS_CONFIG_DIR /
 * MOSS_CONFIG_FILE / ~/.config/moss/config.json, plus --model / --base-url.
 * MOSS_API_KEY, MOSS_MODEL, MOSS_BASE_URL, and provider API-key env vars are
 * ignored, matching resolveCliConfig.
 */
export async function resolveBenchProvider(options = {}) {
  const { resolveCliConfig } = await loadCliConfigModule();
  const env = { ...process.env, ...(options.env ?? {}) };
  if (options.isolateConfig) {
    env.MOSS_NO_BUNDLED_DEFAULT = '1';
    env.MOSS_CONFIG_DIR =
      options.configDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-cfg-'));
    delete env.MOSS_CONFIG_FILE;
    delete env.MOSS_CONFIG_PATH;
  }
  const resolved = resolveCliConfig(env, undefined, {
    ...(options.model ? { model: options.model } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  const apiKey = resolved.apiKey?.trim() ?? '';
  const model = resolved.model?.trim() ?? '';
  const baseUrl = resolved.baseUrl?.trim() ?? '';
  if (!apiKey || !model || !baseUrl) {
    const configPath = resolved.configPath || 'the moss config file';
    return {
      ok: false,
      missing: [
        !apiKey
          ? `apiKey in ${configPath} (MOSS_CONFIG_DIR, MOSS_CONFIG_FILE, or ~/.config/moss/config.json). MOSS_API_KEY, OPENAI_API_KEY, and DEEPSEEK_API_KEY are ignored`
          : null,
        !model ? '--model or model in the moss config file' : null,
        !baseUrl ? '--base-url or baseUrl in the moss config file' : null,
      ].filter(Boolean),
      configPath,
    };
  }
  return {
    ok: true,
    model,
    baseUrl,
    configPath: resolved.configPath,
    apiKeySource: resolved.apiKeySource,
  };
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

async function runLiveMoss(task, ctx, provider, approval) {
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new Error('dist/cli.js missing — run npm run build');
  }
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
    MOSS_RUN_ID: `device-bench/${task.id}`,
    ...approval.env,
  };
  for (const key of [
    'USERPROFILE',
    'APPDATA',
    'XDG_CONFIG_HOME',
    'MOSS_CONFIG_DIR',
    'MOSS_CONFIG_FILE',
    'MOSS_CONFIG_PATH',
    'MOSS_NO_BUNDLED_DEFAULT',
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
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
  return spawnMoss({ argv, cwd: ctx.workspace, env, timeoutMs: task.timeoutMs ?? 180_000 });
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
  if (options.mode !== 'real') {
    fs.mkdirSync(stateDir, { recursive: true });
    seedBoardFixture(stateDir);
  }
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
        tier: task.tier ?? 'optional',
        falseSuccess: false,
        verdictDetail: null,
      };
    }
    if (task.stateSnapshot) ctx.rollbackBody = randomBytes(16).toString('hex');
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
    if (task.stateSnapshot) {
      const snap = await execOnTarget(`cat ${task.stateSnapshot}`, ctx);
      if (snap.code !== 0) {
        await finishCleanup();
        return baseFail(task, ctx, started, cleanup, 'state snapshot failed', options);
      }
      ctx.expectSha256 = createHash('sha256')
        .update(Buffer.from(snap.stdout, 'utf8'))
        .digest('hex');
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
    const evidenceNeeded = (task.evidence ?? []).length;
    const evidenceOk = evidenceNeeded > 0 && evidencePass >= evidenceNeeded;
    let status = 'fail';
    if (outcome === 'pass' && evidenceOk) status = 'pass';
    else if (outcome === 'pass') status = 'falseSuccess';
    return {
      id: task.id,
      title: task.title,
      sideEffect: task.sideEffect,
      tier: task.tier ?? 'optional',
      status,
      skipReason: null,
      phase,
      turns,
      steps: eventCount(ctx.workspace),
      wallMs,
      tokensIn,
      tokensOut,
      tokensSource:
        tokensIn == null
          ? options.mode === 'dry'
            ? 'dry-no-model'
            : 'not-emitted-by-task-cli'
          : 'llm_usage',
      costUsd: costUsd(tokensIn, tokensOut),
      evidence: evidenceLinks(task.id),
      taskId,
      cleanup,
      falseSuccess: status === 'falseSuccess',
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
    tier: task.tier ?? 'optional',
    falseSuccess: false,
    verdictDetail: detail,
  };
}

function summarizeRows(rows) {
  const passed = countStatus(rows, 'pass');
  const failed = countStatus(rows, 'fail');
  const falseSuccess = countStatus(rows, 'falseSuccess');
  const skipped = countStatus(rows, 'skipped');
  const scored = passed + failed + falseSuccess;
  return {
    successRate: rate(passed, scored),
    scored,
    passed,
    failed,
    skipped,
    falseSuccess,
    core: tierRollup(rows, 'core'),
    optional: tierRollup(rows, 'optional'),
    bySideEffect: sideEffectRollup(rows),
    rows,
  };
}

function buildSummary(runs, meta) {
  const latest = summarizeRows(runs[runs.length - 1]);
  const successRates = runs
    .map((rows) => summarizeRows(rows).successRate)
    .filter((value) => value != null);
  const coreRates = runs
    .map((rows) => summarizeRows(rows).core.successRate)
    .filter((value) => value != null);
  return {
    schemaVersion: 1,
    meta: {
      kind: 'device-bench',
      mode: meta.mode,
      gitSha: gitSha(),
      startedAt: meta.startedAt,
      finishedAt: new Date().toISOString(),
      host: meta.host,
      board: meta.board,
      model: meta.model,
      passwordStored: false,
      approval: meta.approval,
      ...(meta.devicePolicy ? { devicePolicy: meta.devicePolicy } : {}),
    },
    ...latest,
    repeat: {
      n: runs.length,
      successRates,
      mean: mean(successRates),
      spread: spread(successRates),
      coreSuccessRates: coreRates,
      coreMean: mean(coreRates),
      coreSpread: spread(coreRates),
    },
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

async function collectBoard(mode) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-device-bench-board-'));
  const ctx = {
    mode: mode === 'dry' ? 'local' : 'ssh',
    sim: mode !== 'real',
    root: stateDir,
    stateDir,
    workspace: stateDir,
    token: 'board',
    port: 0,
    timeoutMs: 15_000,
  };
  const line = async (script) => {
    const result = await execOnTarget(script, ctx);
    return result.code === 0 ? result.stdout.trim() : null;
  };
  try {
    return {
      target: mode,
      model: await line(
        "if [ -r /proc/device-tree/model ]; then tr -d '\\000' < /proc/device-tree/model; else uname -m; fi"
      ),
      os: await line(
        'if [ -r /etc/os-release ]; then . /etc/os-release; printf \'%s\' "$PRETTY_NAME"; else uname -s; fi'
      ),
      kernel: await line('uname -r'),
    };
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
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
  const provider = mode === 'dry' ? null : await resolveBenchProvider(options);
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
    // inherit and full both pass --full-access. inherit does not set
    // MOSS_DEVICE_TRUST, and the summary records the device-risk snapshot.
    fullFlag: approvalMode === 'full' || approvalMode === 'inherit',
  };
  let sim = null;
  const savedEnv = snapshotEnv(DEVICE_ENV_KEYS);
  const log = options.onLine ?? (() => {});
  const startedAt = new Date().toISOString();
  const repeats = Number.isInteger(options.repeat) ? options.repeat : 1;
  if (repeats < 1) throw new Error('--repeat must be a positive integer');
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
    const board = await collectBoard(mode);
    const runs = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      const repeatDir = repeats === 1 ? resultsDir : path.join(resultsDir, `repeat-${repeat}`);
      fs.mkdirSync(repeatDir, { recursive: true });
      const rows = [];
      for (const task of tasks) {
        const row = await runOne(
          task,
          {
            ...options,
            mode,
            resultsDir: repeatDir,
            runId: repeats === 1 ? runId : `${runId}-r${repeat}`,
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
      runs.push(rows);
    }
    const host =
      mode === 'dry'
        ? 'local-sandbox'
        : mode === 'sim'
          ? `${sim.host}:${sim.port}`
          : `${process.env.MOSS_DEVICE_USER}@${process.env.MOSS_DEVICE_HOST}:${process.env.MOSS_DEVICE_PORT}`;
    const devicePolicy = approvalMode === 'inherit' ? await inheritPolicySnapshot() : null;
    const summary = buildSummary(runs, {
      mode,
      startedAt,
      host,
      board,
      model: provider?.model ?? null,
      approval: approvalMode,
      ...(devicePolicy ? { devicePolicy } : {}),
    });
    const summaryText = redactSecrets(JSON.stringify(summary, null, 2));
    const summaryPath = path.join(resultsDir, 'summary.json');
    fs.writeFileSync(summaryPath, `${summaryText}\n`);
    const failed = runs.some((rows) =>
      rows.some((row) => row.status === 'fail' || row.status === 'falseSuccess')
    );
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
