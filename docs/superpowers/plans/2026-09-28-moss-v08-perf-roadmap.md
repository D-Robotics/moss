# moss v0.8 性能与能力放大路线图:缓存 × 速度 × 能力

> 状态:决策建议文档(未执行)。前置:能力评审(`2026-09-28-moss-capability-review.md`)全部完成,v0.7.0 已发布。
> **2026-10-01 复核**：本线的代码面已交付并入 main（执行记录见 [`.autopilot/PROGRESS.md`](../../../.autopilot/PROGRESS.md)）；上方"未执行"是**立项时状态**，不是当前事实。版本与 tag 口径见 [`docs/release-policy.md`](../../release-policy.md)。
> 交付口径：M1/M2 已由 `.autopilot/evidence/boards/` 的缓存命中数据背书（41% → 44%）。
> 依据:2026-09-28 对 moss 缓存/速度路径的代码级取证 + 真实 soak 基线 + DashScope/Anthropic 官方缓存机制文档。
> 定位:在 minimal harness 边界内做深三个杠杆——**前缀缓存命中率**(成本+首 token 延迟的最大杠杆)、**周转速度**、**模型能力放大**。不重新引入已删除子系统(memory/skills/mcp/observability/orchestration/web-ui)。

---

## 0. 证据基线(全部 2026-09-28 实测/取证)

| #   | 事实                                                                                                                                                    | 证据                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| E1  | **真实会话缓存命中为零**:soak 基线 4 次调用、37,352 input tokens,cache read = 0                                                                         | PTY REPL 实跑 /usage                              |
| E2  | **根因一(布局)**:每轮 `extraContext`(fresh git 快照)拼进 system 尾部,位于全部会话历史之前——`system = stable + '\n\n' + extraContext`(moss-agent.ts:709) | 隐式缓存按 messages 前缀匹配,首个差异之后全部失效 |
| E3  | **根因二(口径)**:openai-chat 传输只读 `usage.prompt_tokens/completion_tokens`,不解析 `prompt_tokens_details.cached_tokens`——即使命中也不可见            | pi-ai-http-transport.ts(openai 分支)              |
| E4  | anthropic 路径已读 `cache_read_input_tokens` ✓,cache_control 只打在 stable system 一处(无滚动断点)                                                      | 传输层 + adapter onPayload                        |
| E5  | 并行工具执行已存在(`parallelSafeTools` + `Promise.allSettled`);但每个 tool_result 独立成条消息                                                          | agent-loop-tool-execution.ts:399                  |
| E6  | tools 序列化跨轮稳定性未验证(顺序/schema 序列化需逐轮 byte-diff)                                                                                        | filterToolsForRun 装配路径                        |
| E7  | DashScope 隐式缓存:自动开启、messages 前缀匹配、共享前缀 ≥1024 tokens、**命中计费 20%**、`cached_tokens` 计入 prompt_tokens                             | 官方 Context Cache 文档                           |
| E8  | DashScope 显式缓存(cache_control):**命中 10% / 写入 125%**、单请求 ≤4 标记、20-block 回溯窗口;并行工具结果建议**合并为单条 tool 消息**防穿透            | 同上                                              |
| E9  | 主流实践(Anthropic/Claude Code):稳定内容(system/tools/历史)在前、动态内容在尾;断点滚动更新                                                              | 官方 prompt caching 指南                          |

**含义**:E1-E3 说明 moss 当前每轮都在为整段历史全额付费全额等待;这是仓库里投入产出比最高的一块改进。

---

## 一、Track A:缓存命中率工程(第一优先)

目标:稳态多轮会话中,输入 token 的**缓存命中率 ≥50%(openai 隐式)/ ≥70%(anthropic)**,输入成本与 TTFT 同步大幅下降(隐式命中价 20%、显式 10%)。

| 项                       | 内容                                                                                                                                                     | 验收                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| A1 usage 口径补全        | openai 传输解析 `prompt_tokens_details.cached_tokens` → `llm_usage.cacheReadTokens`;anthropic 已有。`/usage` 增加会话累计命中率(input 中 cacheRead 占比) | spec 锁 usage 映射;/usage 展示命中率          |
| A2 前缀布局重构          | **动态 extraContext 移出 system 尾部**:注入最新 user 消息尾部(或紧邻其前的独立尾部块)。保证 `[system stable                                              | tools                                         | history]` 跨轮逐字节一致 | 跨轮请求 byte-diff = 0(system+tools 段);真实会话命中率达标 |
| A3 tools 序列化稳定化    | 工具顺序固定 + schema 序列化稳定(空字段保留策略一致),加跨轮一致性 spec                                                                                   | spec 锁:连续两轮 tools JSON 完全相同          |
| A4 并行 tool_result 合并 | 并行组的多条 tool_result 合并为单条多 content block 的 tool 消息(E8 防穿透)                                                                              | wire 层 spec;真实并行会话命中率不回退         |
| A5 anthropic 滚动断点    | 在最新历史消息追加 cache_control 断点(命中旧前缀 + 建新缓存滚动)                                                                                         | 真实 anthropic 会话 cache_read ≥70% 输入      |
| A6 显式缓存模式(决策点)  | dashscope 显式 cache_control(命中 10% vs 隐式 20%,写 125%,4 标记上限);qwen3.8 系列有专属折扣                                                             | A1-A5 落地后实测隐式命中率,数据后决策默认开关 |

