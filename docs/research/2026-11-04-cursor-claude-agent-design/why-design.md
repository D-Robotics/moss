# 为什么这样设计：Cursor / Claude Code 的机制意图，与 Moss 的取舍

- 日期：2026-11-04｜角色：只读分析师（未 build、未 verify、未改代码）
- 输入：`cursor-evidence.md`（Cursor 3.27.14 逆向）、`claude-evidence.md`（Claude Desktop + Claude
  Code 2.1.317）、`moss-baseline.md`（实测基线）、`/tmp/rea-out/{lar-pretty.js,claude-code-bundle.js}`、`docs/specs/2026-11-04-moss-agent-design-p0.md`（已落地 P0）
- 本文不复述"竞品有什么"（那是三份证据报告的工作），只回答**为什么**，并给出**代价、反例、以及"因为约束 X，所以必须满足 Y，因此不能做 Z"** 形式的结论。

**证据与标注约定**

- `[obs]` 直接可见（源码行/字符串/实测数字）；`[inf]` 由 obs 推出的意图或模型；`[unknown]` 取不到。
- 引用：Cursor `lar:L<n>`（`/tmp/rea-out/lar-pretty.js`，与 `cursor-evidence.md` 同坐标）；Claude Code `bundle:L<n>`（`/tmp/rea-out/claude-code-bundle.js`，带"（串：`…`）"的是本文新换算的
  定位，按字面量搜索得到、可复跑）；Moss 用 `src/...:行号`（HEAD `36262014` + 本会话 P0 未提交改动）。
- 经济学数字是**模型**（标注假设），不是账单；唯一有代码出处的单价是 Anthropic sonnet/haiku 的 cache write/read 比 `3.75 / 0.3`（read 的 12.5 倍）或 `1.25 / 0.1`，见 `tool-result-fold.ts:24-28`。

---

## 0. 一页结论：5 条"为什么"

1. **agent 的固定开销是"每轮重复支付的租金"，不是一次性的入场费。** 所以 Cursor 缩 prompt 体积（按模型/agent 类型分档），CC 把 prompt 切成可被 provider 缓存的稳定前缀（`bundle:L88180` 的
   `__SYSTEM_PROMPT_STATIC_BREAKPOINT__`）。→ **凡每轮重发的东西先问"能否待在稳定前缀里"；凡要变的东西必须待在前缀之后或 user 附件里，否则每次变化都在烧缓存。**
2. **模式（plan/ask）不是权限位，是"最后一层注入的契约"。** Cursor 每轮 `<system_reminder>`，
   CC 每轮 `isMeta` 用户附件（`bundle:L93698` 完整 / `bundle:L93780` 稀疏），两家的原文都是
   "This supercedes any other instructions"——**因为基础 prompt 里就写着"用户要改就去改"**，不显式覆盖，
   模型会在两条相反指令间做平均而不是选择。→ **矛盾指令必须由最后到达的那条显式宣布优先级，
   否则模型会"部分遵从"，那比拒绝执行更糟。**
3. **渐进披露不是为了省字，是因为"工具列表是缓存前缀的一部分"。** 任何工具列表变动 = 前缀失效 +
   模型重新认识工具面；所以 CC/Cursor 都懒加载，但都把"揭示"设计得尽量少发生（Moss 的 sticky
   是同一原因，`src/core/tools/deferred-tool-offer.ts:1-5`）。→ **省 token 的手段必须服从
   "前缀稳定"这个更硬的约束；冲突时先保稳定。**
4. **"拒绝"是用户意志的表达，不是一次失败。** CC 写死 "a denied call means the user declined it —
   adjust, don't retry verbatim"（`bundle:L92246`），Cursor 用 result case 把 `rejected` 与 `error`
   分开。→ **错误文案的读者是模型，它决定下一步动作；所以文案要编码"这是谁的意志、下一步合法
   动作是什么"，不能只描述发生了什么。**
5. **长会话的质量地板由"压缩是否可回溯"决定，不由"摘要写得多好"决定。** Cursor 把旧段写成
   `# HISTORICAL -- DO NOT EDIT` 并附"用 read_file/grep 查回"（`lar:63784-64057`），CC 把压缩状态
   做成一等数据（`effective_window − summary buffer = threshold`）。→ **压缩的正确目标是
   "上下文里留索引、细节留在磁盘可查"，不是"把细节压成更短的散文"。**

> 一句话：三家都在解同一道题——**把"每轮成本 × 轮数"里不可省的部分压到最小、可变的部分挪到
> 不破坏缓存的位置**；差别只在各自能用的手段（provider 原语 / 模型异构 / 产品定位）。

---

## 1. 产品约束模型：三家各自在优化什么

### 1.1 共同约束：token 是租金，不是价格

一次会话成本 ≈ Σ_turn（稳定前缀 + 工具 schema + 历史 + 本轮输入）× 单价。稳定前缀与工具 schema
**每一轮都会重发**（命中缓存也按 read 价计费）。`[inf]` 以 5.5k 稳定前缀、write 1.25×/read 0.1×
估算：K 轮无缓存 = K×5.5k；有缓存 ≈ 1.25×5.5k + (K−1)×0.1×5.5k。K=2 省 ~33%，K=10 省 ~78%，
K=50 省 ~88%，渐近 90%（假设前缀字节稳定、尾部新增单独写入，忽略尾部写入成本）。

**反直觉推论（重要）**：缓存命中后工具 schema 的边际成本只有 1/10。所以"工具面收敛"省的
主要不是钱，而是**注意力与误选率**。把两者混为一谈会得到错误的优先级（见 §4）。

### 1.2 Cursor：多模型转售商 → 优化"单请求成本 × 模型异构鲁棒性"

`[obs]` 提示词按 12 个模型布尔 + `promptVersion`（`cursor-0226`/`dsv3-1018`）分叉
（`lar:108500-108560`），连工具 description 也有 per-model 分支（`lar:158963-158986`）；
`reducedSystemPrompt` 的开启条件是 `compactShellDescription` flag + IDE/CLI + 非 background +
非 local-agent（`lar:108342-108349`），并对 `computerUse` 子代理**强制开启**
（`lar:175216-175218`）。三份证据报告里**没有** `cache_control`/缓存断点的痕迹，只有
"供应商缓存 + reducedSystemPrompt"。

`[inf]` 目标函数 ≈ `−(每请求 token 成本 + 弱模型错误率 + 用户等待)`。Cursor 转售多家模型，
**不能把产品赌在某一家 provider 的缓存原语上**，所以它的"省"必须 provider 无关：缩 prompt 分档、
缩工具面（搜索/懒加载）、缩工具输出（head 5k/tail 5k）。代价是拿不到缓存断点那 10× 折扣，
换来"换模型不掉质量"。它还明显在做**评测驱动**：`ToolCallTelemetryEvent{is_parallel,
parallel_batch_size, approval_wait_duration}`、`args_parse_success`（`lar:78844`）、skills 的
`renderedEstimatedTokens/omittedSkillCount/strategy`（`lar:116294/117195`）——`[inf]` 这些指标
说明"并行度、参数正确率、skills 预算"被当产品 KPI 追。

