# Cursor / Claude Desktop + Claude Code → Moss：agent 设计对照研究报告

- 日期：2026-11-04
- 目标产品：Moss（`@rdk-moss/agent@0.31.0`，本仓库，HEAD `36262014`）
- 对照产品：Cursor `3.27.14`（commit `69b724ebc67ec522c1b5d287a5025f7a7e81be90`）、
  Claude Desktop 内置 Claude Code `@anthropic-ai/claude-code@2.1.317`
- 方法：REA 6.5.0 逆向（`analyze-javascript-application` / `inspect-analysis-view` /
  `compare-application-versions`）+ 源码符号与格式化后源码切片；只读 `/Applications`，
  所有中间产物在 `/tmp`
- 配套文档：
  - [`moss-baseline.md`](./moss-baseline.md)：Moss 侧实测基线（441 行，全部数字可复跑）
  - [`cursor-evidence.md`](./cursor-evidence.md)：Cursor 证据（779 行，含 `lar:L<n>` 源码定位）
  - [`claude-evidence.md`](./claude-evidence.md)：Claude Desktop + Code 证据（502 行，含 bundle 行号）
  - [`../../specs/2026-11-04-moss-agent-design-p0.md`](../../specs/2026-11-04-moss-agent-design-p0.md)：
    P0 落地方案（已实现，含验收与实测记录）

---

## 0. 一页结论

1. **三家的差距不在"提示词更长"，而在结构**：Cursor 的 system prompt 是约 60 个 JSX
   组件按条件拼装（`cursor-evidence.md` §A.1）；Claude Code 把它切成"稳定矩阵 + 每轮附件"
   并用 `__SYSTEM_PROMPT_STATIC_BREAKPOINT__` 显式标缓存断点（`claude-evidence.md` §A1）；
   Moss 也已经分成 stable/dynamic 两段（`src/core/agent/moss-agent.ts:390`），**方向一致**，
   差距在"动态层用来表达什么"。
2. **模式（plan/ask/agent）是提示词的一等公民，而且用最后一层注入表达**。Cursor 每轮追加
   `<system_reminder>`，并写明 "This supersedes any other instructions"
   （`cursor-evidence.md` §A.3/A.4）；Claude Code 有独立的 plan 段与 per-turn
   `critical_system_reminder`。Moss 的 `plan` 只是权限模式，模型拿不到任何语义提示
   → 这是本次 P0-1 要补的第一块。
3. **工具元数据驱动行为，提示词只写"什么时候用"**。Claude Code 每个工具声明
   `isReadOnly` / `isConcurrencySafe` / `isDestructive` / `maxResultSizeChars`（常为 `1e5`），
   Cursor 用 `readonly`/可变两层 + 每工具 approval 语义；Moss 的 `sideEffectClass` 已经是同构设计
   （`src/core/tools/tool-types.ts:178`），**这一点 Moss 不落后**，落后的是工具 schema 的
   "描述分层"（CC 有 full/lean 两套 description）。
4. **工具列表本身就是最大的 token 税**：Moss 38 个可见工具 schema = 32,950 chars ≈ 8.2k tokens，
   而固定 prose 只 ~1.2k tokens（`moss-baseline.md` §0.2）。Cursor 走"少而精的
   `pi_*` 兼容层 + 工具搜索"，CC 走"MCP 懒加载 + ToolSearch"，Moss 只对 5 个 subagent 工具做了
   延迟揭示。
5. **项目指令（记忆的文件形态）是层级加载，不是单文件**。Cursor：`.cursor/rules` 四类
   （always / auto-attached / agent-requested / manual）+ `AGENTS.md` 一等概念
   （`cursor-evidence.md` §C.1/C.3）；CC：企业/用户/项目/子目录 `CLAUDE.md` + `AGENTS.md`
   - `MEMORY.md`（`claude-evidence.md` §A5/D1）。Moss 只读工作区根一个 `AGENTS.md`，
     16KB 截断——**本仓库自己的 25KB AGENTS.md 被丢掉 9KB**（`moss-baseline.md` §6 G5）。
