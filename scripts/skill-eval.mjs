#!/usr/bin/env node
/**
 * Run a skill's evals/evals.json with and without the skill loaded.
 *
 * The point is the comparison: a case that passes with the skill but also fails
 * without it proves the skill carries information the model does not already
 * have. A case that passes both ways means the prompt is not testing the skill.
 *
 *   node scripts/skill-eval.mjs <skill-dir|name> [--mode both|with|without]
 *        [--workspace <dir>] [--json <report.json>] [--timeout-ms 180000] [--dry-run]
 *
 * Each run is the real CLI (`dist/cli.js -p`) in a throwaway workspace, so it
 * costs model calls. `--dry-run` validates the eval file and prints the cases
 * without calling a model.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const distModule = (...parts) => pathToFileURL(path.join(repoRoot, 'dist', ...parts)).href;

function parseArgs(argv) {
  const opts = {
    target: undefined,
    mode: 'both',
    workspace: undefined,
    json: undefined,
    timeoutMs: 180_000,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') opts.mode = argv[++i];
    else if (arg === '--workspace') opts.workspace = argv[++i];
    else if (arg === '--json') opts.json = argv[++i];
    else if (arg === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (!arg.startsWith('--') && !opts.target) opts.target = arg;
    else {
      console.error(`skill-eval: unknown argument ${arg}`);
      process.exit(2);
    }
  }
  if (!opts.target) {
    console.error('skill-eval: a skill directory or name is required');
    process.exit(2);
  }
  if (!['both', 'with', 'without'].includes(opts.mode)) {
    console.error('skill-eval: --mode must be both, with, or without');
    process.exit(2);
  }
  return opts;
}

function resolveSkillDir(target) {
  const absolute = path.resolve(target);
  if (fs.existsSync(path.join(absolute, 'SKILL.md'))) return absolute;
  const roots = [
    path.join(process.cwd(), '.moss', 'skills'),
    path.join(process.cwd(), '.agents', 'skills'),
    path.join(process.cwd(), '.claude', 'skills'),
    path.join(os.homedir(), '.config', 'moss', 'skills'),
    path.join(os.homedir(), '.moss', 'skills'),
  ];
  for (const root of roots) {
    const candidate = path.join(root, target);
    if (fs.existsSync(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  console.error(`skill-eval: no SKILL.md found for ${target}`);
  process.exit(2);
}

/**
 * `stream-json` gives us the tool_use blocks; the `result` event carries the
 * final answer. Both are needed because "the tool was called" and "the answer
 * says X" are different claims.
 */
function parseStream(stdout) {
  const events = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      events.push(JSON.parse(text));
    } catch {
      // A stray non-JSON line (license notice, crash text) is not an event.
    }
  }
  const toolNames = [];
  let answer = '';
  for (const event of events) {
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use' && typeof block.name === 'string')
          toolNames.push(block.name);
      }
    }
    if (event.type === 'result' && typeof event.result === 'string') answer = event.result;
  }
  return { events, answer, toolNames };
}

function runCli(cli, prompt, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, '-p', prompt, '--output-format', 'stream-json'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        MOSS_NO_RDK_DOCS: '1',
        MOSS_NO_TUI: '1',
        MOSS_PROMPT_LAYERS: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const parsed = parseStream(stdout);
      resolve({ exitCode: code ?? 1, timedOut, stdout, stderr, ...parsed });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, timedOut, stdout, stderr: `${stderr}${err.message}` });
    });
  });
}