### 1.3 Claude Code：单 provider + 企业部署 → 优化"缓存命中率 × 可管控性"

`[obs]` 它敢把缓存做成产品原语：`cacheScope: global|org|session|null`（`bundle:L88191-88196`），
最终映射成 provider 的 `cache_control: m7({scope,ttl})`（串：`cache_control:m7({scope`，`bundle:L92678`）；
有 `scopeRefused` 回退与 `skipGlobalCacheForSystemPrompt` 的"tool-based cache"兜底
（`bundle:L88185`），以及 `ENABLE_PROMPT_CACHING_1H`、`CLAUDE_CODE_PROMPT_CACHE_TTL`
（`bundle:L83507`）。企业面同样硬：managed-policy CLAUDE.md、`org` 作用域、权限规则语言、
hook 生命周期（`claude-evidence.md` §A5/F2/C1）。

`[inf]` 目标 ≈ `−(每轮成本 + 每轮延迟)`，受"多租户隔离 + 企业策略可下发"约束。`global` 的经济
含义是**把一次前缀写入成本摊到所有用户**；安全含义同样硬：**global 里的文本必须逐字节相同、
不能含任何用户/仓库数据**。这解释了为什么稳定前缀只能剩身份与通用契约。评测驱动更彻底：
每块上报 `tengu_sysprompt_block{length,hash}`、边界上报 `tengu_sysprompt_boundary_found{...}`
（`bundle:L88191`）→ `[inf]` 提示词改动的**缓存影响可归因**。

### 1.4 Moss：单仓库 + 机器人闭环 + headless → 优化"完成判定可信 × 不弄坏设备 × 固定开销低"

`[obs]` 代码投资分布本身就是约束的证明（`find … | xargs wc -l`，HEAD）：

| 目录                                       | 行数  | 目录                                  | 行数   |
| ------------------------------------------ | ----- | ------------------------------------- | ------ |
| `src/contracts/prompts/`（全部提示词契约） | 186   | `src/core/loop/`（循环、护栏、nudge） | 9,050  |
| `src/context/`（压缩、裁剪、elide、fold）  | 4,586 | `src/tools/` + `src/core/tools/`      | 16,444 |

`[inf]` 这是**有意的立场**，理由写在代码里：quick prompt 的 JSDoc 说现代 LLM 已具备那些通用能力，
"每次请求多付 ~15k chars（且多个 provider 上缓存不生效）会稀释安全关键行"
（`moss-baseline.md` §1.4）。Moss 把钱花在**机制**（verdict provider、loop-guard、evidence、
approval 分层）而不在 prompt 篇幅上；这在机器人闭环里是对的——失败模式是"没验证就宣布成功"
和"把设备弄坏"，不是"回答不够详细"。

`[obs]` 它已经做了两件与 CC 同构的事且不差：稳定/动态二段（`src/core/agent/moss-agent.ts:390`），
dynamic 在 OpenAI 兼容线上搬到 user 消息的 `<turn-context>`（理由写在
`src/provider/pi-ai-http-transport.ts:320-334`："网关把 tools 放在 system 之后，system 里放
易变文本会打掉 tool-schema 缓存"）；真正的断点也打了——稳定块 `cache_control: ephemeral`
（`src/provider/pi-ai-adapter.ts:66-80`）+ 最后一轮消息尾部**滚动断点**
（`src/provider/pi-ai-http-transport.ts:836-852`，注释："hit-old + create-new rolling pattern …
Two markers total with the stable-system one, well under the provider limit of four"）。
更细的是它写了**成本不等式**来决定要不要改写历史：`savedTokens × remainingRequests × readPrice >
suffixTokens × (writePrice − readPrice)`，`savingsRatio = 11.5`
（`src/context/tool-result-fold.ts:1-41`）——全仓库唯一显式写出"改前缀要付缓存重写费"的地方。

### 1.5 约束对照

| 维度          | Cursor                         | Claude Code                           | Moss                                       |
| ------------- | ------------------------------ | ------------------------------------- | ------------------------------------------ |
| 缓存手段      | 供应商缓存（不可控）           | 自己就是 provider 侧产品（scope/ttl） | 自行打 `cache_control`，依赖 provider 支持 |
| 模型异构      | 12+ 模型，必须 provider 无关   | 自家模型族（+vertex/bedrock）         | 5 家 provider，能力不一                    |
| 主要成本杠杆  | 缩短 prompt/工具/输出          | 拉长可缓存前缀、提高命中率            | 减少**轮数**（nudge/压缩/完成门）          |
| 企业/安全约束 | 隐私（rules 分源、env 白名单） | 多租户 + 策略下发 + 注入防御          | 设备风险分级 + headless 拒绝               |
| 评测方式      | 遥测 KPI（并行度/解析率）      | prompt 块 hash + 边界遥测 + A/B       | run_metrics（含 promptCache\* 字段）       |

---

## 2. 逐机制"为什么"（12 条）

### M1 为什么把 system prompt 切成"稳定矩阵 + 缓存断点"

**做法** `[obs]` CC 用字面量 `__SYSTEM_PROMPT_STATIC_BREAKPOINT__` 把 prompt 切两段（`bundle:L88180`），
前段每块打 `cacheScope:"global"`，后段打 `org` 或 `null`——"若前段被拆成 >1 块，后段不再占标记"
（`I.length>1?null:"org"`，`bundle:L88196`）。Cursor 没有断点，取而代之是 `reducedSystemPrompt` 这档
更短的 prompt（`lar:108342`）。

**在优化什么** `[inf]`：① **命中率**（单轮 10× 价差）与延迟（cache read 的 TTFT 更短）；
② `scope` 是**商业维度**：global 写一次、全员共享读，session 只服务本会话——即"谁付缓存写入费"；
③ **标记是稀缺资源**：provider 断点上限 4（Moss 注释，`pi-ai-http-transport.ts:841`），
CC 的 `I.length>1?null` 说明它在静态块与后缀之间分配这个预算，**不能什么都标**。

**代价与反例**：① `global` 要求逐字节相同且无用户数据，直接限制了"把项目指令塞进稳定前缀"；
② 反例：Cursor 不这么做也能活——它面对多 provider，`reducedSystemPrompt` 是**缓存无关的替代品**。
所以"切缓存断点"不是普适最佳实践，只在"能控制 provider"时成立；③ 反例：若会话只有 1–2 轮，
缓存写入费可能吃掉落差。

**对 Moss 的含义**：断点已正确（稳定块 + 滚动尾块），但**度量模型错位**：
`assessPromptCacheEligibility` 把 `dynamic/stable ≤ 25%` 当"缓存资格"
（`src/core/llm/prompt-prefix-cache.ts:33-34`），而这只与"你有多大比例上下文在重付"有关、
与"能否命中"无关（前缀字节稳定就能命中）；且它**只进遥测、不驱动决策**
（`src/core/loop/agent-loop.ts:774-808`）。所以 README §1.3 那场"G1 是否成立"的争论，
争的是一个诊断指标的阈值，不是机制。

### M2 为什么模式用"每轮追加 reminder"而不是"另一套 system prompt"