6. **压缩摘要要"结构化到能当契约"**。Cursor 有 10 节结构化 summary + 2% 确定性兜底 +
   `# HISTORICAL -- DO NOT EDIT` 保护（`cursor-evidence.md` §C.5）；CC 有
   `effective_window − summary buffer = threshold` 的自动压缩与 9 节提示词
   （`claude-evidence.md` §C3）。Moss 的 5 档压缩已不弱（`moss-baseline.md` §4.1），
   但摘要产物是自由文本、无机器校验（G7），这是 P1。
7. **"拒绝"是一种语义，不是一种错误**。CC 的 `# Harness` 写明 "a denied call means the user
   declined it — adjust, don't retry verbatim"；Cursor 把 "action was not executed" 与真失败分开。
   Moss 只有一句 `Tool execution denied: …` → 模型最常见的反应是原样重试或换 shell 绕过，
   正好撞上 loop-guard。本次 P0-3 已补。
8. **渐进披露是所有家共同的省 token 手段**：Cursor 的 rules 四类 + 工具搜索；CC 的
   skills/commands/agents/output-styles 四类 + `skill_listing`/`dynamic_skill` 附件；
   Moss 已有 skills 索引 + 5 个 deferred 工具，但 `device_*`/`task_*`/`exec_*` 仍常驻（G2）。
9. **记忆的"写"路径被冻结是对的，但"读"路径可以马上变好**。Moss 的 memory 子系统按
   2026-09-30 决策维持冻结；本次不动它，而是把"记忆 = 可审查的 Markdown 文件"这条**读路径**
   （AGENTS.md / CLAUDE.md / 祖先目录）做对——这既是竞品共同做法，也符合仓库纪律。
10. **P0 已落地并真实验证**：计划模式提示词层、项目指令装载 v2（祖先链 + CLAUDE.md + 32KB/48KB）、
    拒绝语义。验证包括 14 项行为探针、4 次真实模型运行、`npm run verify` 全绿（23.1s）。

---

## 1. 方法与证据

### 1.1 工具链

| 项                | 值                                                                                                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| REA 版本          | 6.5.0（CLI，与 MCP server 同引擎）                                                                                |
| Node              | `/opt/homebrew/opt/node@22/bin/node` v22.22.3（REA doctor 不支持 v25）                                            |
| 本机 Swift 工具链 | 已损坏（`module.modulemap` 重复定义 `SwiftBridging`）；用 `/tmp/rea-clt` 干净副本 + `REA_DARWIN_SWIFTC_PATH` 绕过 |
| 产物              | `/tmp/rea-out/*.json`（5 份证据，最大 315MB）、`lar-pretty.js`、`claude-code-bundle.js`（53.8MB/120,439 行）      |

REA 的 JS 分析器**不保留字符串字面量**（只留函数/参数/绑定节点 + source range），所以所有提示词
原文引用都来自"证据节点 → 格式化源码切片"，行号形如 `lar:L99281`（`/tmp/rea-out/lar-pretty.js`）
或 `bundle.js:L:C`。这条限制本身也写进了报告：凡是无法落到源码范围的结论，一律标 `[unknown]`
不写。

### 1.2 证据强度约定

- `[obs]`：逆向直接观察到的代码/数据；可复跑。
- `[inf]`：由 `[obs]` 推导，标注推导链。
- 未验证项集中列在 §10，不在正文里伪装成结论。

### 1.3 一次重要的自我纠正

`moss-baseline.md` §6 G1 断言"dynamic ~17k chars vs stable 4.6k，前缀缓存永不 eligible"。
本次用真实 headless 会话重测（`buildFreshSessionContextReport`）：**stable 5,539 tok /
dynamic 367 tok / tools 3,753 tok**，`dynamic/stable ≈ 0.066 ≤ 0.25`，**缓存是 eligible 的**。
G1 的前半句（设计意图）成立，后半句（永不 eligible）作废。这条纠正也说明：
"读代码得到的比例"必须用真实会话的测量替换。

---

## 2. 提示词体系

### 2.1 Cursor：JSX 组件树 + 每轮 reminder

- 系统提示词由约 60 个 section 组件组成（`Uae()` 是组装器，`lar:108317`），条件开关包括
  模型（`modelName` / `promptVersion`）、模式、是否 agent、是否 CLI、是否 Web 等。