function writeSetupFiles(workspace, setup) {
  for (const [relative, content] of Object.entries(setup)) {
    const target = path.resolve(workspace, relative);
    if (!target.startsWith(path.resolve(workspace) + path.sep)) {
      throw new Error(`setup path escapes the eval workspace: ${relative}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function runPostCondition(command, workspace, timeoutMs) {
  const result = spawnSync(command, {
    cwd: workspace,
    shell: true,
    timeout: timeoutMs,
    encoding: 'utf8',
  });
  return {
    command,
    exitCode: result.status ?? (result.error ? 1 : 1),
    timedOut: result.error?.code === 'ETIMEDOUT',
    outputTail: `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-800),
  };
}

/**
 * Grade one run with every grader the case declares. `pass` is the conjunction:
 * a case that calls the right tool but answers wrongly still fails.
 */
function grade(caseDef, run, workspace) {
  const graders = [];
  const answer = run.answer || '';
  if (caseDef.expectContains.length > 0) {
    const missing = caseDef.expectContains.filter((needle) => !answer.includes(needle));
    graders.push({
      type: 'contains',
      pass: missing.length === 0,
      missing,
    });
  }
  if (caseDef.expectRegex.length > 0) {
    const failures = [];
    for (const pattern of caseDef.expectRegex) {
      if (!new RegExp(pattern).test(answer)) failures.push(pattern);
    }
    graders.push({ type: 'regex', pass: failures.length === 0, missing: failures });
  }
  if (caseDef.expectTools.length > 0) {
    const missing = caseDef.expectTools.filter((name) => !run.toolNames.includes(name));
    graders.push({ type: 'tool_called', pass: missing.length === 0, missing });
  }
  if (caseDef.postCondition) {
    const result = runPostCondition(
      caseDef.postCondition,
      workspace,
      caseDef.postConditionTimeoutMs ?? 60_000
    );
    graders.push({ type: 'post_condition', pass: result.exitCode === 0, ...result });
  }
  const pass = run.exitCode === 0 && !run.timedOut && graders.every((grader) => grader.pass);
  return {
    pass,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    graders,
    calledTools: run.toolNames,
    answerTail: answer.slice(-1200),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const skillDir = resolveSkillDir(opts.target);
  const registry = await import(distModule('core', 'skills', 'skill-registry.js'));
  const evalsMod = await import(distModule('core', 'skills', 'skill-evals.js'));
  const parsed = registry.readSkillManifest(
    path.join(skillDir, 'SKILL.md'),
    path.basename(skillDir),
    'workspace'
  );
  if (!parsed.manifest) {
    console.error(
      `skill-eval: ${skillDir} is not a loadable skill (${parsed.skip?.reason ?? 'invalid'})`
    );
    process.exit(1);
  }
  const skill = parsed.manifest;
  const evals = evalsMod.loadSkillEvals(skillDir);
  for (const issue of evals.issues) console.error(`[evals] ${issue.message}`);
  if (evals.cases.length === 0) {
    console.error(`skill-eval: ${skill.name} has no evals/evals.json cases`);
    process.exit(1);
  }
  const assertable = evals.cases.filter(
    (entry) =>
      entry.expectContains.length > 0 ||
      entry.expectRegex.length > 0 ||
      entry.expectTools.length > 0 ||
      entry.postCondition !== undefined
  );
  if (assertable.length === 0) {
    console.error(
      'skill-eval: no case has expect_contains/expect_regex/expect_tools/post_condition; add mechanical assertions'
    );
    process.exit(1);
  }
  const modes = opts.mode === 'both' ? ['with', 'without'] : [opts.mode];
  if (opts.dryRun) {
    console.log(`skill: ${skill.name} (${skillDir})`);
    console.log(`cases: ${String(evals.cases.length)} (${String(assertable.length)} assertable)`);
    for (const entry of evals.cases) {
      const parts = [
        entry.expectContains.length > 0 ? `contains ${JSON.stringify(entry.expectContains)}` : '',
        entry.expectRegex.length > 0 ? `regex ${JSON.stringify(entry.expectRegex)}` : '',
        entry.expectTools.length > 0 ? `tools ${JSON.stringify(entry.expectTools)}` : '',
        entry.postCondition !== undefined
          ? `post_condition ${JSON.stringify(entry.postCondition)}`
          : '',
      ].filter(Boolean);
      console.log(`  ${entry.id}: ${parts.length > 0 ? parts.join(' + ') : '(unasserted)'}`);
    }
    console.log(`modes: ${modes.join(', ')} (not run: --dry-run)`);
    return;
  }
  const cli = path.join(repoRoot, 'dist', 'cli.js');
  const report = {
    skill: skill.name,
    directory: skillDir,
    modes,
    cases: [],
    summary: {},
  };
  const tally = { with: 0, without: 0 };
  for (const caseDef of assertable) {
    const entry = {
      id: caseDef.id,
      prompt: caseDef.prompt,
      expectContains: caseDef.expectContains,
      expectRegex: caseDef.expectRegex,
      expectTools: caseDef.expectTools,
      ...(caseDef.postCondition ? { postCondition: caseDef.postCondition } : {}),
    };
    for (const mode of modes) {
      const workspace =
        opts.workspace !== undefined
          ? fs.mkdtempSync(path.join(path.resolve(opts.workspace), `${caseDef.id}-${mode}-`))
          : fs.mkdtempSync(path.join(os.tmpdir(), `moss-skill-eval-${caseDef.id}-${mode}-`));
      try {
        writeSetupFiles(workspace, caseDef.setup);
        if (mode === 'with') {
          const destination = path.join(workspace, '.moss', 'skills', skill.name);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.cpSync(skillDir, destination, { recursive: true });
        }
        const run = await runCli(cli, caseDef.prompt, workspace, opts.timeoutMs);
        entry[mode] = grade(caseDef, run, workspace);
        if (entry[mode].pass) tally[mode] += 1;
      } finally {
        if (opts.workspace === undefined) fs.rmSync(workspace, { recursive: true, force: true });
      }
    }
    report.cases.push(entry);
  }
  const ranWith = modes.includes('with');
  const ranWithout = modes.includes('without');
  report.summary = {
    cases: assertable.length,
    withPass: ranWith ? tally.with : null,
    withoutPass: ranWithout ? tally.without : null,
    // A useful skill only improves on the no-skill baseline; delta needs both.
    delta: ranWith && ranWithout ? tally.with - tally.without : null,
  };
  const reportPath =
    opts.json ?? path.join(repoRoot, 'bench', 'results', `skill-eval-${skill.name}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  for (const entry of report.cases) {
    const withMode = entry.with ? `with:${entry.with.pass ? 'PASS' : 'FAIL'}` : '';
    const withoutMode = entry.without ? `without:${entry.without.pass ? 'PASS' : 'FAIL'}` : '';
    console.log(`${entry.id}: ${[withMode, withoutMode].filter(Boolean).join(' ')}`);
  }
  console.log(
    [
      'summary:',
      ranWith
        ? `${String(tally.with)}/${String(assertable.length)} with-skill`
        : 'with-skill not run',
      ranWithout
        ? `${String(tally.without)}/${String(assertable.length)} without-skill`
        : 'without-skill not run',
      ranWith && ranWithout ? `delta ${String(tally.with - tally.without)}` : 'delta n/a',
      `report ${reportPath}`,
    ].join(' ')
  );
  const failing = report.cases.filter((entry) => entry.with && !entry.with.pass);
  if (failing.length > 0) {
    for (const entry of failing) {
      const failed = entry.with.graders.filter((grader) => !grader.pass);
      console.error(
        `${entry.id}: ${failed
          .map((grader) => `${grader.type} missing ${JSON.stringify(grader.missing ?? [])}`)
          .join('; ')}`
      );
    }
    process.exit(1);
  }
}

await main();