**做法** `[obs]` Cursor：模式枚举 `Qhe`（`lar:118093`），Ask/Plan reminder 全文 `lar:199897`，
每轮追加 `<system_reminder>`；"整条消息只有 reminder"是合法形态（正则 `lar:66582`）；
配"看到但别提"（`lar:99057`）。CC：plan reminder 是**带 `isMeta:true` 的用户附件**，且分两档——
完整版 `bundle:L93698`（前导 + Plan File Info + 5 阶段工作流 + "只能以 ExitPlanMode 或
AskUserQuestion 结束本轮"的协议尾）与**稀疏版** `bundle:L93780`（"Plan mode still active
(see full instructions earlier in conversation). Read-only except plan file (…)"），
另有子代理变体。两家都写 "This supercedes any other instructions"（CC 原文拼写如此）。

**在优化什么** `[inf]`：① **缓存**（主因）——模式可中途切换（Cursor 有 `switch_mode` 工具），
模式 = 另一套 system prompt 会让每次切换重写整个前缀，同会话内两模式也无法共享前缀；
② **矛盾消解**——基础 prompt 写着"按用户要求改代码"，模式写着"不许改"，不显式声明覆盖时模型
会**部分遵从**（最常见："我就改一小下"）；③ **位置=效力**——附件挂在用户轮 = 动手前读到的
最后内容（recency），而 system prompt 在长会话里被"读远"了。CC 的稀疏档是这个模型的直接证据：
它假设"全文还在上下文里但注意力已衰减"，所以用**最小剂量复述**而不是重复全文。

**代价与反例**：① 每轮都要付 reminder 的 token（CC 的 sparse 档是对此的自觉）；
② 双写会漂移：同一约束写两处、改一处忘一处 → 模型收到互相矛盾的版本，所以 CC 的 reminder 只说
"见前文"；③ 反例：若模式**从不中途切换**（如 `-p --plan` 一次性任务），"另一套 system prompt"
反而更省（没有每轮重复）。

**对 Moss 的含义**：P0-1 把 `PLAN_MODE_PROMPT` 放 dynamic 层（`src/contracts/prompts/plan-mode-prompt.ts`）
方向对（不污染 stable、可回收），但只实现"常驻一档"，缺 CC 的两条：**(a) 稀疏复述**——长会话里
同一段 ~1.1KB 每轮重发既费钱又会被注意力衰减；**(b) 结束协议**——CC 明确"本轮只能以提问或提交
计划结束"，Moss 没有，于是 plan 模式退化为"少动手"而不是"产出可审批物"。

### M3 为什么工具面刻意小 / 可搜索 / 懒加载

**做法** `[obs]` Cursor：两代 schema 并存；`pi_*` 兼容层 7 个工具、description 只有一句话
（`lar:173672-174180`）；MCP 有激进形态——把每个 tool descriptor 写成磁盘 JSON 文件、模型用文件
工具读 schema（`lar:105425`，原文 "MANDATORY: Always Check Tool Schema First"）。CC：
`ENABLE_TOOL_SEARCH`/`ToolSearch`/每工具 `searchHint`/`anthropic/alwaysLoad`（`claude-evidence.md` §E2；
`searchHint` 见串 `bundle:L87065`）。Moss：38 个可见工具 schema 实测 32,950 chars ≈ 8.2k token，
而全部固定 prose 只有 ~1.2k token（`moss-baseline.md` §0.2）。

**在优化什么** `[inf]`：① token（首请求 + 缓存写入）——但不是主因（缓存后 0.1×）；
② **选择准确率**——候选越多，误选与"该并行却串行"概率越高；Cursor 的 `semantic_search`
用"何时不用 + 该改用 grep/read/glob"就是**显式路由**，把选择成本从试错挪进描述；
③ **前缀稳定**（最硬）——工具列表是前缀的一部分，所以 Cursor 在工具目录变化时要专门注入
`<system_reminder>The tool list for <servers> changed earlier in this turn…</system_reminder>`
（`lar:95394`），MCP 认证明确禁止并行（`lar:98706`），Moss 的揭示 sticky——三件事同一原因：
**工具列表抖动是昂贵事件**。

**代价与反例**：① 懒加载把"一次 schema 成本"换成"一次额外往返"，3 轮以内的小任务是纯亏；
② 懒加载的前提是模型**知道自己不知道**；若模型裸调未揭示工具会拿 unknown-tool 错误，
所以延迟揭示必须配"错误文案教你去 search"（CC 有 `searchHint`，Moss 有
`deferredGroupFor()` 的 "load this first"）；③ 反例：工具面从不变化的会话里"一次给全"最省。

**对 Moss 的含义**：机制对但覆盖面只有 subagent 组：`device_*` 12 个 10,295 chars、
`task_*`/`record_*` 6 个 5,671 chars 常驻（`moss-baseline.md` §0.2/§3.4）。**但"隐藏"必须配
"能力可发现"**——只隐藏不揭示 = 模型不知道设备能力存在，比多付 2.6k token 更贵；而
`src/core/task/capability.ts` 的 goal→能力打分已经在，缺的是接到揭示路径。

### M4 为什么工具描述要写"何时用/何时不用/示例/目标目录"，以及 full/lean 两套

**做法** `[obs]` Cursor 四种范式并存：`semantic_search`（When to Use / When NOT to Use /
Examples 含 BAD 例 / Target Directories / Search Strategy，`lar:166835`）、`Grep`（逐条 usage +
截断语义，`lar:162868`）、`Write`（**同一工具按 promptVersion 从 1 句到 6 条**，
`lar:158963-158986`）、安全分类器专用 Read（"Do not use local file reads to learn general project
context…"，`lar:177440`）。CC：`fO({model, leanPrompt})` 选长/短版（串 `leanPrompt`，`bundle:L86882`）。

**在优化什么** `[inf]`：① **把"选择策略"与"接口定义"分开**——schema 只能表达"参数是什么"，
不能表达"什么时候别用我"；缺后者的直接后果是拿 grep 读文件、拿 write 建文档；
② **负例要放在必读且不衰减的位置**——description 在工具定义里，每轮必读；写进 prompt 某段会漂移。
所以"用 description 买正确率"是最便宜的杠杆：**零额外轮次、改动局部**；
③ **lean 档给弱模型/子代理**——长描述对强模型是信息、对弱模型是噪声（指令跟随容量有限）；
CC 的 `leanPrompt` 与 Cursor 的 `reducedSystemPrompt` 是同一假设的两处实现。

**代价与反例**：① 描述越长越易与实现漂移（Cursor 把它乘以 12 个模型分支）；
② 反例：Moss 的 `device_deploy`(910)/`device_exec`(950) chars 已近可读性上限，再堆会变噪声；
③ 反例：**描述不能替代权限**——Cursor 明确把只读/变更分级放在审批层（result case + sandbox
policy），description 只做引导（`cursor-evidence.md` §B.5）。"在 description 里声明只读"可被诱导。