- 每个 section 有"短/长"两种写法：`reducedSystemPrompt` 是显式的压缩档位（`§A.2`）。
- 工具 description 有 **四种写作范式**并存：`When to Use This Tool` / `When NOT to Use` /
  `Examples` / `Target Directories`，且按 `promptVersion` 变体化——同一工具对 `dsv3-1018`
  给 6 条规则、对 `cursor-0226` 只给一句话（`§B.4`）。这是"同一能力的模型特化描述"，
  Moss 目前没有。
- 模式不是另一套 prompt，而是每轮追加 `<system_reminder>`（plan 模式有 guardrails 段，
  `lar:99281-99305`），并显式声明优先于其它指令（`lar:199897-199935`）。
- 输出格式约束与环境/记忆摘要都是独立 section，可被 `reducedSystemPrompt` 整体裁掉。

### 2.2 Claude Code：稳定矩阵 + 每轮附件

- `__SYSTEM_PROMPT_STATIC_BREAKPOINT__` 把提示词切成两块，`cacheScope` 分
  `global | org | session` 三档（`claude-evidence.md` §A1）。这是把"前缀缓存"从
  provider 行为变成产品显式设计。
- 节标题直接可读：`# Harness` / `# Tone and style` / `# Task Management` /
  `# Session-specific guidance` 等（`§A2`）。
- 每轮注入的附件（attachments）是第二套提示层：`output_style turnReminder`、
  `skill_listing`、`dynamic_skill`、`critical_system_reminder`（`§A3`）。
- `lean` 模式是同一提示词的压缩变体（`§A4`）——与 Cursor 的 `reducedSystemPrompt` 同构。
- `CLAUDE.md` 层级与预算明确写在提示里（`§A5`）。

### 2.3 Moss：stable/dynamic 二段 + 契约文件

- `composeSystemPrompt()` 返回 `{stable, dynamic, full}`（`src/core/agent/moss-agent.ts:390`）：
  stable = persona + 语言/领域/行为契约 + AGENTS.md；dynamic = 环境、日期、git、MCP、
  skills、上下文窗口、设备提示、计划模式层（本次新增）。
- quick/full 双档已经存在（behavior 3,187/10,011 chars；domain 937/6,247），CLI 默认走 quick。
- 每个 run 重新 `composeRunPrompt()`（`src/core/agent/moss-agent.ts:1064`），所以 dynamic 层
  在两次用户消息之间可以变化，stable 保持字节稳定。
- 实测：CLI 默认 stable 核心 4,631 chars ≈ 1.2k tok；完整 fresh 会话 stable 5,539 tok
  （含 AGENTS.md 与工具索引投影）。

**对照结论**：Moss 的"二段结构 + 契约文件 + quick/full"与两家同构，甚至更省（prose 只有 1.2k tok）。
真正缺的是"模式语义层"（P0-1 已补）与"按需揭示的工具面"（P1）。

### 2.4 提示词对照表

| 维度     | Cursor                                   | Claude Code                                       | Moss（本提交前 → 后）                                      |
| -------- | ---------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| 组装方式 | JSX section 树，~60 段，条件拼装         | 静态矩阵 + 每轮附件                               | 8 个固定块 + extra/dynamic 数组                            |
| 缓存断点 | 供应商缓存 + `reducedSystemPrompt` 档位  | 显式 `STATIC_BREAKPOINT` + 3 档 cacheScope        | stable/dynamic 二段（隐式）                                |
| 模式表达 | 每轮 `<system_reminder>`，声明最高优先   | plan 段 + `critical_system_reminder`              | **仅权限位 → 本次新增 `PLAN_MODE_PROMPT` 动态层**          |
| 模型特化 | 每工具 description 按 promptVersion 变体 | full/lean description                             | 无（P2）                                                   |
| 项目指令 | `.cursor/rules` 四类 + AGENTS.md         | 层级 CLAUDE.md/AGENTS.md + MEMORY.md              | 单文件 AGENTS.md 16KB → **祖先链 + CLAUDE.md + 32KB/48KB** |
| 渐进披露 | rules 四类 + 工具搜索                    | skills/commands/agents/output-styles + ToolSearch | skills 索引 + 5 个 deferred 工具                           |

---

## 3. 工具调用

### 3.1 schema 与描述

