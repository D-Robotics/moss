import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultWriteChain } from '../utils/write-chain.js';

/**
 * Experience 轨迹层 — append-only,客观成败标签来源。
 *
 * 每次 Skill/工具调用后,验证器(objective-verifier)把判定结果结构化写入。
 * 关键不变量:
 *  - verdict 来自验证器(D5 守门),非模型自报 — 调用方传 verdict,本层只落盘
 *  - append-only,禁止改/删历史 — 翻盘时追加新记录含 supersedes,原记录保留
 *  - 不阻塞在线对话 — 串行写链异步,失败只 memoryWarn 不抛
 *
 * 见 docs/self-evolution-loop.md §5.2 hindsight-memory / D5 / D9。
 */

export type VerdictSource = 'exit_code' | 'file_exist' | 'geometric' | 'sensor' | 'model_judge';
export type VerdictLevel = 'L1' | 'L2' | 'L3';
export type Confidence = 'high' | 'medium' | 'low';

export interface ExperienceEntry {
  /** New production records use v2 task/run identity. Omitted on legacy JSONL. */
  schemaVersion?: 2;
  /** 调用方生成的唯一 id(如 `${sessionId}-${toolCallId}` 或时间戳序号)。 */
  id: string;
  /** 工具名 / Skill 名。 */
  tool: string;
  /** 工具入参(序列化后)。 */
  input: unknown;
  /** 工具自报的 isError(架构边界,不改 — 与 verdict 并存供层 3 仲裁)。 */
  reportedIsError: boolean;
  /** 验证器判定。客观来源,不允许模型直接写。 */
  verdict: 'pass' | 'fail' | 'unknown';
  /** 失败原因码(verdict=fail 时必填)。 */
  reasonCode?: string;
  /** 诊断向量(哪个约束未满足、误差量级)。 */
  diagnostics?: Record<string, unknown>;
  /** 信号来源(D1 级联):硬信号优先,模型兜底标 model_judge。 */
  signalSource: VerdictSource;
  /** 可信等级。硬信号 high,退出码/文件 medium,模型兜底 low。 */
  confidence: Confidence;
  /** 判定层级(层 1 契约 / 层 2 声明 / 层 3 仲裁)。 */
  verdictLevel?: VerdictLevel;
  /** 耗时 ms。 */
  durationMs: number;
  /** 时间戳(ISO,调用方传,本层不自己 new Date 以便测试注入)。 */
  timestamp: string;
  /** 会话 key。 */
  sessionKey: string;
  taskId?: string;
  runId?: string;
  attemptId?: string;
  stepId?: string;
  toolCallId?: string;
  evidenceId?: string;
  contractSkill?: string;
  contractVersion?: string;
  environmentFingerprint?: string;
  /** 翻盘时指向被取代的原记录 id(原记录保留)。 */
  supersedes?: string;
}

export interface ExperienceLogOptions {
  /** experiences.jsonl 所在目录(通常与 memoryManager 同 baseDir)。 */
  baseDir: string;
  /** 文件名,默认 experiences.jsonl。 */
  filename?: string;
}

export class ExperienceLog {
  private readonly filePath: string;
  private readonly chain = defaultWriteChain;

  constructor(opts: ExperienceLogOptions) {
    this.filePath = path.join(opts.baseDir, opts.filename ?? 'experiences.jsonl');
  }

  /** 返回文件路径(测试/注入用)。 */
  get path(): string {
    return this.filePath;
  }

  /**
   * 追加一条 Experience 记录。append-only,串行写,不阻塞。
   * 失败只 catch — 验证器是副作用式(仿 createTimingHook),写盘失败不影响主流程。
   */
  async append(entry: ExperienceEntry): Promise<void> {
    // 入参校验:verdict 三态,不能是模型自由文本(夺权原则 D5)
    if (entry.verdict !== 'pass' && entry.verdict !== 'fail' && entry.verdict !== 'unknown') {
      throw new Error(`ExperienceLog.append: verdict must be pass/fail/unknown, got ${String(entry.verdict)}`);
    }
    if (entry.verdict === 'fail' && !entry.reasonCode) {
      throw new Error('ExperienceLog.append: verdict=fail requires reasonCode');
    }
    const line = JSON.stringify(entry) + '\n';
    await this.chain.enqueue(this.filePath, () => fs.appendFile(this.filePath, line, 'utf-8'));
  }

  /** 读全量(测试/层 3 回溯分析用)。按行解析,跳过坏行。 */
  async readAll(): Promise<ExperienceEntry[]> {
    try {
      const text = await fs.readFile(this.filePath, 'utf-8');
      const out: ExperienceEntry[] = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          out.push(JSON.parse(trimmed) as ExperienceEntry);
        } catch {
          // 跳过坏行,不抛(append-only 容错)
        }
      }
      return out;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}