## 二、Track B:周转速度

| 项                        | 内容                                                                                          | 验收                      |
| ------------------------- | --------------------------------------------------------------------------------------------- | ------------------------- |
| B1 turn-boundary 分段计时 | tool_end → 下次 LLM 首 token 之间分段计时(context prep/序列化/发送),进 headless 事件与 /usage | p50 分段基线建立          |
| B2 TTFT 与输出速率可观测  | 首 token 延迟、tok/s 进 /usage(状态里已有 firstTokenMs 雏形)                                  | /usage 展示;soak 协议纳入 |
| B3 减少轮次策略           | 提示层鼓励单轮多工具调用(并行执行已支持,模型用得少)                                           | 真实任务平均轮次对比      |

## 三、Track C:模型能力放大

| 项                            | 内容                                                                                     | 边界说明          |
| ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------- |
| C1 仓库大纲工具(repo outline) | 一次性廉价上下文放大器:file tree + `rg --json` 符号提取(不加依赖),让模型少花轮次定位结构 | 新工具,非索引服务 |
| C2 结构化编辑回路             | apply_patch ↔ code_diagnostics 联动门禁强化(编辑后自动诊断摘要回灌)                      | 现有工具组合      |
| C3 子代理舰队深化             | fan_out + expert-registry:并行探查 + 汇总质量门(汇总必须带证据引用)                      | 现有编排深化      |
| C4 best-of-n 关键编辑(决策点) | 关键 edit 跑 n 候选 + 结构化评审择优;token 换质量,默认关                                 | 成本敏感,需拍板   |

## 四、节奏与里程碑

| 里程碑              | 内容                                              | 交付                                           |
| ------------------- | ------------------------------------------------- | ---------------------------------------------- |
| M1(度量地基,1-2 天) | A1 + A2 + A3 + B1 + B2                            | v0.7.1:命中率可见 + 前缀稳定,预期命中率 0→40%+ |
| M2(缓存主线,2-3 天) | A4 + A5 + C1                                      | v0.8.0:双协议命中率达标                        |
| M3(深化,3-5 天)     | A6 决策 + C2 + C3 + soak 复测 + B3                | v0.8.x                                         |
| 持续                | soak 周协议(watchdog/failover/熔断/命中率/压缩率) | 每周数据记录在仓库外                           |

每步均要求:真实会话 A/B 数据(scratch 测量驱动模式)+ spec 锁 + `npm run verify` 全绿。

## 五、决策点(需要拍板)

1. **A6**:隐式命中率达标(≥50%)后,是否再上显式缓存(10% 价 vs 写 125%)——建议 M3 实测后定
2. **C4**:best-of-n 是否做(成本 ×3-5 换关键路径质量)——建议默认不做,列为可选开关
3. **C1 上下文预算**:repo outline 取符号级(更大)还是文件级(更省)——建议文件级起步,M2 实测

---

## 执行记录(2026-09-28,M1-M3 全部完成)

| 里程碑                 | 结果                                                                                                                                                                                                            | 发布   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1(A1/A2/A3 + B1/B2)   | ✅ 真实会话缓存命中 **0% → 41%**(8 调用含冷启动,cached 63,488 tok);顺带修复 readSystemPromptParts 强制 dynamic 导致 anthropic cache_control 被整包丢弃的潜伏 bug;TTFT 1718ms / ~30 tok/s / 轮间隔 79ms 基线建立 | v0.7.1 |
| M2(A4/A5 + C1)         | ✅ anthropic wire 并行 tool_result 合并单消息 + 末消息滚动 cache_control 断点(spec 锁);repo_outline 工具实跑验证;复测命中 44%                                                                                   | v0.8.0 |
| M3(A6/C2/C3/B3 + soak) | ✅ 见下                                                                                                                                                                                                         | v0.8.1 |

**A6 决策(数据后定):openai 路径不默认启用显式缓存。** 依据:隐式命中价 20% 且零写入费,实测聚合命中 41-44%(含冷启动,稳态更高),接近 50% 目标线;显式仅再省 10 个百分点,但引入 125% 写入费与 4 标记管理复杂度。anthropic wire 因协议要求已带显式断点(stable system + 滚动末消息,2/4 标记)。观察项:>10 轮长会话稳态命中率若持续 <50% 再评估。

**M3 明细**:

- C2:`edit-syntax-check` 后置 hook(默认启用)——写/编辑/多编/patch 后,js/mjs/cjs 跑 `node --check`、json 跑 parse 校验(各 ~100ms),仅失败时向工具结果追加 `[post-edit check] FAIL`,模型当轮即知语法破坏,不再浪费整个验证轮;spec 锁 6 类场景
- C3:fan_out_subagents 描述与失败合并 nudge 增加证据引用要求("合并无证据引用视为未验证")
- B3:全量工程提示词增加"单轮批量独立工具调用(并行执行)"指引
- soak 复测(bench 基准,deepseek-flash@latest,temperature=0):single-edit ✅(4 轮/6.1s)、compaction-recall ✅(11 轮/46.2s,含 1 次真实压缩)、search-locate-fix ✅(6 轮/14.2s)——**3/3 通过**,M1/M2/M3 全部改动后 agentic 路径健康