- Cursor：两代 schema 并存（自有 protobuf `ClientSideToolV2Call` 51 个工具 + Claude-Code 风格
  的 `pi_*` 兼容层），description 里带 `When to Use` / `When NOT to Use` / `Examples`
  （`§B.1-B.4`）。
- Claude Code：每个工具 description 有"full/lean"两套；错误信息本身就是自我修复指令
  （"Full output saved to: <path>" + head/tail 预览，`§B3`）。
- Moss：schema 用 JSON Schema + 双语 description，`sideEffectClass` 驱动审批/并行/重试
  （`moss-baseline.md` §2.2）。差距是：没有 description 变体，也没有"何时不要用"的显式否定段
  （部分工具在文案里写了，但不成体系）。

### 3.2 权限与审批

- Cursor：`readonly` vs 变更两层，工具级 approval 文案；`modelVisible` / `clientVisible`
  的错误拆分（`§F`）。
- Claude Code：权限规则语言（allow/ask/deny）+ plan/acceptEdits 模式（`§F1/F2`）。
- Moss：模式引擎（manual/acceptEdits/plan/full）+ 规则表 + 设备风险分级；**结构上已经对齐**，
  问题是 plan 模式缺提示词语义（本次补）与拒绝语义（本次补）。

### 3.3 并行、截断、重试

| 机制           | Cursor                                                 | Claude Code                                              | Moss                                              |
| -------------- | ------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------- |
| 并行 tool call | 支持（`§B.8`）                                         | 支持，读类工具并发安全标记（`§C1`）                      | `sideEffectClass` + `isParallelSafe`（已有）      |
| 结果截断       | bash 1e4 head/tail、Read 100,000 char 硬失败（`§B.7`） | 每工具 `maxResultSizeChars`（常 1e5）+ 落盘路径（`§C2`） | 输出 spill + 截断预算（已有）                     |
| 错误回填       | "action was not executed" 与失败分离                   | 错误文案即修复指令                                       | 本次补拒绝语义；普通错误已分 `start_failure` 等类 |

Moss 在"截断 + spill + 错误分类"上不落后；落后的是**工具数量本身**（8.2k tok schema）和
**错误文案的教学性**（P0-3 是第一步）。

### 3.4 工具面收敛（三家做法）

- Cursor：核心工具集精简，搜索/规则类工具按需拉取。
- Claude Code：MCP 工具名 `mcp__server__tool` + toolPolicy + 懒加载；ToolSearch 工具按需揭示。
- Moss：45 注册 / 38 可见；`device_*` 12 个 10,295 chars、`task_*` 3 个 2,507、
  `record_*` 3 个 3,164、`exec_*` 5 个 3,625、`fan_out_subagents` 1,983（实测）。
  **纯 coding 会话里 `device_*` 与 `task_*` 是持续税**——但设备闭环是 Moss 的产品定位，
  收敛必须"按工作区能力检测 + 渐进揭示"，不能简单删。这是 P1 的核心取舍。

---

## 4. 记忆与上下文

### 4.1 项目指令（记忆的文件形态）

|        | Cursor                                   | Claude Code                                 | Moss（后）                                      |
| ------ | ---------------------------------------- | ------------------------------------------- | ----------------------------------------------- |
| 文件名 | `.cursor/rules/*.mdc` + `AGENTS.md`      | `CLAUDE.md`、`CLAUDE.local.md`、`AGENTS.md` | `AGENTS.md`/`agents.md`/`CLAUDE.md`/`claude.md` |
| 层级   | 四类激活方式（always/auto/agent/manual） | 企业→用户→项目→子目录                       | 仓库根 → 祖先目录 → 工作区                      |
| 预算   | 未在证据中量化                           | 提示里写明层级与预算                        | 单文件 32KB、合计 48KB，超限显式提示            |
| 渲染   | 带来源标签的 rule 段                     | memory 段 + 来源                            | `[Project instructions — N files: …]` + 分节    |

Moss 的实现保留了"可审查 Markdown"这条底线（符合 memory 冻结决策），同时补上了竞品共同的
"祖先链 + 双文件名"。

### 4.2 会话内压缩

