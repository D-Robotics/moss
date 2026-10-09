#!/usr/bin/env node
/**
 * Acceptance command for one device-bench task.
 *
 * Moss runs this as the command verdict (`--accept` / runTask acceptanceCommand).
 * Exit 0 only when every device check exits 0 and every evidence probe matches
 * a recorded evidence row. The password is never read from argv.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from './device-bench-safety.mjs';
import { execOnTarget } from './device-bench-target.mjs';

function arg(name, argv) {
  const index = argv.indexOf(name);
  if (index === -1 || argv[index + 1] === undefined) {
    throw new Error(`missing ${name}`);
  }
  return argv[index + 1];
}

function evidenceMatches(workspace, metric, observed) {
  const file = path.join(workspace, '.moss', 'evidence.jsonl');
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.metric === metric && String(record.observed ?? '').trim() === observed) {
        return true;
      }
    } catch {
      // Ignore a torn last line; a missing match still fails the check.
    }
  }
  return false;
}

export async function evaluateTaskAcceptance(options) {
  const task = JSON.parse(fs.readFileSync(options.taskFile, 'utf8'));
  const ctx = {
    mode: options.mode,
    sim: options.mode !== 'ssh' ? options.sim !== false : options.sim === true,
    simCamera: options.simCamera === true,
    simRos: options.simRos === true,
    root: options.root,
    stateDir: options.stateDir,
    workspace: options.workspace,
    token: options.token,
    port: Number(options.port),
    timeoutMs: options.timeoutMs ?? 30_000,
  };
  // SSH targets are not rewritten locally. Dry runs are the local sandbox.
  if (options.mode === 'local') ctx.sim = options.sim !== false;
  const problems = [];
  for (const spec of task.evidence ?? []) {
    const probe = await execOnTarget(spec.probe, ctx);
    const observed = probe.stdout.trim();
    if (probe.code !== 0 || observed === '') {
      problems.push(
        `probe ${spec.metric} failed (exit ${probe.code}): ${redactSecrets(probe.stderr).slice(-400)}`
      );
      continue;
    }
    if (!evidenceMatches(options.workspace, spec.metric, observed)) {
      problems.push(`no evidence record for ${spec.metric} observed ${JSON.stringify(observed)}`);
    }
  }
  if (options.expectSha256) {
    const read = await execOnTarget('cat "$MOSS_BENCH_ROOT/state.txt"', ctx);
    const digest = createHash('sha256').update(Buffer.from(read.stdout, 'utf8')).digest('hex');
    if (read.code !== 0 || digest !== options.expectSha256) {
      problems.push('state sha256 does not match the runner snapshot taken before the agent ran');
    }
  }
  if (Array.isArray(task.acceptance) && task.acceptance.length > 0) {
    const result = await execOnTarget(task.acceptance.join('\n'), ctx);
    if (result.code !== 0) {
      problems.push(
        `acceptance exit ${result.code}: ${redactSecrets(`${result.stdout}\n${result.stderr}`).slice(-800)}`
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

async function main() {
  try {
    const argv = process.argv.slice(2);
    const result = await evaluateTaskAcceptance({
      taskFile: arg('--task', argv),
      workspace: arg('--workspace', argv),
      root: arg('--root', argv),
      stateDir: arg('--state', argv),
      token: arg('--token', argv),
      port: arg('--port', argv),
      mode: arg('--mode', argv),
      sim: argv.includes('--sim'),
      simCamera: argv.includes('--sim-camera'),
      simRos: argv.includes('--sim-ros'),
      ...(argv.includes('--expect-sha256') ? { expectSha256: arg('--expect-sha256', argv) } : {}),
    });
    if (!result.ok) {
      process.stderr.write(`${result.problems.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactSecrets(message)}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main();
}