**对 Moss 的含义**：description 密度已高于 CC 平均（`moss-baseline.md` §2.1），缺的是**结构化的
否定段与跨工具路由**（现在靠一句话堆叠，如 `edit_file` 的 5 句）。这是最便宜的回合节省：
一句"不要用 X 做 Y，改用 Z"能省掉一次错误调用 + 一次 nudge 往返。

### M5 为什么错误/拒绝文案要写成教学句

**做法** `[obs]` CC：`Output too large (…). Full output saved to: <path>` + first/last 预览
（`claude-evidence.md` §C2）；`Edit` 失败分 `noop|ambiguous|not_found` 并给修复动作（§B2）；
`a denied call means the user declined it — adjust, don't retry verbatim`（`bundle:L92246`）；
MCP 被策略禁止返回 `Tool '<x>' is not permitted`。Cursor：bash 失败映射里有一支
`void 0: "action was not executed"`（`lar:163860-163888`），与真失败/超时/被拒分开；错误文案双通道
`clientVisibleErrorMessage`/`modelVisibleErrorMessage`（`lar:78955`）；截断回填带
`Use offset=N to see more`（`lar:162240`）。

**在优化什么** `[inf]`：① **回合经济**——文案决定下一步，一句"重试"换来一整个往返（含全量前缀
重发），一句"改用 X"把同样的信息放进**已经付过费的 tool result** 里：错误文案是"零边际成本的
提示词"；② **安全**——拒绝若不携带"这是用户意志"，模型最自然的反应是换工具达成同样效果
（换 shell、换写入方式），即"目标不变、路径绕行"；③ **信任**——双通道文案说明"给模型看"与
"给人看"是两种产品文案，混用会让用户看到内部术语。

**代价与反例**：① 教学句必须与真实能力一致：写了"Full output saved to: <path>"却没有可读路径，
模型会去读不存在的文件，变成新的幻觉源；② 反例：**机制已结构性防住时，文案是冗余的**——
Moss 的 loop-guard 已对同签名重复调用短路（`src/core/tools/tool-loop-guard.ts:79`），
"不要原样重试"对完全相同的调用几乎无增量；真正的增量在"换路径绕行"（Moss 也已有跨工具逃逸
封堵，`tool-loop-guard.ts:1029-1052`）。③ 反例：headless 下"询问用户"不可能，文案必须分叉。

**对 Moss 的含义**：见 §3.1——当前 P0-3 与上游策略文案**互相矛盾**，是本次分析里唯一
"已落地但会产生新错误"的一项。

### M6 为什么项目指令是分层 Markdown 文件而不是向量记忆

**做法** `[obs]` Cursor：`.cursor/rules` 四类（global / agentRequestable / userRules / skills，
`lar:118051-118090`）+ `AGENTS.md` 一等概念（`lar:111298`）+ 三层优先级明文（"ALWAYS follow
system prompt instructions over conflicting AGENTS.md instructions"，`lar:105484`）。CC：
`user/project/project-alt/local/other` + 祖先链与嵌套目录（`claude-evidence.md` §A5/D1）+
managed-policy CLAUDE.md。Moss：祖先链 + 双文件名 + 32/48KB（`src/cli/project-instructions.ts`）。

**在优化什么** `[inf]`：① **可审查/可 diff/可 review**——记忆一旦变成"模型自动沉淀的向量块"，
没人能审它，而它会以"事实"身份出现在每个会话；企业客户买的是"我能看到什么指令在生效"；
② **可缓存**——文件是字节，字节稳定 → 可进稳定前缀；向量检索结果每次不同，天然破坏前缀稳定；
③ **可管控/可归责**——Cursor 给不同来源不同效力措辞（`user_rules` 的 description 是
"follow **if appropriate**"，`lar:117433`），CC 有 managed-policy 与"第三方文本不能修改
CLAUDE.md"（`claude-evidence.md` §F3）：解决"谁的指令优先、谁负责"；
④ **作用域**——CC 的 nested CLAUDE.md 只作用于其子树，目的是**降低无关指令的注意力污染**，
不只是"多加载几个文件"。

**代价与反例**：① 纯文件方案没有自动拾取能力，用户得自己记得写；Cursor 的补法是让 agent 自己往
AGENTS.md 追加固定小节（`lar:104959`），但这把写入权交给了模型；② 反例：**目录层级 ≠ 相关性**——
monorepo 里子包 CLAUDE.md 对根目录任务可能是噪声；CC 用文件级作用域缓解，Moss 用祖先链
**全部装入**，是拿注意力换完整性。

**对 Moss 的含义**：P0-2 修掉了真实自伤（本仓库 25KB AGENTS.md 曾被截 9KB），但它抄的是
"文件数量"，没抄"**激活类别与作用域**"——而那才是分层的理由（§3.3）。

### M7 为什么压缩要"结构化 summary + 确定性兜底 + 历史不可改写"

**做法** `[obs]` Cursor：10 节结构化 summary（`lar:67870`）+ `deterministicFallbackWindowRatio=0.02`
（`lar:67205`）+ 摘要最多重试 3 次并逐次 `requestShorterOutput`（`lar:67235`）+ 两条防污染规则
（只认 user-role turn；安全约束 **verbatim** 保留）+ 压缩段渲染为
`# HISTORICAL -- DO NOT EDIT … Use read_file or grep to look up details, but do not modify.`
（`lar:63784-64057`）。CC：`effective_window − summary buffer = threshold` 显式状态
（`claude-evidence.md` §C3）、九段模板、`capped` 限 2000 词、`keepEarlierAsks` 保留旧摘要中的
用户诉求。Moss：5 档压缩 + 更细的中文摘要契约（10 节、事实强度分级、字面量保留、增量更新不静默
删除，`src/context/compaction-prompts.ts:19-88`）+ 确定性兜底 + 多段合并带免责声明
（`src/context/summary-checkpoint-merge.ts:5-52`）。

**在优化什么** `[inf]`：① **上下文经济学**——压缩收益是"每轮少发 T 个 token"，成本是"丢失的信息
以错误形式回来"；所以最优解不是"更好的摘要"，而是**上下文留索引、细节留磁盘**，Cursor 的
`HISTORICAL` 段就是这个：摘要给不了细节，但给出**取回细节的地址**，把"有损压缩"变成"可回溯的有损"；
② **确定性兜底是可用性而非质量**——LLM 摘要会失败/限流/超时，2% 窗口保证最坏情况仍能跑；
③ **`DO NOT EDIT` 防的是漂移累积**——否则下次压缩会再摘要上次的摘要，模型还能"顺手修正"历史，
错误随压缩次数单调放大；④ **verbatim 保留安全约束**——约束丢失是安全回归，不是质量问题。

**代价与反例**：① 结构化节标题本身占 token（10 个标题 ≈100 token/次），模型还可能"填满格式"
而不填内容；② 反例：短会话（<10 轮）压缩从不触发，这套设计是纯维护成本；③ 反例：
**Moss 的契约比两家都细（优势），但没有机器校验**——节标题是否齐全、字面量是否保留全靠自律；
同一问题域里 Task runtime 用了状态机 + verdict provider（硬结构），压缩这里却是软约束。