- Cursor：10 节结构化 summary（Goal / Constraints / Progress / Key decisions / Next steps /
  Critical context / Files / Errors / …）+ 2% 确定性兜底；摘要段落带 `# HISTORICAL -- DO NOT EDIT`
  保护，避免后续模型改写历史（`§C.5`）。
- Claude Code：`effective_window − summary buffer = 自动压缩阈值`；9 节提示词；压缩后保留
  "最近 N 条 + summary"（`§C3`）。
- Moss：5 档压缩（microcompact → prune → … → LLM summary），保留规则已细化到"工具结果按
  `retainResult` 折叠"（`moss-baseline.md` §4.1-4.3）。**档位设计不弱**，缺的是摘要产物的
  结构校验（G7）与"压缩不可逆"的保护（Cursor 的 DO NOT EDIT 段）。

### 4.3 跨会话记忆

- Cursor：跨会话记忆只给 Named Agent（`§C.6`）。
- Claude Code：`MEMORY.md` + `user/project/project-alt/local/other` 六类目录 + `auto/team/agent`
  写入者（`§D1/D2`）。
- Moss：**冻结**（`moss-baseline.md` §4.4）。本次不改；报告里给"读路径先做好"的路径
  （P0 已做），写路径留 P2 且必须先解冻决策。

### 4.4 渐进披露与子代理隔离

- Cursor：tools 搜索 + rules 四类。
- Claude Code：skills/commands/agents/output-styles 四类；子代理有独立上下文与
  `resume/continue/fresh` 三种恢复语义（`§D3/D4/D5`）。
- Moss：skills 索引（`name: description (when:)`）+ 5 个 deferred subagent 工具；子代理
  scope 与工具过滤已有（`moss-baseline.md` §5.3）。差距：skills 无自动匹配（G8）、
  deferred 揭示 sticky（G10）。

---

## 5. 十个可借鉴模式（含 Moss 落点与状态）

| #   | 模式                                     | 证据                                  | Moss 落点                                     | 状态               |
| --- | ---------------------------------------- | ------------------------------------- | --------------------------------------------- | ------------------ |
| 1   | 模式契约用"最后一层"注入，并声明最高优先 | Cursor §A.3/A.4；CC §A3               | `PLAN_MODE_PROMPT` + dynamic 层               | **已实现（P0-1）** |
| 2   | 项目指令按目录层级加载，多文件名         | Cursor §C.1/C.3；CC §A5/D1            | `project-instructions.ts` v2                  | **已实现（P0-2）** |
| 3   | 拒绝是决策不是错误：不要原样重试         | CC §B3；Cursor §F                     | `deniedToolResultText` 追加处置指引           | **已实现（P0-3）** |
| 4   | 工具 description 分 full/lean 两档       | CC §A4/B2；Cursor §A.2/B.4            | 工具注册表按模式给 lean 描述                  | P2                 |
| 5   | 结果截断落盘 + 路径回填                  | CC §C2；Cursor §B.7                   | 已有 spill，补"路径 + head/tail 预览"文案     | P1                 |
| 6   | 压缩摘要结构化 + 历史不可改写保护        | Cursor §C.5；CC §C3                   | `compaction-prompts` 增加节标题与 DO NOT EDIT | P1                 |
| 7   | 工具面按会话能力渐进揭示                 | Cursor §B.3；CC ToolSearch            | `device_*`/`task_*` 按工作区能力揭示          | P1                 |
| 8   | skills 按 goal 自动匹配                  | CC §D4；Moss `capability.ts` 已有打分 | chat 路径复用 capability 打分                 | P1                 |
| 9   | 每轮附件承载"本会话状态"                 | CC §A3                                | 把 turn-watch/上下文提示并入 dynamic 层       | P2                 |
| 10  | 子代理恢复语义 resume/continue/fresh     | CC §D3/D5                             | 与 `agents/*.md` 持久化结合                   | P2                 |

---

## 6. Moss 缺口清单（修正版）

> 原始清单见 `moss-baseline.md` §6；此处只保留未被本次 P0 覆盖的项，并标注修正。

