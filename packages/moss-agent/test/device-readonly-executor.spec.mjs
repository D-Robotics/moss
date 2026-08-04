#!/usr/bin/env node
/**
 * device-readonly-executor — U7 安全核心验证。
 *
 * Pins down (see docs/self-evolution-loop.md U7 / D3):
 *  (1) 只读白名单命令通过(cat/test/stat/ros2 topic echo 等)
 *  (2) 危险命令(rm -rf/mkfs)被 isCommandDangerous 黑名单拒,即便混进白名单前缀
 *  (3) 非白名单写命令(write/tee/cp)被白名单拒
 *  (4) 命令注入(分号/重定向/管道)被拒
 *  (5) 断连(health.beforeOperation 抛)返回 null(不中断,让 hook 标 unknown)
 *  (6) sshSession.run 抛错返回 null(不中断)
 *  (7) NULL_DEVICE_EXECUTOR 所有调用返回 null
 */
import assert from 'node:assert/strict';
import { makeReadonlyExecutor, NULL_DEVICE_EXECUTOR } from '../dist/core/tools/device-readonly-executor.js';

// mock sshSession:DeviceSshSession.run 的返回可控
const makeMockSession = (responses = {}) => ({
  run: async (cmd, opts) => {
    if (responses.throw) throw new Error(responses.throw);
    const r = responses.map?.(cmd) ?? { stdout: 'mock-stdout', exitCode: 0 };
    return r;
  },
});

// mock health:beforeOperation 可控抛/不抛
const makeMockHealth = (disconnected = false) => ({
  beforeOperation: async () => {
    if (disconnected) throw new Error('Device connection lost');
  },
});

// ─── 1. 只读白名单命令通过 ──────────────────────────────────────────────────
{
  const sess = makeMockSession({ map: () => ({ stdout: 'file content', exitCode: 0 }) });
  const exec = makeReadonlyExecutor({ sshSession: sess, health: makeMockHealth() });
  for (const cmd of ['cat /sys/version', 'test -f /a/b', 'stat /x', 'ls /tmp', 'ros2 topic echo /cmd_vel', 'free -m', 'dmesg | tail']) {
    const r = await exec.runReadOnly(cmd);
    assert.notEqual(r, null, `whitelisted command allowed: ${cmd}`);
    assert.equal(r.exitCode, 0);
  }
}
console.log('✓ 只读白名单命令通过');

// ─── 2. 危险命令被 isCommandDangerous 拒 ─────────────────────────────────────
{
  const sess = makeMockSession({ map: () => ({ stdout: 'should not run', exitCode: 0 }) });
  const exec = makeReadonlyExecutor({ sshSession: sess, health: makeMockHealth() });
  for (const cmd of ['rm -rf /', 'mkfs /dev/sda', 'rm -rf --no-preserve-root /']) {
    const r = await exec.runReadOnly(cmd);
    assert.equal(r, null, `dangerous command rejected: ${cmd}`);
  }
}
console.log('✓ 危险命令(rm/mkfs)被黑名单拒');

// ─── 3. 非白名单写命令被拒 ────────────────────────────────────────────────────
{
  const sess = makeMockSession({ map: () => ({ stdout: 'x', exitCode: 0 }) });
  const exec = makeReadonlyExecutor({ sshSession: sess, health: makeMockHealth() });
  for (const cmd of ['write /a/b', 'tee /etc/x', 'cp /a /b', 'mv /a /b', 'chmod 777 /']) {
    const r = await exec.runReadOnly(cmd);
    assert.equal(r, null, `non-readonly write command rejected: ${cmd}`);
  }
}
console.log('✓ 非白名单写命令被拒');

// ─── 4. 命令注入被拒(分号/重定向)──────────────────────────────────────────
{
  const sess = makeMockSession({ map: () => ({ stdout: 'x', exitCode: 0 }) });
  const exec = makeReadonlyExecutor({ sshSession: sess, health: makeMockHealth() });
  // 分号分隔的第二条命令
  let r = await exec.runReadOnly('cat /a; rm -rf /');
  assert.equal(r, null, 'semicolon injection rejected');
  // 重定向到文件
  r = await exec.runReadOnly('cat /a > /etc/passwd');
  assert.equal(r, null, 'redirect injection rejected');
  // 管道进写命令(cat | tee 是白名单前缀但 tee 写文件) — 管道本身不拒,但 tee 不在白名单
  r = await exec.runReadOnly('cat /a | tee /etc/x');
  assert.equal(r, null, 'pipe to non-whitelisted rejected');
  r = await exec.runReadOnly('ros2 topic echo /cmd_vel & cat /etc/passwd');
  assert.equal(r, null, 'background command injection rejected');
  r = await exec.runReadOnly('ros2 topic echo /cmd_vel && rm -rf /');
  assert.equal(r, null, 'conditional non-readonly command rejected');
  r = await exec.runReadOnly('cat /sys/../etc/passwd');
  assert.equal(r, null, 'parent path traversal rejected');
  r = await exec.runReadOnly('cat ../../etc/passwd');
  assert.equal(r, null, 'relative parent path traversal rejected');
  r = await exec.runReadOnly('cat /home/robot/.ssh/id_rsa');
  assert.equal(r, null, 'per-user SSH path rejected');
  r = await exec.runReadOnly('cat /home/robot//.ssh/id_rsa');
  assert.equal(r, null, 'normalized per-user SSH path rejected');
  r = await exec.runReadOnly('cat /home/robot/.ssh\\/id_rsa');
  assert.equal(r, null, 'backslash path obfuscation rejected');
  r = await exec.runReadOnly('cat /sys/firmware/efi/efivars/secret');
  assert.equal(r, null, 'shared firmware policy rejected');
}
console.log('✓ 命令注入(分号/重定向/管道写)被拒');

// ─── 5. 断连返回 null(不中断)──────────────────────────────────────────────────
{
  const sess = makeMockSession({ map: () => ({ stdout: 'x', exitCode: 0 }) });
  const exec = makeReadonlyExecutor({ sshSession: sess, health: makeMockHealth(true) });
  const r = await exec.runReadOnly('cat /a');
  assert.equal(r, null, 'disconnected → null (not throw)');
}
console.log('✓ 断连返回 null,不抛中断');

// ─── 6. sshSession.run 抛错返回 null ──────────────────────────────────────────
{
  const sess = makeMockSession({ throw: 'SSH connection lost' });
  const exec = makeReadonlyExecutor({ sshSession: sess, health: makeMockHealth() });
  const r = await exec.runReadOnly('cat /a');
  assert.equal(r, null, 'sshSession.run throw → null (not propagate)');
}
console.log('✓ sshSession.run 抛错返回 null,不中断');

// ─── 7. 无 health 也能跑(可选)─────────────────────────────────────────────────
{
  const sess = makeMockSession({ map: () => ({ stdout: 'ok', exitCode: 0 }) });
  const exec = makeReadonlyExecutor({ sshSession: sess }); // 无 health
  const r = await exec.runReadOnly('cat /a');
  assert.notEqual(r, null, 'works without health (fallback to sshSession.run own errors)');
}
console.log('✓ 无 health 也能跑(可选依赖)');

// ─── 8. NULL_DEVICE_EXECUTOR 返回 null ───────────────────────────────────────
{
  const r = await NULL_DEVICE_EXECUTOR.runReadOnly('cat /a');
  assert.equal(r, null, 'null executor → null (no device)');
}
console.log('✓ NULL_DEVICE_EXECUTOR 返回 null');

console.log('\n✅ device-readonly-executor U7 全部通过(8/8)');
