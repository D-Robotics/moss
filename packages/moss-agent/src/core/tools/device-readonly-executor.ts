import { isCommandDangerous } from '../../safety/channel-safety.js';
import type { DeviceSshSession } from '../../tools/device-ssh-session.js';
import type { DeviceConnectionHealth } from '../../tools/device-connection-health.js';
import { memoryWarn } from '../../memory/logger.js';

/**
 * 设备只读执行器(U7)— 把 DeviceSshSession 包装成验证器可安全使用的只读接口。
 *
 * 设计动机(T0.1 查实 + D3 信息隔离):
 *  - DeviceSshSession 被【闭包捕获在工具内】(device-ssh.ts:196),验证器 hook 取不到。
 *    cli 在 connect/disconnect 时把这个 wrapper 塞进 deviceExecutor.current,
 *    hook 从 deviceExecutor.current 取(D10 最小侵入 + 依赖注入,core 无全局状态)。
 *  - 验证器读硬信号要跑命令(cat /sys/...、ros2 topic echo),但绝不能跑写命令
 *    (那会变验证器自己执行任务,违反 D3 + D1 夺权)。故 runReadOnly 双保险:
 *    ① 命令白名单(只读动词)② 复用 isCommandDangerous 拒危险。
 *  - 断连/无设备/危险命令 → 返回 null(让 hook 标 unknown 走层 3,不抛中断 — D1 容错)。
 *
 * 见 docs/self-evolution-loop.md U7 / D1 / D3。
 */

export interface ReadonlyExecResult {
  stdout: string;
  exitCode: number;
}

export interface DeviceReadonlyExecutor {
  /** 跑只读命令。失败/断连/危险 → 返回 null(由调用方标 unknown)。 */
  runReadOnly(command: string, opts?: { timeoutMs?: number }): Promise<ReadonlyExecResult | null>;
}

/**
 * 只读命令白名单前缀。验证器读硬信号只用这些动词。
 * 任何不在白名单的命令直接拒(返回 null),不依赖 isCommandDangerous 的黑名单兜底。
 */
const READONLY_PREFIXES = [
  'cat ',
  'test ',
  'stat ',
  'readlink ',
  'ls ',
  'echo ',
  'head ',
  'tail ',
  'wc ',
  'file ',
  'find ',
  'ros2 topic echo ',
  'ros2 topic list',
  'ros2 topic info ',
  'ros2 node list',
  'ros2 param get ',
  'rostool ',
  'ip ',
  'hostname',
  'uname ',
  'free ',
  'df ',
  'ps ',
  'dmesg ',
  'sensors ',
  'cat </',
];

function isReadonlyCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // 禁分号/重定向到文件(防 `cat x; rm -rf /`、`cat x > /etc/passwd`)
  if (/[;>]/.test(trimmed)) return false;
  // 管道允许,但每段都必须以白名单动词开头(动词后须是空格或行尾,防 `catxx` 误匹配)
  // (防 `cat x | tee /etc/passwd` 写文件 — tee 不在白名单)
  const segments = trimmed.split('|').map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((seg) =>
    READONLY_PREFIXES.some((p) => seg === p.trimEnd() || seg.startsWith(p)),
  );
}

export interface MakeReadonlyExecutorDeps {
  sshSession: DeviceSshSession;
  health?: DeviceConnectionHealth;
}

/**
 * 把一个 DeviceSshSession(已有连接)包装成只读执行器。
 * 不新建 SSH 会话,复用 /connect 已建立的 ControlMaster 复用会话。
 */
export function makeReadonlyExecutor(deps: MakeReadonlyExecutorDeps): DeviceReadonlyExecutor {
  const { sshSession, health } = deps;
  return {
    async runReadOnly(command, opts) {
      // ① 只读白名单 — 任何非只读命令直接拒
      if (!isReadonlyCommand(command)) {
        memoryWarn(`objective-verifier: rejected non-readonly command: ${command.slice(0, 80)}`);
        return null;
      }
      // ② 复用 isCommandDangerous 黑名单兜底(rm -rf / mkfs 等即便混进白名单前缀也拒)
      const danger = isCommandDangerous(command);
      if (danger.blocked) {
        memoryWarn(`objective-verifier: rejected dangerous command: ${danger.reason}`);
        return null;
      }
      // ③ 探活 — 断连直接返回 null(不抛 DeviceConnectionLostError 中断主流程)
      if (health) {
        try {
          await health.beforeOperation('objective-verifier:runReadOnly');
        } catch {
          return null; // 断连 → hook 标 unknown
        }
      }
      // ④ 跑命令 — 复用 sshSession(经 ControlMaster,~ms 级 RTT)
      try {
        const result = await sshSession.run(command, {
          timeout: opts?.timeoutMs ?? 5_000,
        });
        return { stdout: result.stdout, exitCode: result.exitCode };
      } catch (err) {
        // 断连/超时/ProcessError → null(hook 标 unknown,层 3 仲裁)
        memoryWarn('objective-verifier: device readonly exec failed:', err);
        return null;
      }
    },
  };
}

/** 空执行器 — 无设备连接时用,hook 取到它后所有调用返回 null。 */
export const NULL_DEVICE_EXECUTOR: DeviceReadonlyExecutor = {
  async runReadOnly() {
    return null;
  },
};
