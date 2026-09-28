# Moss 能力梳理：删除 / 新增 / 优化规划

> 状态：**已执行完毕(2026-09-28)**。决策:D1 选 A / D3 删 16 个 / D2 直接删(实际范围收缩,见执行记录)/ A4 不做。
> 与行为不变的整洁化计划(`2026-09-28-moss-clean-architecture-cleanup.md`)互补:整洁化(Phase 0-7)已全部完成,本文档能力增删随后独立执行。
> 依据:2026-09-28 对 src/ 264 文件 / 5.6 万行的全量扫描 + 运行时调用链追踪。所有结论附证据位置。

---

## 一、能力清单盘点（现状）

### 1. 工具面（21 个内置工具）

| 分组   | 工具                                                                                         | 评价                                                  |
| ------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| 文件   | read_file / write_file / edit_file / multi_edit / move_file / list_directory / apply_patch   | 完整，无冗余                                          |
| 搜索   | search_files / search_code                                                                   | ripgrep 优先 + JS 回退，设计良好                      |
| 执行   | exec / exec_background / exec_logs / exec_stop（+exec_wait）                                 | 覆盖同步/后台/日志/停止                               |
| 验证   | run_tests / verify_fix / code_diagnostics                                                    | 结构化输出（pass/fail 计数、file:line），是差异化能力 |
| Web    | web_fetch / web_search                                                                       | web_search 含 8 个后端（见 O1）                       |
| 子代理 | create_subagent / fan_out_subagents / merge_subagent_patch / subagent_status / subagent_stop | 完整生命周期                                          |
| 交互   | ask_user_question / todo_write                                                               | 必要                                                  |

### 2. CLI 命令面（15 明示 + 9 隐藏）

明示：/clear /compact /context /diff /doctor /help /init /model /permissions /quickstart /quit /review /sessions /status /stop；
隐藏：/mode(/plan) /steer /queue /loop /resume /history /rewind(/undo)。
命令密度对一个 minimal harness 是合理的；/review（含 gh PR review）、/rewind（文件检查点回滚）是超出预期的能力。

### 3. Provider 层 —— **三套并行实现（重大发现）**

| 栈                                                | 规模                                                                                           | 运行时角色             | 证据                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A. `cli/providers.ts` 私有实现                    | 763 行（自带 callAnthropic:254 / callOpenAI:405 + protocol-router + MultiProviderRouter 装配） | **CLI 唯一运行时路径** | `createCliProvider` → `PROTOCOL_ROUTER.resolve(...)`；src 内零处 `new PiAiLLMProvider/AnthropicLLMProvider/OpenAILLMProvider` |
| B. `provider/anthropic.ts` + `provider/openai.ts` | 750 行                                                                                         | 仅 SDK 导出 + 测试     | 唯一引用是 `provider/index.ts` re-export                                                                                      |
| C. `provider/pi-ai-*` 全家桶                      | ~1,700 行（adapter 412 + wire-format 449 + stream-parser + watchdog + types）                  | 仅 SDK 导出 + 测试     | 同上；但承载了 thinking 历史、watchdog、cache-control 等最深能力                                                              |

### 4. 会话持久化 —— **两套并行栈（重大发现）**

| 栈                                                                                 | 规模      | 运行时角色                                           |
| ---------------------------------------------------------------------------------- | --------- | ---------------------------------------------------- |
| A. 事件栈：session-event-store / -recorder / -projector                            | ~400 行   | **moss-agent 唯一运行时路径**（moss-agent.ts:72-77） |
| B. SessionManager + jsonl-session-store + session-write-lock + session-jsonl-codec | ~1,400 行 | 仅 SDK 桶导出（session/index.ts）+ 5 个 spec         |

### 5. 其余子系统（单套，无并行问题）

- 上下文管理：compaction（本地）/ remote-compaction（远端 compact 端点）/ microcompact / pruning / stale-read-invalidate / tail-tool-snip / window-economics / tool-output-truncate —— 8+ 策略，层次清晰
- 行为修正：29 个 nudge（整洁化后已是声明式注册表）
- 自主性：/loop（loop-scheduler 662 行）、steering、队列、checkpoint/rewind
- 子代理编排：orchestrator / runner / spawn-budget / expert-registry（贡献者式声明，无硬编码 expert，设计好）/ approved-preflight（421 行）
- 安全：channel-safety / sandbox-paths / secret-sanitizer / guardrails / approval
- 模型目录：model-catalog 494 行**硬编码**模型元数据

---

## 二、删除候选（按证据强度排序）

### D1. Provider 三套 → 一套（最高优先级决策）

