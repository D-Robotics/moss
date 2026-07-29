import type { CodingCompletionGateRequest, CodingCompletionGateResult } from '../../cli/coding-completion-gate.js';
import type { ExperienceLog } from '../../memory/experience-log.js';
import type { DeviceReadonlyExecutor } from './device-readonly-executor.js';
import { arbitrateTaskTerminal } from '../../acceptance/task-terminal-verifier.js';
import { memoryWarn } from '../../memory/logger.js';

/**
 * 终态审计包装器(P0 接线)— 把 T3.3 终局审计接进 completionGate 链。
 *
 * 包装原 completionGate:先跑终态审计(读 plan.terminalAccept + ExperienceLog 全流程),
 * 若"单步全 pass 但终态 fail" → auditFailed → 直接返回 {ok:false, correction}(强制复核),
 * 否则 fall through 到原 gate(保留原 coding-completion-gate 逻辑)。
 *
 * 终态信号是真硬信号(P0:产物文件内容,非模型文本,符合 D1)。无 plan/terminalAccept
 * → 终态 unknown → 不判 auditFailed(不造假),fall through。
 *
 * 见 docs/self-evolution-loop.md T3.3 / P0。
 */

export interface TerminalArbitrationGateDeps {
  experienceLog: ExperienceLog;
  /** 当前 plan provider(读 terminalAccept)。 */
  planProvider: { current: import('../../plan-execute/plan-execute-controller.js').Plan | null };
  /** 工作区。 */
  workspaceDir: string;
  /** 设备只读执行器(产物在板子上时验存在)。无传 null。 */
  deviceExecutor: { current: DeviceReadonlyExecutor | null };
}

/**
 * 包装原 gate:先跑终态审计,auditFailed 直接拦截,否则透传原 gate。
 */
export function wrapWithTerminalArbitration(
  originalGate: (req: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult>,
  deps: TerminalArbitrationGateDeps,
): (req: CodingCompletionGateRequest) => Promise<CodingCompletionGateResult> {
  return async (req) => {
    try {
      const plan = deps.planProvider.current;
      // 只对执行中的 plan 跑终态审计(已完成的 plan 不重复判)
      if (plan && plan.status === 'executing') {
        // 读本次 session 的全流程 Experience(按 sessionKey 过滤)
        const allExperiences = await deps.experienceLog.readAll();
        const sessionExperiences = allExperiences.filter((e) => e.sessionKey === req.sessionKey);

        const { terminal, arbitration } = await arbitrateTaskTerminal({
          plan,
          experiences: sessionExperiences,
          workspaceDir: deps.workspaceDir,
          deviceExecutor: deps.deviceExecutor.current,
          finalResponse: req.response,
        });

        // auditFailed = 单步全 pass 但终态 fail → 判据失效,强制复核
        if (arbitration.auditFailed && terminal.verdict === 'fail') {
          const suspect = arbitration.suspectSkills.join(', ') || 'unknown';
          return {
            ok: false,
            reason: `terminal audit failed: single-step all-pass but terminal fail (suspect contracts: ${suspect})`,
            correction:
              `[System] 终局审计:所有单步验证谓词都 pass,但任务终态判定 fail(产物未满足 Plan.terminalAccept)。` +
              `这说明单步判据可能失效(谓词说成功,任务实际未完成)。` +
              `疑似失效契约:${suspect}。请复核这些契约的 postconditions 是否真能代表任务完成。` +
              `终态原因:${terminal.reason}。`,
            retryLimit: 1,
          };
        }
      }
    } catch (err) {
      // 终态审计失败不影响主流程(副作用式),fall through 到原 gate
      memoryWarn('terminal arbitration gate error:', err);
    }
    // 透传到原 gate(保留原 coding-completion-gate 全部逻辑)
    return originalGate(req);
  };
}
