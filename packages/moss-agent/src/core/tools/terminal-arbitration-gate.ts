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
  /**
   * 终局信号日志(T3.4 closure):审计时把任务终态判定按 skill 写入,供
   * promotion candidateSource 聚合。可选 —— 不传则不记录(老调用方不受影响)。
   */
  terminalVerdictLog?: {
    append(entry: { id: string; skill: string; verdict: 'pass' | 'fail' | 'unknown'; reason: string; sessionKey: string; timestamp: string }): Promise<void>;
    readAll(): Promise<ReadonlyArray<{ skill: string; verdict: 'pass' | 'fail' | 'unknown' }>>;
  };
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
          executionEvidence: req.executionEvidence,
          // T3.3 漂移校准接线:传 terminalVerdictLog 让 arbitrateTaskTerminal 跑 checkDrift
          terminalVerdictLog: deps.terminalVerdictLog,
        });

        // auditFailed = 单步全 pass 但终态 fail → 判据失效,强制复核
        if (arbitration.auditFailed && terminal.verdict === 'fail') {
          const suspect = arbitration.suspectSkills.join(', ') || 'unknown';
          const drifted = (arbitration.driftChecks ?? []).filter((d) => d.driftDetected);
          const driftHint = drifted.length > 0
            ? ` 漂移校准检出:${drifted.map((d) => `${d.skill}(差${d.delta.toFixed(2)})`).join(', ')} — 单步通过率与终局成功率长期背离,契约阈值/参数可能漂移,建议重评。`
            : '';
          return {
            ok: false,
            reason: `terminal audit failed: single-step all-pass but terminal fail (suspect contracts: ${suspect})`,
            correction:
              `[System] 终局审计:所有单步验证谓词都 pass,但任务终态判定 fail(产物未满足 Plan.terminalAccept)。` +
              `这说明单步判据可能失效(谓词说成功,任务实际未完成)。` +
              `疑似失效契约:${suspect}。请复核这些契约的 postconditions 是否真能代表任务完成。` +
              `终态原因:${terminal.reason}。${driftHint}`,
            retryLimit: 1,
          };
        }

        // T3.4 closure:把任务终态判定按 skill 写入日志,供 promotion candidateSource
        // 聚合(trusted-root-safe:任务级终态硬信号,非验证器 contractSkill pass)。
        // skill 从 plan.steps[].expectedAccept 收集(PlanStep 引用的契约 skill)。
        if (deps.terminalVerdictLog) {
          const steps = Array.isArray(plan.steps) ? plan.steps : [];
          const skills = new Set<string>();
          for (const st of steps) {
            for (const sk of (st as { expectedAccept?: string[] }).expectedAccept ?? []) {
              if (typeof sk === 'string' && sk) skills.add(sk);
            }
          }
          const skillList = skills.size > 0 ? [...skills] : ['unknown'];
          for (const skill of skillList) {
            try {
              await deps.terminalVerdictLog.append({
                id: `${plan.id}:${req.sessionKey}:${skill}`,
                skill,
                verdict: terminal.verdict,
                reason: terminal.reason,
                sessionKey: req.sessionKey,
                timestamp: new Date().toISOString(),
              });
            } catch (err) {
              memoryWarn('terminal verdict log write failed:', err);
            }
          }
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