**对 Moss 的含义**：这是"抄了一半"的典型：抄了"结构化契约"（且抄得更好），没抄"可回溯"
（Cursor 的 historical segment）与"可校验"（节标题检查）。见 §4 第 3 项。

### M8 为什么子代理要上下文隔离，还要三种恢复语义

**做法** `[obs]` CC：子代理独立身份（"You are an agent for Claude Code…"）、`cwd` 每次 bash 调用
重置 → 要求绝对路径、**父代理消息不等于用户授权**、不同 agent 类型有不同 strengths
（`claude-evidence.md` §D5）；恢复语义由 CLI 参数决定：`-r/--resume`/`--from-pr` → resume、
`-c/--continue` → continue、否则 fresh（`lAr`，`bundle.js:83514`）。Moss：scope 即工具白名单
（`src/core/subagent/spawn-profile.ts:74-110`）、强制剔除递归工具、可 worktree 隔离、
父 stable 继承 + dynamic 替换（`moss-baseline.md` §5.3）。

**在优化什么** `[inf]`：① **上下文隔离 = 成本隔离 + 注意力隔离**——子代理的全部价值是"父上下文
不再增长"，共享上下文时多开子代理只是多付 token；② **三种恢复语义对应三种意图**：fresh=重做
（干净）、continue=接着上次会话（**复用前缀缓存，最便宜**）、resume=恢复到某具体会话（可复现）。
**经济上 continue 是"把缓存命中当产品功能卖"**：用户按一次回车就省掉重发整个上下文；
③ **父消息不等于授权**——多代理系统最易被忽略的提权路径：父代理是"另一个模型"，它的文本没有
用户权威；CC 写成硬约束，Moss 只做了工具白名单（防"能做什么"，没防"谁批准的"）。

**代价与反例**：① 隔离的代价是信息只能经文本传递，所以子代理必须被强制"以摘要结尾"
（Moss `spawn-profile.ts:133-146`），否则父代理拿到空；② 反例：恢复语义带来状态管理复杂度
（会话文件、并发、stale）；Moss 当前"跑完即弃"在小任务上更简单，且 scope 白名单已防递归。

**对 Moss 的含义**：`resume/continue/fresh` 对 Moss 的价值**不在子代理而在主会话**——它是
"把缓存命中做成用户可见功能"的最短路径。Moss 有 `JsonlSessionStore` 却没把"继续上次会话"做成
显式产品动作；这一项排 §4 第 6 位（有价值但不进前 5）。

### M9 为什么 skills/commands/agents/output-styles 做渐进披露

**做法** `[obs]` CC：`skill_listing` 只注入"名字 + 描述"，正文由 `Skill` 工具读；`dynamic_skill`
支持会话中途发现新技能**且有边界校验**（`skillDir.startsWith(root)` + 名字正则，
`claude-evidence.md` §D4）；`output_style` 每轮只注入一句 `${style} output style is active.
${turnReminder}`（串 `output_style`，`bundle:L93083` 附近）。Cursor：skills 渲染返回预算与裁剪
统计（`renderedEstimatedTokens/uncappedEstimatedTokens/omittedSkillCount/strategy`，
`lar:116294/117195`）。Moss：`- name: description (when: ...)` 索引 ≈40 token/skill，正文
≤24,000 chars 按需加载（`moss-baseline.md` §5.2）。

**在优化什么** `[inf]`：① **注意力预算**——40 个 skill 正文可能 100k token，一次会话用 1–2 个；
索引化的本质是"用 40 token 换一次检索机会"；② **裁剪必须可观测**——Cursor 返回
`omittedSkillCount/strategy`，因为静默裁剪 = 模型不知道有能力存在 = 能力形同虚设；
③ **运行时新增是注入面**——`dynamic_skill` 的路径/名字校验说明"会话中途出现的新技能"可能是
恶意进程写入的。

**代价与反例**：① 多一次往返；"几乎每次都要用"的能力（如 rdk-docs 手册）索引化是纯亏；
② 反例：Moss 的 skills 索引**没有自动匹配**（G8），完全靠模型读索引自己判断，而 Cursor 的 rules
有 glob 自动挂载——索引化的收益依赖"模型会去查"，弱模型经常不查。

**对 Moss 的含义**：机制在，缺"匹配"。而匹配能力已在仓库里（`src/core/task/capability.ts`），
只是没接到 chat 路径——"能力已在、接线缺失"，成本低。

### M10 为什么 MCP 要统一命名空间 + 每 server 懒加载 + toolPolicy

**做法** `[obs]` CC：`mcp__server__tool`（`bundle:L83450`），并维护**双向映射**（retired 别名、
`-a<8hex>` 去重、`wireByInternal/internalByWire`，`claude-evidence.md` §E2），还占用了保留名
`mcp__workspace__bash`/`mcp__workspace__web_fetch`。Cursor：命名是 `${serverIdentifier}:${toolName}`
（**冒号**，`lar:96048`），有 MCP 元工具（`get_mcp_tools`/`call_mcp_tool`）与 server 级 env 白名单
（只透传 6/13 个变量，过滤 `BASH_FUNC_*`，`cursor-evidence.md` §D.1）；`toolPolicy` 命中返回
`Tool '<u>' is not permitted`。Moss：`mcp__<server>__<tool>`，>64 chars 截断加 hash8，
**故意不声明 sideEffectClass** → 全部走审批（`src/core/mcp/registry.ts:1-14/107-117`）。

**在优化什么** `[inf]`：① **命名是契约不是内部标识**——用户会在 permissions 规则里写
`mcp__github__*`，改名等于破坏用户配置，所以 CC 需要 retired 名单与双向映射（兼容成本显式记账）；
② **分隔符由传输层决定**——provider 工具名约束 `[a-zA-Z0-9_-]`（`registry.ts:31-33`），冒号不合法
→ CC/Moss 用 `__`，Cursor 走自有 protobuf 所以冒号可行：**风格差异是约束差异，不是品味差异**；
③ **MCP 是不可信能力提供方**——描述截断、env 白名单、默认全审批、`arguments_repaired` 四条防御
指向同一前提：server 提供的是"工具"不是"指令"；④ **懒加载把供应商目录成本摊到按需**——
50 工具全量广告就是 50 份 schema，索引化后 ≈1 行。

**代价与反例**：① 懒加载 + 审批叠加 = headless 可能**完全不可用**（Moss G4：MCP 不声明
sideEffectClass → 默认 `local_write` → 需审批 → headless 拒绝，`src/cli/approval.ts:260/518`）：
**两个正确的安全决定叠加成一个功能缺陷**；② 反例：per-server 一个 search 元工具意味着
**N 个 server = N 个元工具**，CC 用一个统一 ToolSearch 跨 server 检索，N 大时 Moss 的形状线性变差。

**对 Moss 的含义**：形状对、安全默认对；问题在 (a) headless 可用性（需真实探测），
(b) 元工具数量线性增长，(c) 首调用挂宽松 schema（`registry.ts:1-14`）用"一次可能失败的盲调"
换 schema 节省，在 headless 下可能不划算。

### M11 为什么按模型给不同 prompt 变体

