import { createHash } from 'node:crypto';
import type { AcceptSpec } from './types.js';
import type { Confidence } from '../memory/experience-log.js';
import type { DeviceReadonlyExecutor } from '../core/tools/device-readonly-executor.js';
import {
  hasParentPathTraversal,
  isAllowedPredicateTelemetryPath,
  isBlockedDeviceReadPath,
} from '../core/tools/device-read-policy.js';

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
  /** Typed values supplied by the current trusted task/run, never model prose. */
  bindings?: Record<string, string | number | boolean>;
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
const FILESYSTEM_READ_COMMAND_RE = /^(?:cat|test|stat|readlink|ls|head|tail|wc|file|find|sha256sum)\b/;
const PREDICATE_READ_COMMAND_RE = /^(?:cat|test|stat|readlink|ls|echo|head|tail|wc|file|find|sha256sum|ros2\s+(?:topic\s+(?:echo|list|info)|node\s+list|param\s+get)|rostool|ip|hostname|uname|free|df|ps|dmesg|sensors)\b/;
const ABSOLUTE_PATH_RE = /\/[^\s'";|><&]+/g;
const STDIN_ONLY_READ_RE = /^(?:cat\s*|head(?:\s+-(?:n|c)\s*\d+)?|tail(?:\s+-(?:n|c)\s*\d+)?|wc(?:\s+-[clmwL]+)?)$/;

export function isAllowedPredicateReadCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Reject path indirection before examining absolute paths. The readonly
  // executor still provides the second layer of shell/dangerous-command checks.
  const withoutConditionals = trimmed.replace(/&&/g, '');
  if (
    hasParentPathTraversal(trimmed) ||
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
    return paths.every(isAllowedPredicateTelemetryPath);
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

const ACCEPT_BINDING_NAMES = new Set([
  'artifactPath', 'stagingArtifactPath', 'captureMarker', 'sourceYuv', 'sensorIndex', 'width', 'height',
  'frameBytes', 'runStartedAt', 'previousDigest',
]);

function resolveAcceptSpec(spec: AcceptSpec, bindings: PredicateEvalInput['bindings']): AcceptSpec | null {
  const params: AcceptSpec['params'] = {};
  for (const [key, value] of Object.entries(spec.params)) {
    if (typeof value !== 'string') {
      params[key] = value;
      continue;
    }
    const match = /^\$\{([A-Za-z][A-Za-z0-9]*)\}$/.exec(value);
    if (!match) {
      if (value.includes('${')) return null;
      params[key] = value;
      continue;
    }
    const name = match[1]!;
    if (!ACCEPT_BINDING_NAMES.has(name) || bindings?.[name] === undefined) return null;
    const resolved = bindings[name]!;
    if (typeof resolved === 'string' && (resolved.includes('\0') || hasParentPathTraversal(resolved))) return null;
    params[key] = resolved;
  }
  return { ...spec, params };
}

function imageDimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 8 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

export async function evaluatePredicate(
  spec: AcceptSpec,
  inp: PredicateEvalInput,
): Promise<PredicateEvalOutput> {
  const resolvedSpec = resolveAcceptSpec(spec, inp.bindings);
  if (!resolvedSpec) return { verdict: 'unknown', reasonCode: 'unresolved_acceptance_binding', confidence: 'low' };
  spec = resolvedSpec;
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
        if (isBlockedDeviceReadPath(p)) {
          return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', evidence: { path: p }, confidence: 'low' };
        }
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

    case 'file_nonempty': {
      const p = String(spec.params.path ?? extractFilePath(inp.input) ?? '');
      if (!p) return { verdict: 'unknown', reasonCode: 'no_path', confidence: 'low' };
      if (p.startsWith('/') && inp.deviceExecutor) {
        if (isBlockedDeviceReadPath(p)) {
          return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', evidence: { path: p }, confidence: 'low' };
        }
        const result = await inp.deviceExecutor.runReadOnly(`stat -c %s ${shellQuote(p)}`);
        if (result === null) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
        const size = Number(result.stdout.trim());
        if (!Number.isFinite(size)) return { verdict: 'fail', reasonCode: 'file_size_unavailable', evidence: { path: p }, confidence: 'high' };
        return size > 0
          ? { verdict: 'pass', reasonCode: 'file_nonempty', evidence: { path: p, size }, confidence: 'high' }
          : { verdict: 'fail', reasonCode: 'file_empty', evidence: { path: p, size }, confidence: 'high' };
      }
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const resolved = path.isAbsolute(p) ? p : path.resolve(inp.workspaceDir, p);
        const stat = await fs.stat(resolved);
        return stat.isFile() && stat.size > 0
          ? { verdict: 'pass', reasonCode: 'file_nonempty', evidence: { path: resolved, size: stat.size }, confidence: 'high' }
          : { verdict: 'fail', reasonCode: 'file_empty', evidence: { path: resolved, size: stat.size }, confidence: 'high' };
      } catch {
        return { verdict: 'fail', reasonCode: 'file_missing', evidence: { path: p }, confidence: 'high' };
      }
    }

    case 'file_created_after':
    case 'file_fresh_nonempty': {
      const p = String(spec.params.path ?? '');
      const after = String(spec.params.after ?? '');
      if (!p || !after) return { verdict: 'unknown', reasonCode: 'freshness_input_missing', confidence: 'low' };
      if (p.startsWith('/') && inp.deviceExecutor) {
        if (isBlockedDeviceReadPath(p) || (after.startsWith('/') && isBlockedDeviceReadPath(after))) {
          return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', confidence: 'low' };
        }
        const fileStat = await inp.deviceExecutor.runReadOnly(`stat -c '%Y %s' ${shellQuote(p)}`);
        if (!fileStat) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
        const [mtimeSec, size] = fileStat.stdout.trim().split(/\s+/).map(Number);
        let afterSec = Date.parse(after) / 1000;
        if (after.startsWith('/')) {
          const markerStat = await inp.deviceExecutor.runReadOnly(`stat -c %Y ${shellQuote(after)}`);
          if (!markerStat) return { verdict: 'unknown', reasonCode: 'freshness_marker_unavailable', confidence: 'low' };
          afterSec = Number(markerStat.stdout.trim());
        }
        if (!Number.isFinite(mtimeSec) || !Number.isFinite(afterSec) || !Number.isFinite(size)) {
          return { verdict: 'unknown', reasonCode: 'freshness_not_parsed', confidence: 'low' };
        }
        const passed = mtimeSec! >= afterSec && (spec.name !== 'file_fresh_nonempty' || size! > 0);
        return passed
          ? { verdict: 'pass', reasonCode: 'file_fresh', evidence: { path: p, mtimeSec, afterSec, size }, confidence: 'high' }
          : { verdict: 'fail', reasonCode: mtimeSec! < afterSec ? 'file_stale' : 'file_empty', evidence: { path: p, mtimeSec, afterSec, size }, confidence: 'high' };
      }
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const resolved = path.isAbsolute(p) ? p : path.resolve(inp.workspaceDir, p);
        const stat = await fs.stat(resolved);
        const afterMs = path.isAbsolute(after)
          ? (await fs.stat(after)).mtimeMs
          : Date.parse(after);
        if (!Number.isFinite(afterMs)) return { verdict: 'unknown', reasonCode: 'freshness_not_parsed', confidence: 'low' };
        const passed = stat.mtimeMs >= afterMs && (spec.name !== 'file_fresh_nonempty' || stat.size > 0);
        return passed
          ? { verdict: 'pass', reasonCode: 'file_fresh', evidence: { path: resolved, mtimeMs: stat.mtimeMs, afterMs, size: stat.size }, confidence: 'high' }
          : { verdict: 'fail', reasonCode: stat.mtimeMs < afterMs ? 'file_stale' : 'file_empty', evidence: { path: resolved, mtimeMs: stat.mtimeMs, afterMs, size: stat.size }, confidence: 'high' };
      } catch {
        return { verdict: 'fail', reasonCode: 'file_missing', evidence: { path: p }, confidence: 'high' };
      }
    }

    case 'artifact_digest_changed': {
      const p = String(spec.params.path ?? '');
      const previousDigest = String(spec.params.previousDigest ?? '').replace(/^sha256:/, '').toLowerCase();
      if (!p || !/^[a-f0-9]{64}$/.test(previousDigest)) return { verdict: 'unknown', reasonCode: 'digest_input_invalid', confidence: 'low' };
      let currentDigest = '';
      if (p.startsWith('/') && inp.deviceExecutor) {
        if (isBlockedDeviceReadPath(p)) return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', confidence: 'low' };
        const result = await inp.deviceExecutor.runReadOnly(`sha256sum ${shellQuote(p)}`);
        if (!result) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
        currentDigest = /^([a-f0-9]{64})\b/i.exec(result.stdout)?.[1]?.toLowerCase() ?? '';
      } else {
        try {
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          const resolved = path.isAbsolute(p) ? p : path.resolve(inp.workspaceDir, p);
          currentDigest = createHash('sha256').update(await fs.readFile(resolved)).digest('hex');
        } catch { return { verdict: 'fail', reasonCode: 'file_missing', confidence: 'high' }; }
      }
      if (!currentDigest) return { verdict: 'unknown', reasonCode: 'digest_unavailable', confidence: 'low' };
      return currentDigest !== previousDigest
        ? { verdict: 'pass', reasonCode: 'artifact_digest_changed', evidence: { digest: `sha256:${currentDigest}` }, confidence: 'high' }
        : { verdict: 'fail', reasonCode: 'artifact_digest_reused', evidence: { digest: `sha256:${currentDigest}` }, confidence: 'high' };
    }

    case 'image_decodable': {
      const p = String(spec.params.path ?? extractFilePath(inp.input) ?? '');
      if (!p) return { verdict: 'unknown', reasonCode: 'no_path', confidence: 'low' };
      if (p.startsWith('/') && inp.deviceExecutor) {
        if (isBlockedDeviceReadPath(p)) {
          return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', evidence: { path: p }, confidence: 'low' };
        }
        const result = await inp.deviceExecutor.runReadOnly(`file -b --mime-type ${shellQuote(p)}`);
        if (result === null) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
        const mimeType = result.stdout.trim().toLowerCase();
        return /^image\/(?:jpeg|png|webp|bmp|tiff)$/.test(mimeType)
          ? { verdict: 'pass', reasonCode: 'image_decodable', evidence: { path: p, mimeType }, confidence: 'high' }
          : { verdict: 'fail', reasonCode: 'image_not_decodable', evidence: { path: p, mimeType }, confidence: 'high' };
      }
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const resolved = path.isAbsolute(p) ? p : path.resolve(inp.workspaceDir, p);
        const data = await fs.readFile(resolved);
        const jpeg = data.length >= 4 && data[0] === 0xff && data[1] === 0xd8
          && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
        const png = data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        return jpeg || png
          ? { verdict: 'pass', reasonCode: 'image_decodable', evidence: { path: resolved }, confidence: 'high' }
          : { verdict: 'fail', reasonCode: 'image_not_decodable', evidence: { path: resolved }, confidence: 'high' };
      } catch {
        return { verdict: 'fail', reasonCode: 'file_missing', evidence: { path: p }, confidence: 'high' };
      }
    }

    case 'image_dimensions': {
      const p = String(spec.params.path ?? '');
      const width = Number(spec.params.width);
      const height = Number(spec.params.height);
      if (!p || !Number.isInteger(width) || !Number.isInteger(height)) return { verdict: 'unknown', reasonCode: 'image_dimensions_input_invalid', confidence: 'low' };
      let actual: { width: number; height: number } | null = null;
      if (p.startsWith('/') && inp.deviceExecutor) {
        if (isBlockedDeviceReadPath(p)) return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', confidence: 'low' };
        const result = await inp.deviceExecutor.runReadOnly(`file -b ${shellQuote(p)}`);
        if (!result) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
        const match = /(?:^|\s)(\d+)\s*x\s*(\d+)(?:\s|,|$)/i.exec(result.stdout);
        if (match) actual = { width: Number(match[1]), height: Number(match[2]) };
      } else {
        try {
          const fs = await import('node:fs/promises');
          const path = await import('node:path');
          actual = imageDimensions(await fs.readFile(path.isAbsolute(p) ? p : path.resolve(inp.workspaceDir, p)));
        } catch { actual = null; }
      }
      if (!actual) return { verdict: 'fail', reasonCode: 'image_dimensions_unavailable', confidence: 'high' };
      return actual.width === width && actual.height === height
        ? { verdict: 'pass', reasonCode: 'image_dimensions_match', evidence: actual, confidence: 'high' }
        : { verdict: 'fail', reasonCode: 'image_dimensions_mismatch', evidence: { ...actual, expectedWidth: width, expectedHeight: height }, confidence: 'high' };
    }

    case 'image_content_nontrivial': {
      const p = String(spec.params.path ?? '');
      const minVariation = Number(spec.params.minVariation);
      if (!p || !Number.isFinite(minVariation) || minVariation <= 0) return { verdict: 'unknown', reasonCode: 'content_threshold_invalid', confidence: 'low' };
      if (p.startsWith('/') && inp.deviceExecutor) {
        if (isBlockedDeviceReadPath(p)) return { verdict: 'unknown', reasonCode: 'read_path_not_allowed', confidence: 'low' };
        const result = await inp.deviceExecutor.runReadOnly(`stat -c %s ${shellQuote(p)}`);
        if (!result) return { verdict: 'unknown', reasonCode: 'device_unreachable', confidence: 'low' };
        const encodedBytes = Number(result.stdout.trim());
        const minimumBytes = Math.ceil(minVariation * 1024);
        return encodedBytes >= minimumBytes
          ? { verdict: 'pass', reasonCode: 'image_content_nontrivial', evidence: { metric: 'encodedBytes', encodedBytes, minimumBytes }, confidence: 'medium' }
          : { verdict: 'fail', reasonCode: 'image_content_trivial', evidence: { metric: 'encodedBytes', encodedBytes, minimumBytes }, confidence: 'medium' };
      }
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const data = await fs.readFile(path.isAbsolute(p) ? p : path.resolve(inp.workspaceDir, p));
        const sample = data.subarray(0, Math.min(data.length, 65_536));
        const uniqueBytes = new Set(sample).size;
        return uniqueBytes >= minVariation
          ? { verdict: 'pass', reasonCode: 'image_content_nontrivial', evidence: { metric: 'uniqueEncodedBytes', uniqueBytes }, confidence: 'medium' }
          : { verdict: 'fail', reasonCode: 'image_content_trivial', evidence: { metric: 'uniqueEncodedBytes', uniqueBytes }, confidence: 'medium' };
      } catch { return { verdict: 'fail', reasonCode: 'file_missing', confidence: 'high' }; }
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
