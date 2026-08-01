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
  /** 可信工具执行证据中的 stdout。 */
  result: string;
  /** 可信工具执行证据中的结构化退出码。 */
  exitCode?: number;
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

/**
 * Contract-provided readCommand is untrusted content. Filesystem reads used by
 * predicates are limited to the kernel's read-only telemetry tree; ROS and
 * command-only probes do not carry filesystem paths and remain supported.
 */
const PREDICATE_READ_PATH_PREFIXES = ['/sys/'];
const FILESYSTEM_READ_COMMAND_RE = /^(?:cat|test|stat|readlink|ls|head|tail|wc|file|find)\b/;
const PREDICATE_READ_COMMAND_RE = /^(?:cat|test|stat|readlink|ls|echo|head|tail|wc|file|find|ros2\s+(?:topic\s+(?:echo|list|info)|node\s+list|param\s+get)|rostool|ip|hostname|uname|free|df|ps|dmesg|sensors)\b/;
const ABSOLUTE_PATH_RE = /\/[^\s'";|><&]+/g;
const STDIN_ONLY_READ_RE = /^(?:cat\s*|head(?:\s+-(?:n|c)\s*\d+)?|tail(?:\s+-(?:n|c)\s*\d+)?|wc(?:\s+-[clmwL]+)?)$/;

export function isAllowedPredicateReadCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Reject path indirection before examining absolute paths. The readonly
  // executor still provides the second layer of shell/dangerous-command checks.
  const withoutConditionals = trimmed.replace(/&&/g, '');
  if (
    /(?:^|[/\s'"])\.\.(?:[/\s'"]|$)/.test(trimmed) ||
    /(?:^|\s)(?:~|\.)\//.test(trimmed) ||
    /[\\`$;>\n\r]/.test(trimmed) ||
    withoutConditionals.includes('&')
  ) return false;

  // Validate every shell pipeline/conditional segment independently. Otherwise
  // `ros2 ... | cat /etc/hostname` would inherit the harmless first command's
  // classification and bypass the filesystem path policy.
  const segments = trimmed.split(/\|\||&&|\|/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    if (!PREDICATE_READ_COMMAND_RE.test(segment)) return false;
    if (!FILESYSTEM_READ_COMMAND_RE.test(segment)) return true;
    const paths = segment.match(ABSOLUTE_PATH_RE) ?? [];
    if (paths.length === 0) return STDIN_ONLY_READ_RE.test(segment);
    return paths.every((path) => PREDICATE_READ_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)));
  });
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
      const exit = inp.exitCode;
      if (!Number.isInteger(exit)) {
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

    case 'force_below': {
      const threshold = Number(spec.params.threshold_n);
      const source = String(spec.params.source ?? 'current');
      if (source !== 'current') {
        // force_sensor 源未实现(无契约用, YAGNI)
        return { verdict: 'unknown', reasonCode: 'force_sensor_not_implemented', evidence: { source }, confidence: 'low' };
      }
      const readCommand = String(spec.params.readCommand ?? '');
      if (!readCommand) {
        return { verdict: 'unknown', reasonCode: 'no_read_command', confidence: 'low' };
      }
      const currentRegex = String(spec.params.currentRegex ?? '');
      if (!currentRegex) {
        return { verdict: 'unknown', reasonCode: 'no_current_regex', confidence: 'low' };
      }
      if (!Number.isFinite(threshold)) {
        return { verdict: 'unknown', reasonCode: 'no_threshold', confidence: 'low' };
      }
      const dev = inp.deviceExecutor;
      if (!dev) return { verdict: 'unknown', reasonCode: 'no_device', confidence: 'low' };
      if (!isAllowedPredicateReadCommand(readCommand)) {
        return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', confidence: 'low' };
      }
      // 只读读电流(readCommand 经 deviceExecutor 的只读白名单 + 危险命令双保险)
      const r = await dev.runReadOnly(readCommand);
      if (r === null) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
      let re: RegExp;
      try {
        re = new RegExp(currentRegex);
      } catch {
        return { verdict: 'unknown', reasonCode: 'bad_current_regex', confidence: 'low' };
      }
      const m = re.exec(r.stdout);
      if (!m) {
        return { verdict: 'unknown', reasonCode: 'current_not_parsed', evidence: { stdout: r.stdout.slice(0, 120) }, confidence: 'low' };
      }
      const current = Number(m[1] ?? m[0]);
      if (!Number.isFinite(current)) {
        return { verdict: 'unknown', reasonCode: 'current_not_numeric', evidence: { matched: m[0] }, confidence: 'low' };
      }
      return current < threshold
        ? { verdict: 'pass', reasonCode: 'force_below_threshold', evidence: { current, threshold_n: threshold }, confidence: 'medium' }
        : { verdict: 'fail', reasonCode: 'force_exceeds_threshold', evidence: { current, threshold_n: threshold }, confidence: 'medium' };
    }

    case 'pose_error_within': {
      const threshold = Number(spec.params.threshold_mm);
      if (!Number.isFinite(threshold)) {
        return { verdict: 'unknown', reasonCode: 'no_threshold_mm', confidence: 'low' };
      }
      const readCommand = String(spec.params.readCommand ?? '');
      if (!readCommand) return { verdict: 'unknown', reasonCode: 'no_read_command', confidence: 'low' };
      const valueRegex = String(spec.params.valueRegex ?? '');
      if (!valueRegex) return { verdict: 'unknown', reasonCode: 'no_value_regex', confidence: 'low' };
      const dev = inp.deviceExecutor;
      if (!dev) return { verdict: 'unknown', reasonCode: 'no_device', confidence: 'low' };
      if (!isAllowedPredicateReadCommand(readCommand)) {
        return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', confidence: 'low' };
      }
      const r = await dev.runReadOnly(readCommand);
      if (r === null) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
      let re: RegExp;
      try { re = new RegExp(valueRegex); } catch { return { verdict: 'unknown', reasonCode: 'bad_value_regex', confidence: 'low' }; }
      const m = re.exec(r.stdout);
      if (!m) return { verdict: 'unknown', reasonCode: 'value_not_parsed', evidence: { stdout: r.stdout.slice(0, 120) }, confidence: 'low' };
      const measuredError = Number(m[1] ?? m[0]);
      if (!Number.isFinite(measuredError)) {
        return { verdict: 'unknown', reasonCode: 'value_not_numeric', evidence: { matched: m[0] }, confidence: 'low' };
      }
      return measuredError < threshold
        ? { verdict: 'pass', reasonCode: 'pose_within_threshold', evidence: { measuredError, threshold_mm: threshold, source: spec.params.source }, confidence: 'medium' }
        : { verdict: 'fail', reasonCode: 'pose_exceeds_threshold', evidence: { measuredError, threshold_mm: threshold, source: spec.params.source }, confidence: 'medium' };
    }

    case 'joint_at': {
      const target = Number(spec.params.target);
      if (!Number.isFinite(target)) {
        return { verdict: 'unknown', reasonCode: 'no_target', confidence: 'low' };
      }
      const tolerance = Number(spec.params.tolerance ?? 0);
      const readCommand = String(spec.params.readCommand ?? '');
      if (!readCommand) return { verdict: 'unknown', reasonCode: 'no_read_command', confidence: 'low' };
      const valueRegex = String(spec.params.valueRegex ?? '');
      if (!valueRegex) return { verdict: 'unknown', reasonCode: 'no_value_regex', confidence: 'low' };
      const dev = inp.deviceExecutor;
      if (!dev) return { verdict: 'unknown', reasonCode: 'no_device', confidence: 'low' };
      if (!isAllowedPredicateReadCommand(readCommand)) {
        return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', confidence: 'low' };
      }
      const r = await dev.runReadOnly(readCommand);
      if (r === null) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
      let re: RegExp;
      try { re = new RegExp(valueRegex); } catch { return { verdict: 'unknown', reasonCode: 'bad_value_regex', confidence: 'low' }; }
      const m = re.exec(r.stdout);
      if (!m) return { verdict: 'unknown', reasonCode: 'value_not_parsed', evidence: { stdout: r.stdout.slice(0, 120) }, confidence: 'low' };
      const angle = Number(m[1] ?? m[0]);
      if (!Number.isFinite(angle)) {
        return { verdict: 'unknown', reasonCode: 'value_not_numeric', evidence: { matched: m[0] }, confidence: 'low' };
      }
      return Math.abs(angle - target) <= tolerance
        ? { verdict: 'pass', reasonCode: 'joint_at_target', evidence: { angle, target, tolerance }, confidence: 'medium' }
        : { verdict: 'fail', reasonCode: 'joint_off_target', evidence: { angle, target, tolerance }, confidence: 'medium' };
    }

    case 'video_fps_above': {
      const threshold = Number(spec.params.threshold_fps);
      if (!Number.isFinite(threshold)) {
        return { verdict: 'unknown', reasonCode: 'no_threshold_fps', confidence: 'low' };
      }
      const readCommand = String(spec.params.readCommand ?? '');
      if (!readCommand) return { verdict: 'unknown', reasonCode: 'no_read_command', confidence: 'low' };
      const valueRegex = String(spec.params.valueRegex ?? '');
      if (!valueRegex) return { verdict: 'unknown', reasonCode: 'no_value_regex', confidence: 'low' };
      const dev = inp.deviceExecutor;
      if (!dev) return { verdict: 'unknown', reasonCode: 'no_device', confidence: 'low' };
      if (!isAllowedPredicateReadCommand(readCommand)) {
        return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', confidence: 'low' };
      }
      const r = await dev.runReadOnly(readCommand);
      if (r === null) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
      let re: RegExp;
      try { re = new RegExp(valueRegex); } catch { return { verdict: 'unknown', reasonCode: 'bad_value_regex', confidence: 'low' }; }
      const m = re.exec(r.stdout);
      if (!m) return { verdict: 'unknown', reasonCode: 'value_not_parsed', evidence: { stdout: r.stdout.slice(0, 120) }, confidence: 'low' };
      const fps = Number(m[1] ?? m[0]);
      if (!Number.isFinite(fps)) {
        return { verdict: 'unknown', reasonCode: 'value_not_numeric', evidence: { matched: m[0] }, confidence: 'low' };
      }
      return fps >= threshold
        ? { verdict: 'pass', reasonCode: 'fps_above_threshold', evidence: { fps, threshold_fps: threshold }, confidence: 'medium' }
        : { verdict: 'fail', reasonCode: 'fps_below_threshold', evidence: { fps, threshold_fps: threshold }, confidence: 'medium' };
    }

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