| ID  | 缺口                                               | 影响                                               | 处理                                |
| --- | -------------------------------------------------- | -------------------------------------------------- | ----------------------------------- |
| G1  | ~~前缀缓存永不 eligible~~                          | **已证伪**：真实 fresh 会话 dynamic/stable ≈ 0.066 | 撤下                                |
| G2  | 工具 schema 占 87%，只 5 个 deferred               | 纯 coding 会话 ~5k tok 无效税                      | P1（按能力揭示）                    |
| G3  | ~~无 plan 提示词~~                                 | 模型在 plan 下只能靠被拒自我修正                   | **P0-1 已补**                       |
| G4  | MCP 工具默认全走审批，headless 可能不可用          | `rdk-docs` 在 `-p` 下需验证                        | P1（需真实 headless 探测后定方案）  |
| G5  | ~~AGENTS.md 单文件 16KB、不认 CLAUDE.md、不递归~~  | 本仓库自伤 9KB                                     | **P0-2 已补**（祖先链 + 32KB/48KB） |
| G6  | nudge 是事后补丁，quick prompt 与 nudge 无量化对照 | 多轮 LLM 成本                                      | P1（`bench:ab` 扩展覆盖）           |
| G7  | 压缩摘要无机器校验                                 | 摘要漂移无法发现                                   | P1（结构化节标题 + 校验）           |
| G8  | skills 无自动匹配                                  | 索引全量加载 + 模型自行判断                        | P1                                  |
| G9  | turn-watch 只看 mtime 与日期                       | 切分支/装依赖无感知                                | P2                                  |
| G10 | 子代理 window 错用父模型值；deferred sticky        | compaction 算错、工具面只增不减                    | P1/P2                               |

---

## 7. 已落地 P0（本提交）

详见 [`specs/2026-11-04-moss-agent-design-p0.md`](../../specs/2026-11-04-moss-agent-design-p0.md)。

### 7.1 改动清单