**做法** `[obs]` Cursor：`promptVersion` 分支（`dsv3-1018` 6 条规则 vs `cursor-0226` 一句话，
`lar:158963-158986`）、12 个模型布尔、身份句按模型变（`lar:108354`）。CC：`leanPrompt` +
`fO({model, leanPrompt})`（`bundle:L86882`）、身份常量三变体（CLI / Agent SDK / 通用，
`bundle.js:88185`）。

**在优化什么** `[inf]`：① **指令跟随容量不同**——同一段"6 条 usage"对强模型是约束、对弱模型是
噪声（只执行最后一条或平均化），所以**更短的指令对弱模型反而更准**；② **评测驱动的超参**——
`promptVersion` 带日期（`cursor-0226`/`dsv3-1018`）说明它是"针对某模型版本标定过的文本"，
不是通用最佳实践；③ **缓存代价**——不同变体 = 不同前缀 = 不共享缓存；Cursor 接受，因为每个模型
本来就在不同 provider/缓存域；但这也意味着**变体数量有成本上限**。

**代价与反例**：① 维护成本爆炸（12 分支 × N 工具，`Uae` 已经 60 个 section 条件）；
② 反例：Moss 的立场是"统一 quick 版 + nudge 兜底"（`agent-behavior-prompt.ts:56-62`），
在模型族固定时更省维护；只有"能力差异大到无法共享一套文本"时分档才值得。

**对 Moss 的含义**：不建议现在做 per-model 变体（维护成本 > 收益，且无 prompt 级评测基础设施）。
但**应该做两档**：`quick` 已有（stable 侧），缺的是**工具 description 的 lean 档给子代理用**
（子代理不需要完整 usage 手册）。这是 CC 唯一一个我认为值得立刻抄的变体维度。

### M12 为什么 plan 模式是"只读 + 产出计划 + 用户批准"而不是直接干

**做法** `[obs]` CC 的 plan 附件是"**前导 + 正文 + 协议尾**"三段式：前导是只读强制
（`byt()`，`bundle:L93780`）；正文是 5 阶段工作流，末阶段"把计划写进 plan file（唯一可编辑文件）"，
模板要求 Context / 只写推荐方案 / 点出关键文件 / 复用已有设施 / **验证小节**（同段 `_Ns`）；
协议尾是"本轮只能以 AskUserQuestion 或 ExitPlanMode 结束，禁止用文本问'这样行吗'"（`wyt()`）。
审批是 `ExitPlanMode` + `plan_approval_response`，**绑定 requestId**，不匹配则回
"The team lead's verdict was for a different request, not this plan. Call ExitPlanMode again"
（`bundle:L89774-89776`）；子代理**不能**请求批准（`bundle:L96377`）；还有"用户自己改模式才能
离开 plan"的产品变体（`kNs`，同段）。自定义 workflow 会替换正文但保留"只读前导 + 协议尾"
（schema 描述，`bundle:L84053`）。Cursor：plan 下"只能编辑 markdown"（`lar:99281-99305`）+
每轮 reminder + `create_plan`/`switch_mode` 工具（`cursor-evidence.md` §B.1）。
Moss：`PLAN_MODE_PROMPT`（~1.1KB：只读契约 + 计划结构 + 不声称完成 + 切模式提示），
审批层 class-level deny（`src/cli/permission-rules.ts:427-431`）。

**在优化什么** `[inf]`：① **可逆性/爆炸半径**——这是 CC 明文判据："本地可逆的可直接做，难以逆转
或影响共享系统的要先确认"（`claude-evidence.md` §A2）；plan 模式把这条判据**产品化**：
先对齐意图再花 token 执行，因为成本不对称（暂停确认=几秒；做错=丢工作/误发/删分支）；
② **信任成本**——用户批准的是**具体 artifact**（plan 文件/审批卡）而不是"一段对话的意思"；
审批绑定 requestId 说明设计者认为"批准必须绑定被批准的那个版本"，否则模型可以"先批 A 再执行 B"；
③ **评测/质量**——"验证小节"是硬要求，等于把执行前的验收标准提前写下来，与 Moss 的 acceptance
criteria 同源（`src/contracts/task-runtime.ts`）。

**代价与反例**：① 多一轮交互 = 多一轮 token + 一次等待；"一句话就能做完"的任务上 plan 是净损失
（CC 的稀疏 reminder 与"用户改模式"变体都是对此的让步）；② 反例：**只读强制可以完全由审批层
完成**（Moss 就是这样），提示词层的增量价值是"让模型不做无效尝试"，所以它的收益必须用
"plan 模式下无效工具调用次数"来证明——而这一点**未量化**（`docs/specs/…-p0.md` §5.4）；
③ 反例：若"批准"没有 artifact 承载（只是口头"可以"），模型会把"沉默"当批准。

**对 Moss 的含义**：P0-1 是**正确且便宜**的一步，但止步于"少动手"，没有"产出可审批物 + 结束协议"。
`exit_plan` 只在 `MOSS_PLAN_GATE=1` 时注册（`src/core/tools/plan-gate.ts:10`），所以默认 plan 模式
里模型**没有合法的"提交计划"动作**，只能以散文结尾。这不一定是 bug（CC 也有"用户改模式"变体），
但"批准绑定版本"这条能力目前缺失。

---

## 3. Moss 对照：抄了形状没抄原因 / 在错误的前提下做对的事

> 只列能落到文件/行为的项，按"是否已经产生错误"排序。

### 3.1 拒绝语义：在字符串层追加，与上游策略文案自相矛盾 `[obs]`

P0-3 在 `deniedToolResultText()` 里追加"不要原样重试"（`src/core/tools/execute-tool-call.ts:43-57`），
但 plan 模式的拒绝文案来自另一处：决策 `block` + reason `plan mode: code exploration and planning
only`（`src/cli/permission-rules.ts:427-431`）→ 组装成 `Tool "x" is blocked (…). Switch to
"manual"… Then run "x" again.`（`src/cli/approval.ts:1359-1366`）→ 最终进模型的字符串是这句 **+**
`Do not retry this call unchanged; adjust the request…`。

**同一 tool result 里同时写着"Then run it again"和"Do not retry this call unchanged"**。这不是
文案瑕疵，是**语义分层错了**：拒绝有四种来源（用户拒绝/模式拦截/策略与保护路径/headless 无法授权），
正确下一步完全不同——用户拒绝要"改请求或问人"，模式拦截要"切模式再来"，策略拦截要"别绕路"，
headless 要"改方案，没有人可问"；塞进一个格式化器必然出现互相矛盾的组合。抄到的形状是 CC 那句话，
没抄的原因是：CC 的 `denied` 只有一个来源（权限系统，默认代表用户），一句话就够；Moss 的拒绝是四种
事件，必须**在决策点携带语义**。代价：模型收到"切模式后再跑"+"不要原样重试"时，最可能先试别的
工具——正好是 Moss 想避免的绕行。

### 3.2 缓存度量：在错误的前提下做对的事 `[obs]`