- **问题**：~3,200 行 provider 代码里，CLI 只用 763 行的那套；B/C 两套是 SDK 面。同一协议（anthropic-messages / openai-chat）有三份 HTTP/SSE 实现，修 bug 要修三处（错误分类谓词刚刚统一过一次，就是三套并存的直接代价）。
- **选项 A（推荐）— CLI 收敛到 pi-ai 栈**：删 `cli/providers.ts` 的私有实现与栈 B（anthropic.ts/openai.ts），CLI 装配改用 PiAiLLMProvider + MultiProviderRouter。收益：CLI 立即获得 pi-ai 已有的 anthropic 原生流式、thinking 历史往返、首事件 watchdog、prompt cache-control；删除 ~1,100 行；provider 边界规则豁免进一步收缩。风险：pi-ai 栈未在 CLI 路径实战过，需要一轮真实会话回归（现有 spec + smoke 不完全覆盖 anthropic 原生流式下的 REPL 行为）。
- **选项 B — 删 SDK 栈 B+C，只留 CLI 实现**：删 ~2,400 行。但 pi-ai 的 thinking/watchdog 能力随之消失，且 CLI 私有实现埋在 cli 层不符合端口架构。**不推荐**。
- 决策点：采纳 A 后，`provider/anthropic.ts`、`provider/openai.ts`、`cli/providers.ts` 私有 HTTP 实现全部移除。

### D2. 会话双栈 → 事件栈

- **问题**：SessionManager 家族 ~1,400 行无运行时消费者。事件栈（appendSessionEvent/projector）是事实路径。两套 schema（SessionFileEntry vs SessionEvent）意味着会话格式演进要考虑两套兼容。
- **建议**：确认无外部嵌入方依赖 SDK 的 SessionManager（包为 private，`grep "from 'moss'"` 为空），删除栈 B（保留 5 个 spec 中锁定的纯函数如 write-lock 语义并入事件栈测试）。若想保守，先在 SDK 面标 `@deprecated` 一个版本再删。

### D3. nudge 长尾收敛（决策点：删哪些）

- **现状**：29 个 nudge 中，通用行为修正（todo / verify / red-verify / fan-out / ambiguity / subagent-running / subagent-stopped / web / git / install / run-tests / build / background-server）有明确的高频误行为对应；**speculative 长尾**（lighthouse-a11y / storybook / mutation-fuzz / contract-visual / smoke-load / snapshot / audit / e2e / coverage / eval / seed / migrate / codegen / publish-deploy / docker / format）是对"用户可能要求某类工程操作"的预设猜测，误触发面与维护面大于收益。
- **建议**：保留核心 13 个；长尾 16 个改为"配置启用"（config 一项 `agent.nudges: [ids]`，默认空）或直接删除。整洁化后每项就是注册表里一条声明，删除/门控成本已极低。
- 保守替代：只删最 speculative 的 6 个（lighthouse-a11y / storybook / mutation-fuzz / contract-visual / smoke-load / snapshot），其余保留。

### D4. model-catalog 硬编码清单 → 探测优先

- **问题**：494 行硬编码模型名/上下文窗口，随上游发布腐烂（文件内注释已承认 deepseek-v4-flash 的窗口曾被写错）。`/model` 已支持 auto-probe（doctor.ts:204-218 显示 unprobed 时提示）。
- **建议**：catalog 降级为"preset 附带的小白名单 + 显示名"，上下文窗口以运行时探测为准；删除大表。收益：删 ~400 行 + 消除持续维护义务。

### D5. 小项

- `createAnonymousExaMcpSearch`（exa 无 key 匿名 MCP 端点）：第三方免费端点，稳定性与合规存疑，且已不在默认链（默认 bing 起步）。建议删除，保留 keyed Exa。
- `duckduckgo-lite`：与主 DDG 重叠，但是被封时的降级路径，**保留**。

---

## 三、新增候选（尊重 minimal 哲学与 AGENTS.md 边界）

> 边界：不重新引入 memory / skills / mesh / mcp / observability / orchestration / web-ui。以下均为小而实的补齐。

### A1. `/usage` 会话累计用量视图（推荐，小）

数据已在：`llm_usage` 事件（inputTokens/cacheRead/cacheCreation）+ `usage-display.ts` 已算单点快照（/context 用）。缺的只是会话累计 + 简单成本估算（模型单价表可复用 model-catalog 的残留字段）。~100 行。

### A2. `/export [path]` 会话导出 markdown（小）

resume/搜索/doctor 都有；导出当前会话为 markdown（含工具调用摘要）对调试与分享高频有用。事件栈已有全量数据，纯投影实现。~150 行。

