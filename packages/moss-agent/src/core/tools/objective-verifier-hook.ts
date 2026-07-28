import type { PostToolUseHook } from './tool-hooks.js';
import type { ExperienceEntry, ExperienceLog, Confidence, VerdictSource } from '../../memory/experience-log.js';
import type { DeviceReadonlyExecutor } from './device-readonly-executor.js';
import type { ContractRegistry } from '../../acceptance/contract-registry.js';
import { evaluatePostconditions } from '../../acceptance/predicate-evaluator.js';
import { memoryWarn } from '../../memory/logger.js';

/**
 * 客观验证器层 — 把任务成败判定权从模型侧收回系统侧。
 *
 * 挂 PostToolUseHook(execute-tool-call.ts:615 runPostHooks):
 * 工具 execute 之后、结果返回模型之前。isError 为入参不改(架构边界),
 * 验证器输出 verdict 与 isError 并存,写入 Experience 层供层 3 仲裁。
 *
 * T1.1 最小切片:仅退出码 + 文件存在两类硬信号(D1 级联低层)。
 * 几何/传感器信号待 U7 DeviceRegistry(单例按 sessionKey 索引设备)接入后补。
 * 模型兜底留给后续 phase — 当前硬信号全缺时标 unknown 不调模型(D1:能不调就不调)。
 *
 * 见 docs/self-evolution-loop.md §5.1 objective-verifier / D1 / D3。
 */

const EXIT_CODE_RE = /(?:exit(?:ed)?(?:\s+with)?\s+code|exit)\s+(\d+)/i;
const EXIT_CODE_NAMED_RE = /\bexit\s+(\d+)\b/i;

/** 单引号包裹路径,防注入(test -f 'path')。 */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** Moss device_exec 失败格式:`Device command failed (exit 127): ...`(device-ssh.ts)。 */
const DEVICE_FAILED_RE = /\(exit\s+(\d+)\)/i;

export interface ObjectiveVerifierDeps {
  experienceLog: ExperienceLog;
  /**
   * 生成 ExperienceEntry.id。默认 sessionKey+toolCallId。
   * 测试可注入确定性 id。
   */
  genId?: (sessionKey: string, toolCallId: string | undefined) => string;
  /**
   * 生成 ISO 时间戳。默认 new Date().toISOString()。
   * 测试可注入固定时间。
   */
  genTimestamp?: () => string;
  /** 判断某工具是否为命令类(exec/device_exec)— 退出码信号只对这类有意义。 */
  isExecLike?: (toolName: string) => boolean;
  /** 判断某工具是否写文件(edit_file/write_file/apply_patch 等)— 文件存在信号用。 */
  isWriteTool?: (toolName: string) => boolean;
  /**
   * 设备只读执行器(U7,依赖注入,无全局单例)。cli 在 connect/disconnect 时更新
   * deviceExecutor.current,hook 读它。无注入或 current=null 时 fallback 本地 fs。
   */
  deviceExecutor?: { current: DeviceReadonlyExecutor | null };
  /**
   * 验收契约注册表(D4 层1 主判据)。hook 收到工具调用 → contractRegistry.findByTool
   * → 有契约就跑 postconditions 产 L1 判定(优先于通用退出码/文件 L2 逻辑)。
   * 无契约或无注入 → 退回原退出码/文件判定(L2)。见 D4 / 解 C。
   */
  contractRegistry?: ContractRegistry;
}

const DEFAULT_IS_EXEC = (name: string): boolean =>
  name === 'exec' || name === 'device_exec' || name === 'exec_background';

// Moss 的写工具集合(见 coding-completion-gate.ts EDIT_TOOLS)
const DEFAULT_WRITE_TOOLS = new Set([
  'edit_file',
  'multi_edit',
  'write_file',
  'apply_patch',
  'move_file',
]);
const DEFAULT_IS_WRITE = (name: string): boolean => DEFAULT_WRITE_TOOLS.has(name);