机制对：稳定块 `cache_control`（`src/provider/pi-ai-adapter.ts:66-80`）+ 滚动尾断点
（`pi-ai-http-transport.ts:836-852`）+ 前缀/工具顺序检查（`src/core/llm/prompt-prefix-cache.ts:128-180`，
在 `agent-loop-context-prep.ts:418-459` 调用）。度量错：`assessPromptCacheEligibility` 用
`stable ≥ 2048 chars 且 dynamic/stable ≤ 25%` 判"eligible"（`prompt-prefix-cache.ts:33-34`），
而这个判定**只写进 `run_metrics`、不改变任何行为**（`agent-loop.ts:774-808`）；"dynamic 占比 ≤25%"
是 **ROI 代理**（你在重付多少上下文），不是**缓存资格**（前缀稳定就能命中）。两者混在一个字段里，
直接导致 README §1.3 那场"G1 是否成立"的自我纠正——争的是阈值，不是机制。
另一处脱节：per-layer hash 已实现（`src/prompts/system-prompt-telemetry.ts:3-30`，还导进了 SDK
公共面 `src/index.ts:23-25`），但 loop 调用时传空数组（`agent-loop.ts:795` 的
`hashSystemPromptForTelemetry(activeSystemPrompt, [])`）。CC 每块上报 `{length,hash}` 的意义正是
"缓存掉了能归因到哪一段"（`bundle:L88191`）；Moss 现在只能回答"整个 prompt 变了"。
反例：若 provider 的 cache-hit 价极便宜，这套 ROI 指标的经济含义整体缩水，只剩"前缀稳定 = 延迟稳定"。

### 3.3 项目指令：抄了"多文件/祖先链"，没抄"作用域与注意力" `[obs]`

已做对：祖先链 + 双文件名 + 双上限 + 可见截断（`src/cli/project-instructions.ts:15-30`），修掉了
"本仓库 25KB AGENTS.md 被截 9KB"的自伤。没抄的原因：Cursor 四类的**目的**是"哪些指令在什么时候
生效"（`lar:118051`），CC nested CLAUDE.md 的**目的**是"只作用于其子树"；Moss v2 把祖先链
**全部装入 stable**，于是分层只剩"更全"没有"更少"——指令预算随仓库线性上升，每条指令注意力权重
相同。后果可验证：`README.md` §7.3 记录 stable 前缀从 ~5.5k 涨到 ~8k token；
这在缓存命中时廉价，但**注意力成本不因缓存而下降**。反例：目标用户若是"单仓库单作者"，
全量装入最简单且不会漏，作用域分层只有在大仓库/多团队时才回本。

### 3.4 压缩：契约比两家都细，但少了"可回溯"与"可校验" `[obs]`

已做对：10 节中文摘要契约 + 事实强度分级 + 字面量保留 + 增量不静默删除
（`src/context/compaction-prompts.ts:19-88`）+ 确定性兜底 + 多段合并带免责声明。少的一半：
① **可回溯**——Cursor 把旧段写成 `# HISTORICAL -- DO NOT EDIT` 的**可再读文件**
（`lar:63784-64057`），context 只留 curated summary；Moss 压缩后旧内容不进任何可检索工件
（`.moss/` 只有 tasks/evidence，没有 transcript 段）；
② **可校验**——摘要产物没有任何解析/校验（G7），"节标题齐全""字面量保留"全靠模型自律。
反例：Moss 的会话已是 JSONL 持久化（`src/core/session/`），"把旧段落成文件"的存储基础已有，
缺的只是"指向它"的引用格式与"不可编辑"约定。

### 3.5 nudge：把 prose 的成本转移到轮次上 `[obs]`

29 个 nudge id（`src/core/loop/nudges/disable.ts:19-40`），每条都是"模型做错了 → 注入纠正"
→ **一次额外 LLM 往返**（含全量前缀重发）。对照：Cursor/CC 把同类约束写在**工具 description**
或**每轮 reminder**里，那是"已在上下文里的零边际成本位"。Moss 的 quick prompt 省下的 prose
（~2.5k token/轮）被转移到 nudge 轮次上，而两者之间没有量化对照（`moss-baseline.md` §6 G6，
`bench:ab` 只覆盖 best-of-n/reasoning-high/model-routing）。反例：nudge 是**条件触发**、prose 是
**每轮必付**；若 nudge 触发率低于 ~1 次/10 轮，这个交换是赚的。**这是"需要测量而不是需要判断"的
问题**（§5.2 第 3 条）。

### 3.6 经验库：在"memory 冻结"下做对的事，但形态违背了冻结的理由 `[obs]`

`buildExperienceBlock()` 在首轮按用户消息检索工作区经验并拼进 `extraContext`
（`src/core/agent/moss-agent.ts:1086-1090`，`src/core/experience/`）——memory 冻结下最合理的替身
（作用域=工作区、只读回灌、不自动跨会话）。但它违背了"可审查 Markdown"这条原因：经验库是
**自动积累 + 自动回灌**，用户看不到"这次注入了哪些历史结论"，也无法 diff。Cursor/CC 在同类问题上
都选"文件 + 显式写入通道"（Cursor 让 cloud agent 往 AGENTS.md 追加固定小节，`lar:104959`；
CC 的记忆写工具带审批与 `if_version`，`claude-evidence.md` §D2）。这不是要新建 memory 子系统
（冻结决策不变），而是"读路径先可审查"。

### 3.7 形状对但收益被抵销的两处 `[obs]`

- **deferred sticky**（`src/core/tools/deferred-tool-offer.ts:1-5`）：sticky 的**原因是对的**（工具列表抖动 = 前缀失效 + 重新认识工具面），但它意味着长会话里工具列表只增不减，与"省 token"相悖。
  CC 的解法是 `searchHint` + 按需注入，不是"永久揭示"。
- **MCP 首调用宽松 schema**（`src/core/mcp/registry.ts:1-14`）：用"一次盲调"换 schema 节省；交互模式划算（失败后下一轮就有真 schema），headless 里一次失败可能就是一次 turn 的浪费。

---

## 4. 如果 Moss 只能改 5 处

**排序规则**（先写规则再排，避免"按感觉排"）：① 先修"已上线但会引发新错误"的（确定性缺陷，
成本最低，不修就是负资产）；② 再修"每请求都付的税"（复利 = 轮数 × 每轮）；③ 再修"长会话的
质量地板"（robotics 闭环典型几十轮，压缩是必经路径）；④ 最后修"能力可发现性/可用性"
（收益可能最大但需前置探测，所以排后）。

