#!/usr/bin/env node
/**
 * realboard-system-config-regression — 真机(RDK X5)rdk-system-config 契约端到端回归。
 *
 * 真机实跑 nmcli device status(eth0 connected netplan-eth0,NetworkManager active,EXIT=0)
 * 验证 rdk-system-config 契约:
 *  - 命令 nmcli device status → 经 expectedCommandPattern(nmcli)命中
 *  - exit_code_zero: EXIT=0 → pass
 *  - stdout_matches: 真机输出 connected(eth0 行) → pass(契约 pattern 含 connected)
 * 无板环境 → skip。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { evaluatePredicate } from '../dist/acceptance/predicate-evaluator.js';
import { ContractRegistry } from '../dist/acceptance/contract-registry.js';
import { SkillRegistry } from '../dist/skills/registry.js';

const HOST = process.env.MOSS_REALBOARD_HOST;
if (process.env.MOSS_REALBOARD_TEST !== '1' || !HOST) {
  console.log(
    '  [SKIP] realboard-system-config: set MOSS_REALBOARD_TEST=1 and MOSS_REALBOARD_HOST to opt in'
  );
  process.exit(0);
}
const SSH_ARGS = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8', `root@${HOST}`];

function boardReachable() {
  const r = spawnSync('ssh', [...SSH_ARGS, 'echo ok'], { stdio: 'pipe' });
  return r.status === 0 && String(r.stdout).trim() === 'ok';
}
if (!boardReachable()) {
  console.log(`  [SKIP] realboard-system-config: 板 ${HOST} 不可达(无板环境跳过)`);
  process.exit(0);
}
console.log(`  [REALBOARD] ${HOST} 可达,跑真机 rdk-system-config 验证...`);

// 真跑 nmcli device status
const cmd = 'nmcli device status';
const r = spawnSync('ssh', [...SSH_ARGS, cmd], { stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
const stdout = String(r.stdout);
const exitCode = r.status ?? 1;
assert.equal(exitCode, 0, `真机 nmcli 应 EXIT=0,实际 ${exitCode}`);
assert.ok(stdout.includes('connected'), `真机输出应含 connected,实际:${stdout.slice(0, 200)}`);
console.log(`  ✓ 真机 nmcli device status 跑通:EXIT=0,eth0 connected`);

// 契约命中 + 谓词判定
const reg = ContractRegistry.fromSkills(new SkillRegistry({ workspaceDir: process.cwd() }).list());
const REAL_COMMAND = 'nmcli device status';
const hit = reg.findByTool('device_exec', { command: REAL_COMMAND });
assert.ok(hit, 'nmcli 命令应命中契约');
assert.equal(hit.skillName, 'rdk-system-config', `应命中 rdk-system-config,实际=${hit.skillName}`);
console.log(`  ✓ 命中 rdk-system-config 契约(expectedCommandPattern nmcli)`);

const stdoutSpec = hit.postconditions.find((p) => p.name === 'stdout_matches');
const stdoutVerdict = await evaluatePredicate(stdoutSpec, {
  result: stdout,
  reportedIsError: false,
  input: {},
  workspaceDir: process.cwd(),
  deviceExecutor: null,
});
assert.equal(
  stdoutVerdict.verdict,
  'pass',
  `真机 nmcli 输出应判 pass(connected),实际=${stdoutVerdict.verdict} reason=${stdoutVerdict.reasonCode}`
);

const exitSpec = hit.postconditions.find((p) => p.name === 'exit_code_zero');
const exitVerdict = await evaluatePredicate(exitSpec, {
  result: stdout,
  exitCode,
  reportedIsError: false,
  input: {},
  workspaceDir: process.cwd(),
  deviceExecutor: null,
});
assert.equal(exitVerdict.verdict, 'pass', `真机 EXIT=0 应判 pass,实际=${exitVerdict.verdict}`);

console.log(`  ✓ exit_code_zero pass + stdout_matches pass(真机 connected 命中)`);
console.log('\n✅ realboard-system-config-regression: 真机 RDK X5 nmcli 端到端契约验证通过');
