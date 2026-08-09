#!/usr/bin/env node
/**
 * realboard-peripheral-regression — 真机(RDK X5)rdk-peripheral-cookbook 契约端到端回归。
 *
 * 真机实跑 /app/40pin_samples/test_i2c.py(扫 I2C 总线,8 个 /dev/i2c-N +
 * "List of enabled I2C controllers" + i2cdetect usage,EXIT=0)验证 rdk-peripheral-cookbook 契约:
 *  - 命令 python3 test_i2c.py → 经 expectedCommandPattern(i2c)命中
 *  - exit_code_zero: EXIT=0 → pass
 *  - stdout_matches: 真机输出 i2c/I2C//dev/i2c/controller → pass(契约 pattern 现含这些词)
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
    '  [SKIP] realboard-peripheral: set MOSS_REALBOARD_TEST=1 and MOSS_REALBOARD_HOST to opt in'
  );
  process.exit(0);
}
const SSH_ARGS = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8', `root@${HOST}`];

function boardReachable() {
  const r = spawnSync('ssh', [...SSH_ARGS, 'echo ok'], { stdio: 'pipe' });
  return r.status === 0 && String(r.stdout).trim() === 'ok';
}
if (!boardReachable()) {
  console.log(`  [SKIP] realboard-peripheral: 板 ${HOST} 不可达(无板环境跳过)`);
  process.exit(0);
}
console.log(`  [REALBOARD] ${HOST} 可达,跑真机 rdk-peripheral-cookbook 验证...`);

// 真跑 i2cdetect -l(列出 I2C 总线,非交互,干净 EXIT=0)
const cmd = 'i2cdetect -l';
const r = spawnSync('ssh', [...SSH_ARGS, cmd], { stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
const stdout = String(r.stdout);
const exitCode = r.status ?? 1;
assert.equal(exitCode, 0, `真机 i2cdetect -l 应 EXIT=0,实际 ${exitCode}`);
assert.ok(stdout.includes('I2C adapter'), `真机输出应含 I2C adapter,实际:${stdout.slice(0, 200)}`);
console.log(`  ✓ 真机 i2cdetect -l 跑通:EXIT=0,I2C 总线列出`);

// 契约命中 + 谓词判定
const reg = ContractRegistry.fromSkills(new SkillRegistry({ workspaceDir: process.cwd() }).list());
const REAL_COMMAND = 'i2cdetect -l';
const hit = reg.findByTool('device_exec', { command: REAL_COMMAND });
assert.ok(hit, 'i2cdetect 命令应命中契约');
assert.equal(
  hit.skillName,
  'rdk-peripheral-cookbook',
  `应命中 rdk-peripheral-cookbook,实际=${hit.skillName}`
);
console.log(`  ✓ 命中 rdk-peripheral-cookbook 契约(expectedCommandPattern i2cdetect)`);

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
  `真机 I2C 输出应判 pass(i2c/adapter),实际=${stdoutVerdict.verdict} reason=${stdoutVerdict.reasonCode}`
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

console.log(`  ✓ exit_code_zero pass + stdout_matches pass(真机 i2c/I2C adapter 命中)`);
console.log('\n✅ realboard-peripheral-regression: 真机 RDK X5 I2C 端到端契约验证通过');
