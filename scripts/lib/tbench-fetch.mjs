#!/usr/bin/env node
/**
 * Locks a deterministic 40-task Terminal-Bench subset from the shallow clone
 * at bench/.cache/tb-repo (original-tasks). Tasks are sorted by name and
 * every Nth is taken, so the lock is reproducible from a known commit.
 *
 * Usage: node scripts/lib/tbench-fetch.mjs [--size 40]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function parseArgs(argv) {
  const out = { size: 40 };
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === '--size') out.size = Number(argv[i + 1]);
  return out;
}

function extractInstruction(yamlText) {
  const lines = yamlText.split('\n');
  const start = lines.findIndex((l) => /^instruction:\s*\|-?\s*$/.test(l));
  if (start === -1) return '';
  const block = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z_]+:/.test(line) || line.startsWith('#')) break;
    block.push(line.replace(/^ {2}/, ''));
  }
  return block.join('\n').trim();
}

function extractField(yamlText, key) {
  const m = yamlText.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return m?.[1]?.trim().replace(/^["']|["']$/g, '');
}

function main() {
  const { size } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const tasksRoot = path.join(repoRoot, 'bench', '.cache', 'tb-repo', 'original-tasks');
  const names = fs
    .readdirSync(tasksRoot)
    .filter((n) => fs.existsSync(path.join(tasksRoot, n, 'task.yaml')))
    .sort();
  if (names.length < 50) throw new Error(`unexpectedly few TB tasks: ${names.length}`);
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.join(repoRoot, 'bench', '.cache', 'tb-repo'),
    encoding: 'utf8',
  }).stdout.trim();

  const stride = Math.floor(names.length / size);
  const subset = [];
  for (let i = 0; i < size; i += 1) {
    const name = names[i * stride];
    const yamlText = fs.readFileSync(path.join(tasksRoot, name, 'task.yaml'), 'utf8');
    subset.push({
      task: name,
      instruction: extractInstruction(yamlText),
      difficulty: extractField(yamlText, 'difficulty'),
      maxAgentTimeoutSec: Number(extractField(yamlText, 'max_agent_timeout_sec') ?? 900),
      maxTestTimeoutSec: Number(extractField(yamlText, 'max_test_timeout_sec') ?? 180),
    });
  }

  const payload = {
    source: 'github.com/laude-institute/terminal-bench (original-tasks)',
    sourceCommit: sha,
    sampling: `sorted by task name, every ${stride}-th of ${names.length}`,
    size: subset.length,
    tasks: subset,
  };
  const outPath = path.join(repoRoot, 'bench', 'boards', 'tbench-instances.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  const empty = subset.filter((t) => !t.instruction).length;
  if (empty > 0) throw new Error(`${empty} tasks have no instruction extracted`);
  console.log(`wrote ${subset.length} TB tasks (commit ${sha.slice(0, 10)}) to ${outPath}`);
}

main();
