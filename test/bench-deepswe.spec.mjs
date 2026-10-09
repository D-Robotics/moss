#!/usr/bin/env node
/**
 * DeepSWE harness wiring that does not need Pier or Docker.
 *
 * The published protocol's temperature, top_p, and turn cap are host env.
 * Pier executes the agent script inside the task container, so those values
 * have to be written into the script. A shell ${VAR:-default} would keep the
 * container default and silently disagree with the host log line.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../scripts/bench-deepswe.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

delete process.env.MOSS_DEEPSWE_TASKS;
delete process.env.MOSS_DEEPSWE_MEMORY_MB;
delete process.env.MOSS_PIER;

const defaults = parseArgs([]);
assert.equal(defaults.samples, 1);
assert.equal(defaults.nTasks, null);
assert.equal(defaults.concurrency, 1);
assert.equal(defaults.memoryMb, 8192);
assert.equal(defaults.tasks, '');
assert.equal(defaults.pier, 'pier');

const custom = parseArgs([
  '--tasks',
  '/tmp/deep-swe/tasks',
  '--samples',
  '8',
  '--n-tasks',
  '2',
  '--concurrency',
  '3',
  '--memory-mb',
  '4096',
  '--job-name',
  'pilot',
  '--pier',
  '/opt/pier',
]);
assert.equal(custom.tasks, '/tmp/deep-swe/tasks');
assert.equal(custom.samples, 8);
assert.equal(custom.nTasks, 2);
assert.equal(custom.concurrency, 3);
assert.equal(custom.memoryMb, 4096);
assert.equal(custom.jobName, 'pilot');
assert.equal(custom.pier, '/opt/pier');

assert.throws(() => parseArgs(['--samples', '0']), /--samples/);
assert.throws(() => parseArgs(['--memory-mb', 'nope']), /--memory-mb/);
assert.throws(() => parseArgs(['--n-tasks', '1.5']), /--n-tasks/);
assert.throws(() => parseArgs(['--pier', '  ']), /--pier/);
assert.throws(() => parseArgs(['--nope']), /unknown flag/);

function pythonInvocation() {
  const attempts =
    process.platform === 'win32'
      ? [
          ['py', ['-3']],
          ['python', []],
          ['python3', []],
        ]
      : [
          ['python3', []],
          ['python', []],
        ];
  for (const [bin, prefix] of attempts) {
    const probe = spawnSync(bin, [...prefix, '-c', 'print("ok")'], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.includes('ok')) return { bin, prefix };
  }
  return null;
}

const python = pythonInvocation();
assert.ok(python, 'python is required to check the DeepSWE container command');

const probe = `
import json, sys
sys.path.insert(0, sys.argv[1])
from runtime_command import deepswe_agent_command, provider_config_json

def env_of(mapping):
    return lambda name: mapping.get(name)

script, runtime = deepswe_agent_command(
    "deepseek-flash",
    "https://api.example.com/v1",
    env_of({
        "MOSS_TEMPERATURE": "1",
        "MOSS_TOP_P": "0.95",
        "MOSS_DEEPSWE_MAX_TURNS": "500",
    }),
)
assert "--max-turns 500" in script, script
assert "\${" not in script, script
assert "export MOSS_TEMPERATURE=1\\n" in script
assert "export MOSS_TOP_P=0.95\\n" in script
assert runtime["MOSS_DEEPSWE_MAX_TURNS"] == "500"
assert runtime["MOSS_TEMPERATURE"] == "1"
assert runtime["MOSS_TOP_P"] == "0.95"

fallback, _runtime = deepswe_agent_command("m", "https://x", env_of({}))
assert "--max-turns 80" in fallback, fallback
assert "export MOSS_TEMPERATURE=1\\n" in fallback
assert "export MOSS_TOP_P=0.95\\n" in fallback

blank, _blank_runtime = deepswe_agent_command(
    "m",
    "https://x",
    env_of({"MOSS_TEMPERATURE": "  ", "MOSS_TOP_P": "", "MOSS_DEEPSWE_MAX_TURNS": ""}),
)
assert "export MOSS_TEMPERATURE=1\\n" in blank
assert "--max-turns 80" in blank

hostile, _hostile_runtime = deepswe_agent_command(
    "m; id",
    "https://x",
    env_of({"MOSS_TEMPERATURE": "1; rm -rf /"}),
)
assert "export MOSS_TEMPERATURE='1; rm -rf /'" in hostile
assert "--model 'm; id'" in hostile

raw = provider_config_json("m", "https://x", 'a"b\\\\c')
parsed = json.loads(raw)
assert parsed["provider"] == "openai-compatible"
assert parsed["apiKey"] == 'a"b\\\\c'
print("ok")
`;

const result = spawnSync(
  python.bin,
  [...python.prefix, '-c', probe, path.join(repoRoot, 'bench/deepswe')],
  {
    encoding: 'utf8',
  }
);
assert.equal(result.status, 0, `${result.stderr || ''}\n${result.stdout || ''}`);
assert.match(result.stdout, /^ok\n?$/);

console.log('[PASS] deepswe bakes host sampling into the container command');
