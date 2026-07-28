import type { AcceptSpec } from './types.js';
import type { Confidence } from '../memory/experience-log.js';
import type { DeviceReadonlyExecutor } from '../core/tools/device-readonly-executor.js';

/**
 * 谓词执行器(T3.1)— 把 AcceptSpec 转成实际检查,返回 verdict + evidence。
 *
 * 本切片实现"能静态/纯文本判定"的谓词:file_exist / exit_code_zero /
 * process_running / stdout_matches。几何类(pose_error_within / force_below /
 * joint_at / video_fps_above)需设备信号接入(几何谓词待 T3 后续 + U7 传感器读取),
 * 本切片返回 unknown(不猜,标低可信,留层 3 仲裁)。
 *
 * D1 硬信号前置:谓词能确判就确判,不能就 unknown(不调模型)。
 * 见 docs/self-evolution-loop.md §5.3 / D1。
 */

export interface PredicateEvalInput {
  /** 工具 result 文本(解析退出码/stdout 用)。 */
  result: string;
  /** 工具自报 isError。 */
  reportedIsError: boolean;
  /** 工具入参(取文件路径用)。 */
  input: Record<string, unknown>;
  /** 工作区(本地文件解析用)。 */
  workspaceDir: string;
  /** 设备只读执行器(设备路径文件检查/process_running 用)。无设备传 null。 */
  deviceExecutor: DeviceReadonlyExecutor | null;
}

export interface PredicateEvalOutput {
  verdict: 'pass' | 'fail' | 'unknown';
  /** 失败时给原因码。 */
  reasonCode?: string;
  /** 证据(测量值/阈值等,诊断用)。 */
  evidence?: Record<string, unknown>;
  /** 谓词置信度:几何/退出码 medium,文件存在 high(写完却查不到=高可信失败)。 */
  confidence: Confidence;
}

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** 退出码解析(复用 objective-verifier-hook 的格式)。 */
function parseExitCode(result: string): number | null {
  const m1 = /\(exit\s+(\d+)\)/i.exec(result);
  if (m1) return Number(m1[1]);
  const m2 = /(?:exit(?:ed)?(?:\s+with)?\s+code|exit)\s+(\d+)/i.exec(result);
  if (m2) return Number(m2[1]);
  const m3 = /\bexit\s+(\d+)\b/i.exec(result);
  if (m3) return Number(m3[1]);
  return null;
}

