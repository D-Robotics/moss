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
import { spawn } from 'node:child_process';
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

function runCli(cli, prompt, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, '-p', prompt], {
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
      resolve({ exitCode: code ?? 1, timedOut, stdout, stderr });
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

function grade(caseDef, run) {
  const missing = caseDef.expectContains.filter((needle) => !run.stdout.includes(needle));
  const pass = run.exitCode === 0 && !run.timedOut && missing.length === 0;
  return {
    pass,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    missing,
    outputTail: run.stdout.slice(-1200),
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
  const assertable = evals.cases.filter((entry) => entry.expectContains.length > 0);
  if (assertable.length === 0) {
    console.error('skill-eval: no case has expect_contains; add mechanical assertions');
    process.exit(1);
  }
  const modes = opts.mode === 'both' ? ['with', 'without'] : [opts.mode];
  if (opts.dryRun) {
    console.log(`skill: ${skill.name} (${skillDir})`);
    console.log(`cases: ${String(evals.cases.length)} (${String(assertable.length)} assertable)`);
    for (const entry of evals.cases) {
      console.log(
        `  ${entry.id}: expect ${JSON.stringify(entry.expectContains)}${
          entry.expectContains.length === 0 ? ' (unasserted)' : ''
        }`
      );
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
        entry[mode] = grade(caseDef, run);
        if (entry[mode].pass) tally[mode] += 1;
      } finally {
        if (opts.workspace === undefined) fs.rmSync(workspace, { recursive: true, force: true });
      }
    }
    report.cases.push(entry);
  }
  report.summary = {
    cases: assertable.length,
    withPass: tally.with,
    withoutPass: tally.without,
    // A useful skill only improves on the no-skill baseline.
    delta: tally.with - tally.without,
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
    `summary: ${String(tally.with)}/${String(assertable.length)} with-skill, ${String(
      tally.without
    )}/${String(assertable.length)} without-skill, report ${reportPath}`
  );
  const failing = report.cases.filter((entry) => entry.with && !entry.with.pass);
  if (failing.length > 0) {
    for (const entry of failing) {
      console.error(`${entry.id}: missing ${JSON.stringify(entry.with.missing)}`);
    }
    process.exit(1);
  }
}

await main();