| #   | 改什么                                  | 为什么在这个位置                                                  | 成本                                       | 验收方式（非静态）                                |
| --- | --------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------- |
| 1   | 拒绝语义四分类 + 单源化（把 P0-3 做完） | 当前文案自相矛盾（§3.1），是**新增缺陷**；改动面小                | 低（决策点带 tag + 4 条文案）              | `-p` 四种拒绝各跑一次，断言最终字符串只含一种处置 |
| 2   | 工具面按工作区能力揭示 + sticky 可回收  | 每轮最大单项税（`device_*` 2.6k + `task_*` 1.4k token），复利     | 中（接 `capability.ts`、改 deferred 策略） | 同会话前后工具数变化；`bench` 对照 `errors/turn`  |
| 3   | 压缩可回溯 + 节标题机器校验             | 长任务质量地板；存储基础（JSONL）已有                             | 中（落盘段 + 引用格式 + 校验器）           | 压缩一次后按摘要里的引用读回原文；缺节标题则报错  |
| 4   | 工具 description 的否定段 + 跨工具路由  | 最便宜的回合节省：零额外轮次、改动局部                            | 低（改字符串）                             | `bench` 统计误选工具次数（如 `read`-for-`grep`）  |
| 5   | MCP headless 审批探测 → 只读白名单      | 若成立则是**主路径阻断**（rdk-docs 是产品知识入口），但**未验证** | 极低（先做 5 分钟真实 `-p` 探测）          | `moss -p` 调一次 `rdk-docs` 只读工具的日志        |

**对 Lead 三项 P0 的评价**：

- **P0-1 plan 提示词层：保留**。便宜、已验证到达模型、且改变行为（`docs/specs/…-p0.md` §5.3）。但别把"plan 提示词"当成 plan 模式做完了：缺"结束协议"与"批准绑定版本"（M12）。
- **P0-2 项目指令 v2：保留，但把"32/48KB"定位为过渡**。真正的原因是作用域（§3.3）：调大上限解决的是"本仓库自伤"，不解决"指令预算随仓库线性增长"。下一刀应是**激活类别**
  （always/路径命中/模型自取），不是更大的 cap。
- **P0-3 拒绝语义：保留但必须补完**。按现在的形状它已经产生矛盾（§3.1），所以是**半成品**。这一项排第 1 不是因为它最重要，而是因为它**最便宜且现在是负的**。

**被这份排序否掉/压后的项**：① **加长 stable prompt**（用 behavior/domain full）——`[inf]` 三家里
最不该抄的动作：Moss 的 quick 立场有明确理由（`agent-behavior-prompt.ts:56-62`），CC/Cursor 的"长"是
给**强模型**的（lean 变体证明它们也承认长文本对小模型有害）；② **自动记忆（memory 解冻）**——与冻结
决策冲突，且成本（不可审查的事实注入）高于收益；③ **per-model prompt 变体**（M11）——维护成本 ×12
且无 prompt 级评测基础设施，唯一值得做的是"子代理 lean 描述"；④ **Cursor 的 1M 上下文话术 /
200 次工具调用承诺**——`[inf]` 那是"反提前收尾"的心理设计，Moss 有 acceptance gate，
不需要用话术替代机制。

---

## 5. 未验证、反证与推测清单

### 5.1 `[unknown]`（明确没证据，不要当结论用）

1. **Cursor `reducedSystemPrompt` 的真实动机**：开关条件是 `compactShellDescription` flag + IDE/CLI +
   非 background + 非 local-agent，对 `computerUse` 强制（`lar:108342-108349`, `lar:175216`）。
   `[inf]` 我解释为"给小模型/受限 harness 的压缩档"，但**也可能只是 A/B 开关**；生产生效组合未知。
2. **CC `cacheScope:"global"` 的跨租户语义**：它变成 `cache_control: m7({scope,ttl})`
   （`bundle:L92678`），有 `scopeRefused` 回退与"tool-based cache"兜底（`bundle:L88185`）；
   `global` 的作用域边界（同 org？全产品？）与计费方式未知。
3. **auto-compact 的实际百分比阈值**（`claude-evidence.md` §C3 同样标 unknown）。
4. **Cursor 服务端是否覆盖 prompt 与 description**（`fallbackValues` 说明可覆盖，内容未知）。
5. **Moss G4（MCP 在 headless 下不可用）**：仍是代码推断（`src/cli/approval.ts:260/518`），未跑真实探测。
6. **plan 模式的行为收益**：只验证"提示词到达且模型自述遵守"，未量化无效工具调用下降多少。

### 5.2 反证清单（若成立，会推翻本文的优先级）

1. **若 Moss 的失败主要来自"没验证就宣布完成"而非"工具误选"**，则第 2/4 项收益低于 acceptance
   gate 的打磨（证据方向：`bench` 失败分类、`.moss/task-failures.jsonl` 分布）。
2. **若 provider 的 cache-hit 价接近 0**，则所有"前缀经济"论证的经济权重下降，排序应改为
   "按错误率与轮数"而不是"按 token"。
3. **若 nudge 触发率 < 1 次/10 轮**，则"quick prompt 把成本转移到 nudge"不成立，§3.5 作废。
   **这一条可用 `MOSS_DISABLE_NUDGES` 做 A/B 直接测。**
4. **若 plan 模式下无效调用占比 < 5%**，则 P0-1 的价值主要是体验而非成本，第 1 项应继续排第一。
5. **若 device 工具常驻并不引起误选**（description 路由已足够），隐藏它们的收益≈0，只剩 token
   收益——而 token 在缓存命中下是 0.1×。这会推翻第 2 项。
6. **若 Cursor 的 `pi_*` 一句话 description 在评测上不输长 description**，则 M4 的"描述密度带来
   正确率"被削弱（但"负例防误用"仍有独立理由）。

### 5.3 推断链与可证伪条件

| 推断                                      | 推导链                                                                     | 可证伪的观测                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| reminder 是因为缓存，不是"提示词更好"     | 模式可中途切换 → 换 system prompt 会重写前缀 → 实现是 user 附件 + 稀疏复述 | 若两家在模式切换时确实重写 system prompt，本推断作废         |
| 工具面收敛主要买"注意力/正确率"而非 token | 缓存命中后 schema 边际成本 0.1× → 但 N 增大仍降低选择准确率                | 缓存开启下增大工具集，若错误率不升，本推断作废               |
| 拒绝文案的价值在"绕行封堵"而非"重复封堵"  | Moss 已有 identical-call 短路与跨工具封堵 → 文案增量只剩"语义与下一步"     | 关闭 loop-guard 后测绕行率；若文案仍显著降低重试，本推断作废 |
| 压缩应"索引 + 落盘"而非"更好摘要"         | 摘要漂移随压缩次数单调放大；落盘提供无损回溯                               | 若长会话里模型几乎从不回读历史细节，落盘收益≈0               |
| 分层项目指令的理由是作用域                | Cursor 四类激活 / CC 子树作用域都指向"何时生效"                            | 若全部常驻后任务成功率不降，作用域分层是过度设计             |

### 5.4 方法论局限

全部结论来自**静态证据**（源码/字符串/实测字符数），没有运行时观测——没启动 Cursor/Claude Desktop，
也没跑 Moss 的 `-p`（纪律要求不 build/不 verify）。经济学数字是模型（`[inf]`），唯一有代码出处的
单价见 `src/context/tool-result-fold.ts:24-28`。CC 的 `bundle:L<n>` 是新换算的（在抽取产物中按字面量
搜索定位，每条括注原字符串，可复跑）；`claude-evidence.md` 的 `bundle.js:L:C` 可能相差若干行，
**以字符串为准**。本文刻意不写"建议加 XXX 提示词"这类动作：凡未落到"约束 → 必须满足 Y →
不能做 Z"的，一律归入 §5.1。
