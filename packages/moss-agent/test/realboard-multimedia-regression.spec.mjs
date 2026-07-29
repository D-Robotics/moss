#!/usr/bin/env node
/**
 * realboard-multimedia-regression — 真机(RDK X5)rdk-multimedia 契约端到端回归。
 *
 * 真机实跑 /app/multimedia_samples/sample_codec(硬件 H264 编码 1920x1080 NV12→h264,
 * frame= N / get stream N successful,EXIT=0)验证 rdk-multimedia 契约:
 *  - 命令 ./sample_codec -f codec_config.ini → 经 expectedCommandPattern(sample_codec)命中
 *  - exit_code_zero: EXIT=0 → pass
 *  - stdout_matches: 真机输出 frame/stream/encode → pass
 * 无板环境 → skip。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { evaluatePredicate } from '../dist/acceptance/predicate-evaluator.js';
import { ContractRegistry } from '../dist/acceptance/contract-registry.js';
import { SkillRegistry } from '../dist/skills/registry.js';

const HOST = process.env.MOSS_REALBOARD_HOST ?? '192.168.127.10';
const SSH_ARGS = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8', `root@${HOST}`];

function boardReachable() {
  const r = spawnSync('ssh', [...SSH_ARGS, 'echo ok'], { stdio: 'pipe' });
  return r.status === 0 && String(r.stdout).trim() === 'ok';
}
if (!boardReachable()) {
  console.log(`  [SKIP] realboard-multimedia: 板 ${HOST} 不可达(无板环境跳过)`);
  process.exit(0);
}
console.log(`  [REALBOARD] ${HOST} 可达,跑真机 rdk-multimedia 验证...`);

// 真跑 sample_codec(硬件 H264 编码,用板自带输入文件)
const cmd = 'cd /app/multimedia_samples/sample_codec && timeout 20 ./sample_codec -f codec_config.ini -v';
const r = spawnSync('ssh', [...SSH_ARGS, cmd], { stdio: 'pipe', maxBuffer: 4 * 1024 * 1024 });
const stdout = String(r.stdout);
const exitCode = r.status ?? 1;
assert.equal(exitCode, 0, `真机 sample_codec 应 EXIT=0,实际 ${exitCode}`);
assert.ok(stdout.includes('frame='), `真机输出应含 frame=,实际:${stdout.slice(0, 200)}`);
console.log(`  ✓ 真机 sample_codec 跑通:EXIT=0,frame= ${stdout.match(/frame=\s*(\d+)/g)?.length || 0} 次`);

// 契约命中 + 谓词判定
const reg = ContractRegistry.fromSkills(new SkillRegistry({ workspaceDir: process.cwd() }).list());
const REAL_COMMAND = './sample_codec -f codec_config.ini';
const hit = reg.findByTool('device_exec', { command: REAL_COMMAND });
assert.ok(hit, 'sample_codec 命令应命中契约');
assert.equal(hit.skillName, 'rdk-multimedia', `应命中 rdk-multimedia,实际=${hit.skillName}`);
console.log(`  ✓ 命中 rdk-multimedia 契约(expectedCommandPattern sample_codec)`);

const stdoutSpec = hit.postconditions.find((p) => p.name === 'stdout_matches');
const stdoutVerdict = await evaluatePredicate(stdoutSpec, { result: stdout, reportedIsError: false, input: {}, workspaceDir: process.cwd(), deviceExecutor: null });
assert.equal(stdoutVerdict.verdict, 'pass', `真机输出应判 pass(frame/stream),实际=${stdoutVerdict.verdict} reason=${stdoutVerdict.reasonCode}`);

const exitSpec = hit.postconditions.find((p) => p.name === 'exit_code_zero');
const exitVerdict = await evaluatePredicate(exitSpec, { result: `done (exit ${exitCode})\n${stdout}`, reportedIsError: false, input: {}, workspaceDir: process.cwd(), deviceExecutor: null });
assert.equal(exitVerdict.verdict, 'pass', `真机 EXIT=0 应判 pass,实际=${exitVerdict.verdict}`);

console.log(`  ✓ exit_code_zero pass + stdout_matches pass(真机 frame/stream 命中)`);
console.log('\n✅ realboard-multimedia-regression: 真机 RDK X5 sample_codec 端到端契约验证通过');
