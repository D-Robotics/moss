/**
 * AcceptSpec — 验收谓词规格(D5 三层的代码形态)。
 *
 * D5 可信根边界:谓词拆三层,按可演化权限归属不同层级:
 *   (a) 签名(输入输出类型)— World 只读
 *   (b) 测量有效性主张("某传感器可表征某物理量")— World 只读,不可自验
 *   (c) 参数/阈值/测量实现选择 — Observation 可演化
 *
 * 代码落法:
 *   - 谓词名 `name` 绑定 (a) 签名 + (b) 测量有效性主张。例如 `pose_error_within`
 *     隐含"测的是位姿,误差在阈值内"——这个主张是只读的,自进化改不了。
 *   - `params` 是 (c) Observation 可演化:阈值(5mm)、source(相机/编码器)、组合逻辑。
 *   - 验证器按 name 查到"该测什么物理量",按 params 知道"用哪个传感器、多少阈值"。
 *
 * 升层闸(D6):层 2 自由声明 → 经统计置信度 + 层 3 跨信号确认 → 升层 1 正式契约。
 *   升层只沉淀 params(阈值/实现选择),name 对应的 (b) 测量有效性主张仍 World 只读。
 *
 * 见 docs/self-evolution-loop.md §5.3 acceptance-spec / D5 / D6。
 */

/** 谓词名 = 签名 + 测量有效性主张。系统预定义,只读(World 层)。 */
export type AcceptPredicateName =
  | 'file_exist'
  | 'process_running'
  | 'pose_error_within' // 位姿误差在阈值内(测位姿,物理量绑定)
  | 'force_below' // 力觉低于阈值(测接触力)
  | 'joint_at' // 关节角度达到目标(测关节角)
  | 'exit_code_zero' // 命令退出码为 0
  | 'stdout_matches' // 命令 stdout 匹配正则
  | 'video_fps_above'; // 视频流帧率超阈值(测推流)

/** 单个验收谓词实例。(c) 参数可演化,由契约定义者填写。 */
export interface AcceptSpec {
  /** 谓词名(绑定签名 + 测量有效性主张,World 只读)。 */
  name: AcceptPredicateName;
  /**
   * (c) Observation 可演化参数。
   *  - file_exist: { path: string }
   *  - pose_error_within: { threshold_mm: number, source: 'camera'|'encoder', readCommand: string, valueRegex: string }
   *  - force_below: { threshold_n: number, source: 'force_sensor'|'current', readCommand: string, currentRegex: string }
   *  - joint_at: { target: number, tolerance: number, readCommand: string, valueRegex: string }
   *  - video_fps_above: { threshold_fps: number, readCommand: string, valueRegex: string }
   *  - exit_code_zero: { }（无参数）
   *  等。具体 schema 由谓词名隐含(签名层)。
   */
  params: Record<string, string | number | boolean>;
  /** 人可读描述(诊断用,不参与判定)。 */
  description?: string;
  /** World-authored classification; models cannot infer or promote this marker. */
  safetyCritical?: boolean;
}

/**
 * Skill 验收契约 — 一个 Skill 的前置/后置/安全约束。
 * 存于 skill 目录的 ACCEPTANCE.yaml(贴着 SKILL.md),按 skillName 索引。
 */
export interface SkillAcceptanceContract {
  /** 对应 SkillMeta.name。 */
  skillName: string;
  /** 契约来源文件(审计用)。 */
  sourcePath: string;
  /**
   * 该契约覆盖的工具名(无 plan 时按 tool 反查契约用,解 C)。
   * 如 ['device_exec','device_file_read']。空则契约只在有 plan 时被
   * PlanStep.expectedAccept 显式引用(解 A)。
   */
  expectedTools?: string[];
  /**
   * 命令模式正则(解多覆盖:同 tool 多契约时,按 input.command 区分)。
   * device_exec 是通用工具,多个 skill 都会调,单靠 expectedTools 无法区分。
   * 契约声明此字段 → input.command 匹配才命中;无此字段 = 通用兜底契约。
   * 例:rdk-device 声明 "hb_mapper|hb_compile",rdk-ros 声明 "ros2|launch",
   * rdk-board-knowledge 不声明(兜底 xburn 等其余命令)。
   */
  expectedCommandPattern?: string;
  /** 前置:执行前须满足(如设备已连、文件已备份)。 */
  preconditions?: AcceptSpec[];
  /** 后置验收:执行后判定成败(★核心,D1 验证器用此判定)。 */
  postconditions: AcceptSpec[];
  /** 安全约束:不可违反(如温度不超阈、不出工作空间)。 */
  safetyConstraints?: AcceptSpec[];
  /** 契约版本(升层时变更)。 */
  version: string;
}