| 文件                                              | 改动                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/contracts/prompts/plan-mode-prompt.ts`（新） | `PLAN_MODE_PROMPT`：只读契约 + 计划结构 + 不声称完成 + 切模式提示（~1.1KB）                                                               |
| `src/cli/plan-mode-layer.ts`（新）                | `planModeLayer(mode)`：mode → 文本；槽位由同日 D3 的 `CliPromptLayers` 注册表按 id `mode:plan` 管理（原 `installPlanModeLayer` 已被替换） |
| `src/cli-main.ts`                                 | 安装计划层、启动同步、订阅 `subscribeCliInteractionMode`                                                                                  |
| `src/cli/project-instructions.ts`（重写）         | 祖先链（到 `.git` 根，≤12 层）+ `AGENTS.md/agents.md/CLAUDE.md/claude.md` + 32KB/48KB 双上限 + 可见截断/超预算提示                        |
| `src/core/tools/execute-tool-call.ts`             | 拒绝文案追加"下一步"话术（中英），保留前缀与 hook 原文透传；同日 D5 升级为四类拒绝语义（user/mode/policy/headless）                       |

### 7.2 真实验证（不是静态检查）

1. `npm run build` → PASS 7.7s / 9.1s（clean）。
2. 行为探针 `/tmp/moss-p0-probe.mjs`：**14/14 PASS**，覆盖模式槽位稳定性、订阅驱动、
   `composeSystemPrompt` 分层、单文件/多文件/偏好/截断/总预算/本仓库 25KB 全量、拒绝文案中英。
3. 真实模型运行（同一提示词，仅改模式）：
   - 默认：`Normal (default) coding mode — …`
   - `--plan`：`Plan mode — I must not edit or write files (or run any mutating commands); only read-only work and an approvable plan.`
   - 祖先目录链：临时 repo（`.git` + 根 `CLAUDE.md` + `sub/AGENTS.md`）→ 模型原样输出
     `ancestor-claude-42` 与 `workspace-agents-77` 两个标记，证明两层都进了提示词。
   - 拒绝语义：`-p` 下写 `/etc/hosts` 触发保护路径拒绝，stream-json 中捕获
     `Do not retry this call unchanged; adjust the request …`（3 处），证明新文案到达模型。
4. `npm run check`：format/lint/typecheck PASS（22.3s）。
5. `npm run verify`：static + build + smoke + 3 examples **PASS（23.1s，预算 60s）**。

### 7.3 副作用评估

- AGENTS.md 全量装载让 stable 前缀从 ~5.5k tok 增到 ~8k tok（本仓库 25KB 场景）；
  但它在 stable 前缀里是缓存命中项，长期成本下降（不再每轮重读残缺指令）。
- 计划层只在 plan 模式存在（~300 tok 动态），离开 plan 写空串，槽位不增长。
- 拒绝文案只加一句，前缀分类器（loop-guard / run-completion / protectedBlockSummary）
  仍按首句解析，未改结构标记。

### 7.4 同日架构清理（D1–D6，回答"为什么"与"删/换"）

完整设计、判定规则、保留理由与回滚见
[`specs/2026-11-04-moss-agent-architecture.md`](../../specs/2026-11-04-moss-agent-architecture.md)；
产品原因的 12 机制逐条论证见 [`why-design.md`](why-design.md)（600 行）；Moss 全量盘点与
A/B/C 删除清单见 [`moss-architecture-audit.md`](moss-architecture-audit.md)（790 行）。

| 动作      | 内容                                                                                                                                                       | 一句话原因                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| D1 删除   | 4 个孤儿模块（359 行：`tui/input-box`、`cli/attachments`、`cli/setup`、`cli/identity`）+ 5 处陈旧 spec 注释 + behavior prompt 里"支持贴图"的假声明         | 无路径可达的代码，和**模型对用户撒的谎**，都该删                               |
| D2 替换   | 计划模式：`MOSS_PLAN_GATE` env 开关 → `PLAN_ONLY_TOOL_NAMES` + `toolVisibleForRun({planMode})` + `planModeActive` 宿主钩子；4 处 env 引用与 bench 分支删除 | 模式存在，它的出口动作就必须存在（Cursor/CC 的 `ExitPlanMode` 只在 plan 模式） |
| D3 替换   | 提示词层：两个裸数组 + 下标 → `CliPromptLayers` 声明式注册表（id/stability/origin，原地更新），`MOSS_PROMPT_LAYERS=1` 自检                                 | 层的稳定性是缓存契约，不能只写在注释里                                         |
| D4 补层   | 用户级 `<configDir>/AGENTS.md`（最低优先级、共用 32/48KB 预算）                                                                                            | 项目指令缺的是"作用域"这一层，不只是文件数                                     |
| D5 替换   | 拒绝语义四分类（`DenialClass` 随决策传播）+ 决策点 11 处打标                                                                                               | P0 的统一话术与 plan 模式"Then run again"自相矛盾                              |
| D6 修缺陷 | `read_file` 截断预算键从误用的 `read` 改回 `read_file`（10k，修复前实际 4k）                                                                               | 预算必须按真实工具名查表，否则承诺的整文件读取会被腰斩                         |

**同日实测反证**：why-design §4 第 5 项"G4 MCP headless 审批阻断"**不成立**——`moss -p` 下
`mcp__rdk-docs__search` 可发现、可揭示 6 个工具、可调用 `search_docs` 并返回 40PIN 文档命中，
未被审批阻断。该项从 backlog 移除。

---

## 8. P1 / P2 backlog（按收益/风险排序）

**P1**

1. **工具面按能力揭示**：工作区没有设备目标时隐藏 `device_*`（实测 10,295 chars ≈ 2.6k tok），
   有 task 工具引用时才揭示 `task_*`/`record_*`。需先解决"deferred sticky"与 subagent scope 交互。
2. **压缩摘要结构化**：给摘要加固定节标题（沿用 Cursor 10 节裁剪版）+ 历史段 `DO NOT EDIT`
   保护 + 至少一处机器校验（节标题齐全性）。
3. **结果截断回填统一**：所有截断点统一输出 "Full output saved to: <path>" + 首尾预览
   （CC 模式），替代各工具自定义文案。
4. **skills goal 匹配**：把 `core/task/capability.ts` 的打分复用到 chat 路径，最多注入
   top-1 skill 正文，其余留索引。
5. **MCP headless 审批策略**：给 MCP 工具声明只读探测（`list_resources` 类）→ 允许只读调用，
   变更调用仍审批；需要真实 `-p` 探测 `rdk-docs` 后定稿。
6. **工具 description 的"何时不要用"段**：对 `exec`/`write_file`/`device_*` 补否定条件
   （Cursor `When NOT to Use` 范式）。

**P2**

7. 工具 description full/lean 双档（按模式选择，省 schema token）。
8. 每轮附件层：把 turn-watch、上下文窗口、git 状态统一成 `attachments` 渲染，
   不再散落在 dynamic 字符串数组。
9. 子代理 `resume/continue/fresh` 语义（与 `agents/*.md` 持久化结合）。
10. 用户级项目指令层（`<configDir>/AGENTS.md`）——注意与 `soul.md` 的边界。
11. memory 写路径（需 owner 解冻；建议先做"显式 /remember 写入 AGENTS.md"这类可审查形态）。

---

## 9. 复现与工具状态

### 9.1 复跑 REA（本机）

```bash
export REA_DARWIN_SWIFTC_PATH=/tmp/rea-clt/usr/bin/swiftc
export SDKROOT=/tmp/rea-clt/SDKs/MacOSX.sdk
export REA_DARWIN_MODULE_CACHE_PATH=/tmp/rea-out/modulecache
/opt/homebrew/opt/node@22/bin/node "$(which rea)" analyze-javascript-application \
  --source-path /Applications/Cursor.app/Contents/Resources/app \
  --format json --integrity-policy record-and-continue --output /tmp/rea-out/cursor.json
```

- `--token-limit` 与 `--format json` 互斥（`UNSUPPORTED_OUTPUT_COMBINATION`）；要 md 报告就
  `--format md --token-limit N`，要结构化证据就 `--format json`。
- `app.asar` 内部 `claude-native-binding.node` 会触发 `artifact_integrity_mismatch`，用
  `--integrity-policy record-and-continue`。

### 9.2 REA MCP 注册状态（如实报告）

本次会话里可用的 MCP server 只有 `rdk-docs`；**REA MCP 未注册到 DSH**。`rea doctor` 显示
本机所有客户端注册均为 `missing`，`rea setup --dry-run --client dsh` 返回
`status: needs_human` 且 `plannedActions: []`——被环境健康检查挡住（本机 Swift 工具链损坏、
可选分析 provider 未配置、`~/.agents/skills/reverse-engineer-anything` 是符号链接）。
因此本次使用 **REA CLI 6.5.0（与 MCP server 同引擎）**，证据口径一致。

若要让后续会话直接用 REA MCP，人工修复顺序：

```bash
# 1) 修 Swift 工具链（或用本次 /tmp/rea-clt 方案导出环境变量）
# 2) 修 skills 目录符号链接（或 rea setup --skill=false）
# 3) 注册，然后重启 DSH
rea setup --client dsh --yes
rea doctor --format json   # 期望 registrations 中 dsh 为 ok
```

### 9.3 Moss 侧复跑

```bash
cd /Users/d-robotics/Desktop/RDK_Studio/moss
npm run build
node /tmp/moss-p0-probe.mjs          # 14 项行为探针（临时脚本）
npm run verify                        # 交付门（static+build+smoke+examples）
node dist/cli.js --plan -C /tmp/moss-probe-ws -p "which mode are you in?"   # 真实模型验证
```

---

## 10. 未验证项与风险

1. **Cursor 跨会话记忆**只在 Named Agent 路径验证到（`§C.6`）；普通 Agent 的记忆写入未定位到
   完整链路 → 报告未给"如何抄"的具体方案。
2. **Claude Desktop 内部是否内嵌 Claude Code**：Desktop 是薄壳（3 种 MCP 传输 + OAuth +
   协议代际协商 + 内置 skills + computer-use 分级，`claude-evidence.md` §E1），但无法从产物
   证明它复用 CC 的 agent loop → 记忆/压缩建议只引用 Claude Code 证据。
3. **工具面收敛的实际收益**：只做了 schema 字符统计，未在真实会话里测"隐藏 device\_\* 后的
   模型表现"（P1 需要 bench 对照）。
4. **计划模式的行为收益**：本次只验证"提示词到达模型 + 模型自述遵守"，没有量化
   "plan 模式下无效工具调用次数下降"（可用 `bench` 任务后续补）。
5. **REA 不保留字符串字面量**：少数 UI 文案只能从格式化代码推断，已在证据报告里标 `[inf]`。
6. **本机 Swift 工具链损坏**是环境问题，不影响 Moss 仓库代码；但会影响后续 REA 使用。