### A3. headless JSONL 事件流契约化（中）

`--json` 已零星存在（args.ts:375）。建议定义 `moss run --json` 输出稳定的 JSONL 事件流（turn 开始/结束、tool 调用/结果、llm_usage、错误），使嵌入方不需要 PTY 解析。这是"作为库被嵌入"定位的自然补齐，与已删除的 observability 子系统不冲突（本地 stdout 契约，非遥测）。

### A4.（可选）exec PTY 模式（中）

当前 exec 非交互；交互式 CLI 工具（调试器、watch 模式）无法驱动。PTY 已有基建（smoke 用 PTY 启 REPL）。非必需，列为备选。

---

## 四、优化候选

### O1. web-search 无 key 链路健壮性（推荐）

现状已有：按后端的 LooksBlocked 启发式 + 重试退避 + CJK 分链（bing→baidu→ddg→lite）。补齐方向：

- 失败计数熔断（连续 N 次被封锁的后端在本会话降级到链尾）
- `/doctor` 增加搜索后端连通性探测（与模型 egress 探测同列）
- 把 `*ResponseLooksBlocked` 启发式的样本锁进 spec（当前只有 web-search.spec 41 例，封锁页样本未锁）

### O2. compaction 效果度量（推荐）

本地 compaction / remote-compaction / microcompact / pruning 四路并存但无效果数据。在 llm_usage 事件里补 compaction 前后 token 数与摘要质量信号（保留工具名数量），`/context` 展示近 N 次压缩率。为"是否默认启用 remote"提供数据依据。

### O3. MultiProviderRouter 可观测性

failover 决策（哪个后备、为何、冷却多久）目前只在 debug 日志。`/doctor` 增加"最近 failover 记录"，与 D1 的收敛改造一并做。

### O4. 整洁化遗留的收尾

- `background-exec.ts` 进程注册表迁出 tools 层（Phase 3.3 遗留，消掉最后两条 core→tools 豁免）
- ESLint boundary 剩余豁免仅剩 `llm/llm-provider`（合法端口）与 background-exec 两项，前者保留、后者随本项消失
- `tui-utils.ts` 拆分后若壳无人引用（除 spec），可将 spec 改指新模块并删壳（低优先级）

---

## 五、优先级与节奏建议

| 序  | 事项                                 | 类型      | 依据                             |
| --- | ------------------------------------ | --------- | -------------------------------- |
| 1   | 完成进行中的整洁化计划（Phase 6-7）  | 结构      | 行为锁齐全，先落地               |
| 2   | D1 provider 收敛（选项 A）           | 删除+架构 | 最大重复面；O3 同车              |
| 3   | D3 nudge 长尾决策                    | 删除      | 注册表化后成本趋零；需要产品判断 |
| 4   | A1 /usage + A2 /export               | 新增      | 数据现成，小而确定               |
| 5   | D2 会话栈 B 删除（或先 @deprecated） | 删除      | 依赖"无外部嵌入方"确认           |
| 6   | D4 model-catalog 探测化 + D5         | 删除      | 低风险                           |
| 7   | O1 / O2                              | 优化      | 数据驱动，独立推进               |

**决策需要你拍板的**：D1 选 A 还是 B；D3 删多少（16 个全门控 / 只删 6 个最 speculative / 不动）；D2 直接删还是先标 deprecated；A4 是否要做。

---

## 六、执行记录(2026-09-28)