/**
 * 从工具结果文本里解析退出码。支持 Moss 三种格式:
 *  - `Device command failed (exit 127): ...`
 *  - `... exited with code 1` / `exit 1`
 */
export function parseExitCode(result: string): number | null {
  const m1 = DEVICE_FAILED_RE.exec(result);
  if (m1) return Number(m1[1]);
  const m2 = EXIT_CODE_RE.exec(result);
  if (m2) return Number(m2[1]);
  const m3 = EXIT_CODE_NAMED_RE.exec(result);
  if (m3) return Number(m3[1]);
  return null;
}

/**
 * 从工具 input 里提取要验证存在性的文件路径(仅写工具)。
 * 写工具常见 input:path/filePath/file 字段。
 */
export function extractFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;
  for (const key of ['path', 'filePath', 'file', 'filename']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

interface VerdictOutcome {
  verdict: 'pass' | 'fail' | 'unknown';
  reasonCode?: string;
  signalSource: VerdictSource;
  confidence: Confidence;
  diagnostics?: Record<string, unknown>;
}

/**
 * D1 级联:硬信号前置。退出码 → 文件存在 → (几何/传感器 待 U7) → 模型兜底。
 * 当前切片:退出码 + 文件存在两类命中即判;都不命中标 unknown(不调模型)。
 */
async function evaluate(
  params: {
    tool: { name: string };
    input: Record<string, unknown>;
    result: string;
    isError: boolean;
    isExecLike: (n: string) => boolean;
    isWriteTool: (n: string) => boolean;
    fileExists: (p: string) => Promise<boolean>;
  },
): Promise<VerdictOutcome> {
  const { tool, input, result, isError } = params;

  // ① 退出码信号(仅命令类工具)— 命中即判,不调模型
  if (params.isExecLike(tool.name)) {
    const exit = parseExitCode(result);
    if (exit !== null) {
      // 退出码 0 = 执行层正常(非任务成功,标 medium)
      if (exit === 0) {
        return {
          verdict: 'pass',
          reasonCode: 'exit_zero',
          signalSource: 'exit_code',
          confidence: 'medium',
          diagnostics: { exitCode: 0 },
        };
      }
      return {
        verdict: 'fail',
        reasonCode: 'nonzero_exit',
        signalSource: 'exit_code',
        confidence: 'medium',
        diagnostics: { exitCode: exit },
      };
    }
    // isError=true 但解析不出退出码 → 工具自报失败,验证器标 unknown(不自证)
    if (isError) {
      return {
        verdict: 'unknown',
        reasonCode: 'exec_error_no_exit_code',
        signalSource: 'exit_code',
        confidence: 'low',
      };
    }
  }

  // ② 文件存在信号(仅写工具)— 命中即判
  if (params.isWriteTool(tool.name)) {
    const fp = extractFilePath(input);
    if (fp) {
      const exists = await params.fileExists(fp);
      return {
        verdict: exists ? 'pass' : 'fail',
        reasonCode: exists ? 'file_written' : 'file_missing_after_write',
        signalSource: 'file_exist',
        confidence: exists ? 'medium' : 'high', // 写完文件却不存在 = 高可信失败
        diagnostics: { path: fp, exists },
      };
    }
  }

  // ③ 无硬信号 — 标 unknown,不调模型(D1:能不调就不调,模型兜底留后续 phase)
  return {
    verdict: 'unknown',
    reasonCode: 'no_hard_signal',
    signalSource: 'model_judge', // 标记"本应由模型兜底"的来源
    confidence: 'low',
  };
}

export function createObjectiveVerifierHook(deps: ObjectiveVerifierDeps): PostToolUseHook {
  const isExecLike = deps.isExecLike ?? DEFAULT_IS_EXEC;
  const isWriteTool = deps.isWriteTool ?? DEFAULT_IS_WRITE;
  const deviceExecutor = deps.deviceExecutor;
  const contractRegistry = deps.contractRegistry;
  const genId = deps.genId ?? ((sk, tcid) => `exp_${sk}_${tcid ?? 'noid'}`);
  const genTimestamp = deps.genTimestamp ?? (() => new Date().toISOString());

  return {
    name: 'objective-verifier',
    priority: 50,
    async process({ tool, input, result, isError, durationMs, ctx, sessionId }) {
      try {
        // D4 层1 契约主判据(优先):有契约覆盖该 tool → 跑 postconditions 产 L1 判定
        // 解 C(无 plan 时按 tool 反查契约)。解 A(PlanStep.expectedAccept)待 PlanStep 接线。
        let outcome: VerdictOutcome | null = null;
        let verdictLevel: 'L1' | 'L2' | 'L3' = 'L2';
        const contract = contractRegistry?.findByTool(tool.name, input);
        if (contract) {
          const pcResult = await evaluatePostconditions(contract.postconditions, {
            result,
            reportedIsError: isError,
            input,
            workspaceDir: ctx.workspaceDir ?? process.cwd(),
            deviceExecutor: deviceExecutor?.current ?? null,
          });
          outcome = {
            verdict: pcResult.verdict,
            reasonCode: pcResult.reasonCode,
            signalSource: pcResult.verdict === 'unknown' ? 'model_judge' : 'exit_code',
            confidence: pcResult.confidence,
            diagnostics: { contractSkill: contract.skillName, perPredicate: pcResult.perPredicate },
          };
          verdictLevel = 'L1';
        }

        // 无契约 → 退回通用退出码/文件判定(L2,层 2 占位,无契约谓词)
        if (!outcome) {
        outcome = await evaluate({
          tool,
          input,
          result,
          isError,
          isExecLike,
          isWriteTool,
          // 文件存在性检查(U7):设备路径(绝对 / 开头)且 deviceExecutor.current 可用时,
          // 经只读执行器跑 `test -f` 查板子上的文件;否则 fallback 本地 fs.access。
          // 设备执行器断连/危险命令返回 null → 此处视作文件不存在(fail high,可信失败)。
          fileExists: async (p: string) => {
            const isAbs = p.startsWith('/');
            const devExec = deviceExecutor?.current ?? null;
            if (isAbs && devExec) {
              const r = await devExec.runReadOnly(`test -f ${shellQuote(p)} && echo yes || echo no`);
              if (r === null) return false; // 设备不可达 → 视作不存在(高可信失败)
              return /yes/.test(r.stdout.trim());
            }
            try {
              const fs = await import('node:fs/promises');
              const path = await import('node:path');
              const base = ctx.workspaceDir ?? process.cwd();
              const resolved = path.isAbsolute(p) ? p : path.resolve(base, p);
              await fs.access(resolved);
              return true;
            } catch {
              return false;
            }
          },
        });
        } // 闭合 if (!outcome)

        const entry: ExperienceEntry = {
          id: genId(sessionId, ctx.toolCallId),
          tool: tool.name,
          input,
          reportedIsError: isError,
          verdict: outcome.verdict,
          reasonCode: outcome.reasonCode,
          diagnostics: outcome.diagnostics,
          signalSource: outcome.signalSource,
          confidence: outcome.confidence,
          verdictLevel, // L1=契约主判据(D4);L2=通用退出码/文件(无契约占位);L3=层3仲裁(待实现)
          durationMs,
          timestamp: genTimestamp(),
          sessionKey: sessionId,
        };
        await deps.experienceLog.append(entry);
      } catch (err) {
        // 验证器是副作用式(仿 createTimingHook):写盘失败不影响主流程
        memoryWarn('objective-verifier hook error:', err);
      }
      // 返回 null:不改 result 文本(验证器只写盘,不修改喂给模型的内容)
      return null;
    },
  };
}
