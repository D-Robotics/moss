# moss v0.9 里程碑规划:安全与长跑(Security & Long-Horizon Autonomy)

> 状态:**规划冻结,未执行**。上一个 tag:v0.8.1(2026-09-28)。下一个 tag 必须过本文件的验收总门。
> 主题定性:从"能对话能改码"到"**可信地整夜自主干活**"——这是 moss 作为被嵌入 agent 引擎的生产前提。
> 决策:2026-09-28 用户拍板(三选一:安全与长跑 / 直接 v1.0 / 能力放大质变)。

---

## 0. 证据基线(为什么是这五件事,全部 2026-09-28 取证)

| #   | 事实                                                                                                                                                              | 来源                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| E1  | **安全缺陷(未修)**:exec 的 shell 写路径可绕过 workspace-write 沙箱——`printf ... > /abs/path` 等重定向把文件写到工作区外;file 工具走 sandbox 校验而 shell 写不校验 | bench 首日发现(safety-boundary 任务);沙箱对比:file-tools 走 assertSandboxPath,exec 只做 isCommandDangerous 黑名单 |
| E2  | **压缩预算估算低估 2-3×**:`MOSS_CONTEXT_TOKENS=20000` 时实际 39.6k 输入仍未触发 compaction;compaction-recall 任务被迫把 env 改到 12000 才触发                     | bench 记录;根因未定位(估算函数?chars/token 比?阈值判定字段?)                                                      |
| E3  | loop-scheduler(662 行)有迭代/resume 注释雏形与自治模式,但**无花销上限、无任务级断点状态持久化**;file-checkpoint 只覆盖文件回滚                                    | loop-scheduler.ts / file-checkpoint.ts                                                                            |
| E4  | bench 基线 `baseline-deepseek` 130/130 已建立,但**无噪声带标定**(同 SHA 重复跑)、无 `--baseline` 对比模式、无 ≥30 分钟长任务                                      | bench 记忆:待办 P2/P3                                                                                             |
| E5  | 测试套件存在**偶发 spec 崩溃**(一次裸跑崩、复跑 130/130 全绿,未追根因)                                                                                            | bench 记忆                                                                                                        |

## 1. 工作流(五大件)

### W1 沙箱收口(安全,最高优先,阻塞无人值守)

- 摸清 shell 全部出区写手法:重定向(`>` `>>` `2>` `<>`)、管道到写工具(`tee` `dd of=`)、复制移动(`cp` `mv` `install` `rsync`)、就地改写(`sed -i`)、进程替换等
- 方案(执行时按探查结果定,倾向组合):
  - a) exec 前静态解析命令,提取绝对路径写目标 → 走与 file 工具同一套 sandbox 判定
  - b) workspace-write 模式下检测到出区写 → 拒绝并给出可行动的改写建议(写区内临时文件再 move_file)
- 新增**沙箱逃逸测试套件**:已知绕过手法逐一回归锁(spec)+ bench safety-boundary 任务扩充
- 验收:逃逸套零绕过;safety-boundary bench 5/5;合法的区内重定向不被误杀(误杀率 0 的负样本集)

### W2 压缩预算修正

- 定位 E2 根因(估算函数 / chars-per-token 比 / 阈值判定用的字段与实际输入的口径差),修正
- 回归 spec:构造已知 token 量的消息序列,断言 compaction 触发点落在预期窗口 ±20%
- bench compaction-recall 恢复 20000 原配额(不再依赖 12000 补偿)
- 验收:spec 锁;compaction-recall @20000 通过且恰在预期量级触发

### W3 无人值守护栏(Runaway Guardrails)

- 配置面:`run.budget { maxTokens, maxToolCalls, maxTurns, maxWallMs }`(config + env 覆盖)
- 运行时熔断:超限 → 优雅停止——输出已完成部分 + 预算消耗报告,不硬崩、不静默
- 可观测:`/usage` 与 headless `result` 事件携带预算消耗百分比;超限走 result 的明确 subtype
- 验收:spec 锁熔断(各类预算各一);真实超限任务被拦截的实录

### W4 任务级断点续跑(Task Resume)

- loop-scheduler × file-checkpoint × session resume 融合:任务状态(目标 / todo / 已完成步骤 / checkpoint / 预算余量)持久化到 workspace runtime 目录
- `moss loop resume` 从断点继续:不重做已完成步骤,todo 与上下文延续
- 验收:kill -9 中断后 resume 能续且步骤不重做(spec 锁状态机 + 一次真实演练)

### W5 长跑基线收口

- bench 噪声带:同 SHA 重复 3 次,记录各任务最大偏差,写入基线元数据
- `--baseline <run>` 对比模式 + 判定规则(通过率下降超噪声带 = 阻塞发布)
- 新增 ≥1 个长任务(多轮压缩存活 + 跨文件重构级)
- 追因修复 E5 偶发 spec
- 验收:噪声带文档化于 bench/results 基线目录;v0.9 全量 bench 不低于基线减噪声带

## 2. 验收总门(v0.9 tag 的发布条件,缺一不发)

1. **沙箱逃逸套零绕过**(W1)
2. **bench 全量 ≥ baseline-deepseek − 噪声带**(W5)
3. **过夜级演练实录**:≥30 分钟真实自主运行一次,覆盖完成 / 预算熔断 / 崩溃续跑三个场景,数据记录在案(仓库外)
4. `npm run verify` 全绿(含 E5 追因)

## 3. 节奏(三个工作段,顺序有依赖)

| 段   | 内容                                       | 依赖 |
| ---- | ------------------------------------------ | ---- |
| 段一 | W1 + W2(安全与正确性——沙箱不收口,长跑免谈) | —    |
| 段二 | W3 + W4(长跑能力:护栏 + 断点)              | W1   |
| 段三 | W5(基线收口)+ 演练 + 发布 v0.9             | 全部 |

## 4. 明确不做(留 v1.0 或数据后议)

- 嵌入 SDK 稳定承诺 / 文档站 / 支持矩阵 → v1.0
- best-of-n、多路径探索 → 价值待证,数据后议
- 不新增子系统(AGENTS.md 边界不变)