| 项                       | 结果                    | 偏差与说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| D1 provider 收敛(选项 A) | ✅ 完成                 | **执行中发现评审前提有误**:pi-ai 栈本身无 HTTP 传输(仅类型/wire-format/解析/watchdog),`PiAiLLMProvider` 在 src 内零构造。实际做法:新建 `provider/pi-ai-http-transport.ts`(openai-chat 路径从旧 cli/providers.ts 逐字移植含非流式回退/参数恢复/错误提示;anthropic-messages 路径为原生 SSE 流式,替换原 `stream:false` 缓冲调用),CLI 装配改为 PiAiLLMProvider + MultiProviderRouter,删栈 B(anthropic.ts/openai.ts,零 spec 零运行时消费者)。净 -372 行,CLI 获得 watchdog/thinking 策略/anthropic cache-control/deepseek reasoning_content 流式。真实回归:one-shot、工具调用 round-trip、PTY REPL 全过 |
| D2 会话栈 B 删除         | ✅ 范围收缩后完成       | **执行中发现评审前提部分不成立**:`JsonlSessionStore`+`session-write-lock` 是运行时路径(resume/fork、/sessions、/rewind、MossAgent compaction),不可删。真正死的只有 `SessionManager`+`session-jsonl-codec`(847 行,已删)                                                                                                                                                                                                                                                                                                                                                                            |
| D3 nudge 长尾            | ✅ 完成                 | 删 16 个 speculative nudge + 15 个 spec + 注册表项 + 计数器字段,-2,197 行;核心 13 个保留,13 个 nudge spec + autonomous-loop + harness 全绿                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D4 model-catalog 探测化  | ✅ 完成(范围远小于评估) | 扫描发现 `resolveContextTokensForModel` 已是探测优先实现;实际死代码是 config.ts 中 `@deprecated resolveModelContextWindow` 硬编码表(+委托+spec,已删)。494 行大表在此前工作中已不存在                                                                                                                                                                                                                                                                                                                                                                                                              |
| D5 匿名 Exa              | ✅ 完成                 | 删 `createAnonymousExaMcpSearch`,fresh-news 链不再插入第三方免费端点;keyed Exa 保留                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A1 /usage                | ✅ 完成                 | 事件日志不落 llm_usage → REPL 内存累计(`session-usage.ts`),顺带激活了从未接线的 `getContextUsage` 钩子(/context 现在显示 provider 上报数)。**成本估算未做**:仓库无单价表,硬编码单价会重蹈 D4 覆辙,只展示 token 数                                                                                                                                                                                                                                                                                                                                                                                 |
| A2 /export               | ✅ 完成                 | 复用 `moss sessions export` 的渲染器,`/export [path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | -]` 导出当前会话;spec + PTY 实测 |
| A3 headless JSONL 契约化 | ⏸ 未做                  | 本轮范围外(评审列为"中",未列入优先级表执行序)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| A4 exec PTY              | ❌ 按决策不做           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| O1 web-search 健壮性     | ✅ 完成                 | 会话级熔断(连续 3 次封锁页 → 降级到链尾,成功即复位);/doctor 增加搜索 key 检测 + bing 可达性探测(实测能识别本网络不可达);封锁页样本已锁进 spec                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| O2 compaction 度量       | ✅ 完成                 | compaction 事件补 tokensBefore/After + keptToolNames;/context 展示近 5 次压缩率;为 remote-compaction 默认与否提供数据                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| O3 failover 可观测       | ✅ 完成(与 D1 同车)     | MultiProviderRouter 记录决策环形缓冲(20 条),/doctor 展示最近 failover;router spec 扩展锁定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 整洁化 Phase 6-7(前置)   | ✅ 完成                 | 6.2 tui-utils 拆分、6.3 setup.ts 拆分、7.1 死导出清零(两轮到不动点,-1,567 行,扫描器已含 .mjs)、7.2 AGENTS.md 分层规则 + verify 全绿 + 三条边界 grep 证明为空                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**验证状态**:`npm run verify` 全绿(format+lint+typecheck+125 spec+PTY smoke);真实会话回归 3 次(one-shot 精确回复、工具调用 round-trip、PTY REPL /usage+/export)。

### O2 后续:remote compaction 默认值决策(2026-09-28,实测数据)

真实模型(qwen3.8-max)对同一 ~24.6k token 历史强制压缩的三组实测:

| 指标         | local(改前)                                | remote(localhost 调优服务) | local(加预算钳制后)     |
| ------------ | ------------------------------------------ | -------------------------- | ----------------------- |
| 模型摘要长度 | ~68k 字符(打满 0.8×reserve=16k token 预算) | 3.5k 字符(服务端 3k 上限)  | 11.4k 字符(~2.8k token) |
| 耗时         | 206s                                       | 40s                        | 151s                    |
| 文件路径保留 | 5/8                                        | 5/8                        | 5/8                     |
| 工具名保留   | 3/3                                        | 3/3                        | 3/3                     |

构成分析:压缩后上下文 ≈ keepRecent(20k)+ 摘要 + `<restored-files>` 工作集回读(5 文件×5k 预算,~58k 字符)——回读是设计内特性,与摘要器无关。

**决策:remote 保持 opt-in(MOSS_REMOTE_COMPACT_ENDPOINT 显式开启),不改默认。** 依据:① remote 需要不存在的外部服务基础设施;② 全量(脱敏后)历史外发,隐私面扩大;③ 实测 remote 的唯一优势(时延)来自输出预算约束,已通过 `MAX_SUMMARY_OUTPUT_TOKENS=4096` 钳制 + 提示词篇幅红线在本地复刻;④ 两条路径质量信号(文件/工具保留)无差异。预算钳制有回归 spec 锁定(`compaction-summary-budget.spec.mjs`)。
