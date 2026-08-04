import type { DeviceReadonlyExecutor } from '../core/tools/device-readonly-executor.js';
import type { CandidateCrossSignalVerifier } from './promotion-coordinator.js';
import { createBiasDetectionVerifier } from './cross-signal-bias-verifier.js';

/**
 * 位姿跨信号验证器(D7 端到端)— 把 bias 检测的 biasReference 接到真实双源读取。
 *
 * 对一个候选,从两个**独立信号源**(camera / encoder)各读位姿误差,经
 * createBiasDetectionVerifier 检测系统偏差。这就是 D7 的核心:同一物理量由
 * 两个无因果依赖的信号链路测量,交叉校验测量有效性(机器人独有,纯软件永远
 * 做不到)。camera 有 8mm 系统标定偏差而 encoder 无 → 两源恒差 8 → 测量无效 →
 * 拒升层(D6 切断自证循环,即 U5 反例)。
 *
 * production 离线(无设备)→ 读返 null → biasReference null → 保守 false。
 * 板子接上 + 配好 readCommand/valueRegex → 真跨信号确认,候选可真 promotable。
 *
 * 见 docs/self-evolution-loop.md D7 / 附录 B / pose-cross-signal-wiring spec。
 */

export interface PoseReadSpec {
  /** 只读命令(读该源的位姿误差)。 */
  command: string;
  /** 正则,捕获组 = 位姿误差数值。 */
  valueRegex: string;
}

export interface PoseCrossSignalDeps {
  /** 设备只读执行器(无板子传 null → 保守 false)。 */
  deviceExecutor: DeviceReadonlyExecutor | null;
  /** 候选自身源(camera)读取。 */
  cameraRead: PoseReadSpec;
  /** 独立源(encoder)读取。 */
  encoderRead: PoseReadSpec;
  /** 系统偏差阈值(两源均差超此 = 系统偏差)。默认 0(任何一致非零差都拒)。 */
  biasTolerance?: number;
  /** 采样数(各源读几次)。默认 5。 */
  sampleCount?: number;
}

async function readSamples(
  dev: DeviceReadonlyExecutor,
  read: PoseReadSpec,
  count: number,
): Promise<number[] | null> {
  let re: RegExp;
  try { re = new RegExp(read.valueRegex); } catch { return null; }
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = await dev.runReadOnly(read.command);
    if (r === null) return null;
    const m = re.exec(r.stdout);
    if (!m) return null;
    const v = Number(m[1] ?? m[0]);
    if (!Number.isFinite(v)) return null;
    samples.push(v);
  }
  return samples;
}

export function createPoseCrossSignalVerifier(deps: PoseCrossSignalDeps): CandidateCrossSignalVerifier {
  const count = deps.sampleCount ?? 5;
  const tolerance = deps.biasTolerance ?? 0;
  const biasVerifier = createBiasDetectionVerifier({
    biasTolerance: tolerance,
    measurementExtractor: async () => {
      if (!deps.deviceExecutor) return null;
      return readSamples(deps.deviceExecutor, deps.cameraRead, count);
    },
    biasReference: async () => {
      if (!deps.deviceExecutor) return null;
      return readSamples(deps.deviceExecutor, deps.encoderRead, count);
    },
  });
  return biasVerifier;
}