/** 取 input 里的文件路径。 */
function extractFilePath(input: Record<string, unknown>): string | null {
  for (const key of ['path', 'filePath', 'file', 'filename']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

export async function evaluatePredicate(
  spec: AcceptSpec,
  inp: PredicateEvalInput,
): Promise<PredicateEvalOutput> {
  switch (spec.name) {
    case 'exit_code_zero': {
      const exit = parseExitCode(inp.result);
      if (exit === null) {
        // 解析不出退出码,但工具自报 isError=false → 视作执行层正常(pass medium)
        // isError=true 解析不出 → unknown(不自证)
        if (!inp.reportedIsError) {
          return { verdict: 'pass', reasonCode: 'no_exit_code_but_ok', evidence: { exitCode: null }, confidence: 'low' };
        }
        return { verdict: 'unknown', reasonCode: 'no_exit_code', confidence: 'low' };
      }
      return exit === 0
        ? { verdict: 'pass', reasonCode: 'exit_zero', evidence: { exitCode: 0 }, confidence: 'medium' }
        : { verdict: 'fail', reasonCode: 'nonzero_exit', evidence: { exitCode: exit }, confidence: 'medium' };
    }

    case 'file_exist': {
      const p = String(spec.params.path ?? extractFilePath(inp.input) ?? '');
      if (!p) return { verdict: 'unknown', reasonCode: 'no_path', confidence: 'low' };
      const isAbs = p.startsWith('/');
      const dev = inp.deviceExecutor;
      if (isAbs && dev) {
        const r = await dev.runReadOnly(`test -f ${shellQuote(p)} && echo yes || echo no`);
        if (r === null) return { verdict: 'unknown', reasonCode: 'device_unreachable', evidence: { path: p }, confidence: 'low' };
        const exists = /yes/.test(r.stdout.trim());
        return exists
          ? { verdict: 'pass', reasonCode: 'file_present', evidence: { path: p }, confidence: 'medium' }
          : { verdict: 'fail', reasonCode: 'file_missing', evidence: { path: p }, confidence: 'high' };
      }
      // 本地 fallback
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const resolved = path.isAbsolute(p) ? p : path.resolve(inp.workspaceDir, p);
        await fs.access(resolved);
        return { verdict: 'pass', reasonCode: 'file_present', evidence: { path: resolved }, confidence: 'medium' };
      } catch {
        return { verdict: 'fail', reasonCode: 'file_missing', evidence: { path: p }, confidence: 'high' };
      }
    }

    case 'stdout_matches': {
      const pattern = String(spec.params.pattern ?? '');
      if (!pattern) return { verdict: 'unknown', reasonCode: 'no_pattern', confidence: 'low' };
      try {
        const re = new RegExp(pattern);
        return re.test(inp.result)
          ? { verdict: 'pass', reasonCode: 'stdout_matched', confidence: 'medium' }
          : { verdict: 'fail', reasonCode: 'stdout_no_match', confidence: 'medium' };
      } catch {
        return { verdict: 'unknown', reasonCode: 'bad_regex', confidence: 'low' };
      }
    }

    case 'process_running': {
      const pattern = String(spec.params.pattern ?? '');
      if (!pattern) return { verdict: 'unknown', reasonCode: 'no_pattern', confidence: 'low' };
      const dev = inp.deviceExecutor;
      if (!dev) return { verdict: 'unknown', reasonCode: 'no_device', confidence: 'low' };
      // 只读白名单含 ps;grep 非白名单 → 用 ps + 解析 stdout(不用管道)
      const r = await dev.runReadOnly(`ps`);
      if (r === null) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
      const running = new RegExp(pattern).test(r.stdout);
      return running
        ? { verdict: 'pass', reasonCode: 'process_running', evidence: { pattern }, confidence: 'medium' }
        : { verdict: 'fail', reasonCode: 'process_not_running', evidence: { pattern }, confidence: 'medium' };
    }

    case 'pose_error_within':
    case 'force_below':
    case 'joint_at':
    case 'video_fps_above':
      // 几何/传感器谓词 — 需设备信号接入(几何谓词待 T3 后续 + U7 传感器读取)
      return { verdict: 'unknown', reasonCode: 'geometric_predicate_not_implemented', evidence: { name: spec.name }, confidence: 'low' };

    default:
      return { verdict: 'unknown', reasonCode: 'unknown_predicate', confidence: 'low' };
  }
}

/**
 * 跑一组 postconditions,聚合 verdict。
 * - 任一 fail → 整体 fail(AND 语义,契约要求全满足)
 * - 无 fail 但有 unknown → 整体 unknown(有未判定项,不武断 pass)
 * - 全 pass → pass
 */
export async function evaluatePostconditions(
  specs: AcceptSpec[],
  inp: PredicateEvalInput,
): Promise<PredicateEvalOutput & { perPredicate?: PredicateEvalOutput[] }> {
  const per: PredicateEvalOutput[] = [];
  let sawUnknown = false;
  for (const spec of specs) {
    const r = await evaluatePredicate(spec, inp);
    per.push(r);
    if (r.verdict === 'fail') {
      return { verdict: 'fail', reasonCode: r.reasonCode, evidence: { perPredicate: per }, confidence: r.confidence, perPredicate: per };
    }
    if (r.verdict === 'unknown') sawUnknown = true;
  }
  if (sawUnknown) {
    return { verdict: 'unknown', reasonCode: 'partial_unknown', evidence: { perPredicate: per }, confidence: 'low', perPredicate: per };
  }
  return { verdict: 'pass', reasonCode: 'all_postconditions_met', evidence: { perPredicate: per }, confidence: 'medium', perPredicate: per };
}
