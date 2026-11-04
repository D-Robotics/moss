# Moss agent 设计 P0：计划模式提示词 / 项目指令装载 v2 / 拒绝语义

- 日期：2026-11-04
- 状态：implemented（P0-1 / P0-2 / P0-3 落地于本提交，验证见 §5）；同日架构清理已把 P0-1 的
  `installPlanModeLayer` 助手替换为声明式 `CliPromptLayers` 注册表，并把 P0-3 的单一话术补成
  四类拒绝语义（见 [`docs/specs/2026-11-04-moss-agent-architecture.md`](2026-11-04-moss-agent-architecture.md)）
- 证据来源：[`docs/research/2026-11-04-cursor-claude-agent-design/`](../research/2026-11-04-cursor-claude-agent-design/README.md)
  （Cursor 3.27.14 与 Claude Desktop + Claude Code 2.1.317 的 REA 逆向报告、Moss 基线）
- 变更范围：`src/contracts/prompts/`、`src/cli/`、`src/core/tools/execute-tool-call.ts`；
  不触碰 `src/core/loop/`、`src/context/` 的既有阈值，不引入 memory 子系统（维持 2026-09-30 冻结决策）。

## 1. 为什么是这三项

三份证据报告收敛出同一个结论：Cursor / Claude Code 的 agent 质量差异，主要不在"更长更细的提示词"，
而在三处结构：

1. **模式是一等契约，且用"最后一层注入"表达**。Cursor 的 Ask/Plan 模式不改 system prompt，而是每轮追加
   `<system_reminder>` 并声明 "This supersedes any other instructions"（`cursor-evidence.md` §A.3/A.4）；
   Claude Code 有 `plan` 权限模式与独立的 `# Session-specific guidance` 节。Moss 的 `plan` 目前只是权限模式
   （`src/cli/interaction-mode.ts:44` 的 `deriveEngineQuantas`），模型拿不到任何"我在计划模式里"的语义提示，
   于是常见的失败是：模型按普通会话的先读后改习惯直接动手，被审批层拒绝，再换个工具绕。
2. **项目指令（记忆的文件形态）是分层加载的**。Cursor 有 `.cursor/rules` 四类 + `AGENTS.md` 一等概念
   （`cursor-evidence.md` §C.1/C.3），Claude Code 加载企业/用户/项目/子目录的 `CLAUDE.md` + `AGENTS.md`
   （`claude-evidence.md` §A5）。Moss 只读工作区根目录单个 `AGENTS.md`，16KB 截断——本仓库自己的
   `AGENTS.md` 就有 25KB，实测被丢掉 9KB（`moss-baseline.md` §1.1、§6 G5）。
3. **拒绝语义决定"被拒之后模型做什么"**。Claude Code 的 `# Harness` 写明 "a denied call means the user
   declined it — adjust, don't retry verbatim"（`claude-evidence.md` §B3）；Cursor 把 "action was not executed"
   与真失败分开（`cursor-evidence.md` §F/工具 result case）。Moss 的 `deniedToolResultText()` 只有一句
   "Tool execution denied: …"，模型最自然的反应就是原样重试或换 shell 绕过——而这恰好是 Moss 自己在
   `tool-loop-guard.ts` 里要封堵的行为，提示词与护栏在这里是对抗的。

三项都属于"高价值、可确定性验证、不动核心架构"。工具面收敛（tool schema 占首请求 3.7k tok）与
压缩策略优化留到 P1/P2：前者牵动 subagent scope 与设备闭环的默认工具可见性，后者现状已较强。

## 2. P0-1 计划模式提示词层

### 2.1 设计

- 新增契约常量 `PLAN_MODE_PROMPT`（`src/contracts/prompts/plan-mode-prompt.ts`）：一段 ~1.1KB 的英文
  "模式契约"，要求只读探索、给出可审批的计划结构（目标 / 已验证事实 / 改动文件 / 步骤 + 每步验证 /
  未知与风险）、不得声称完成、需要编辑时提示用户切模式。
- 归属 **dynamic 层**，不写入 stable 前缀：模式可在会话中途 `/mode` 切换，写进 stable 会让前缀缓存失效，
  也会让子代理继承一个过期的模式契约。`dynamicPromptLayers` 是每次 run 重新读取的数组
  （`src/core/agent/moss-agent.ts:398`），天然适合。
- 该层以稳定 id `mode:plan` 声明进 `CliPromptLayers`（`src/cli/prompt-layers.ts`）：`set()` 覆盖同 id 的
  文本、空串即不进入数组，所以反复切模式不会让动态层增长，也不会重排前缀。`planModeLayer(mode)`
  （`src/cli/plan-mode-layer.ts`）只负责 mode → 文本，注册表负责槽位。
- `src/cli-main.ts` 在建立注册表之后声明该层并订阅 `subscribeCliInteractionMode`，启动时先同步一次
  （覆盖 `--plan` / `permissions.defaultMode=plan` 两种入口）。

### 2.2 不做什么

- 不把 `plan` 变成提示词里的"另一个系统提示词"（Cursor/CC 都没这么做）。
- 不改审批层语义：plan 模式仍然 class-level deny 文件写与设备变更（`deriveEngineQuantas`）；提示词只是
  让模型提前知道边界，减少无效调用。
- 不在 `exit_plan` 工具注册上做动态增删（工具面按 run 快照，动态增删会牵动 loop-guard 的保留名与
  subagent scope）。注册恒定、可见性按模式：`PLAN_ONLY_TOOL_NAMES` + `toolVisibleForRun({ planMode })`
  只在 `plan` 模式把 `exit_plan` 示给模型；`MOSS_PLAN_GATE` 环境开关已删除（模式本身就是开关，
  见架构清理文档 §3.2）。

### 2.3 验收

- `npm run build` 后，探针脚本调用 `planModeLayer('plan')` 等于 `PLAN_MODE_PROMPT`，其它模式为 `''`。
- 注册表上 `set('mode:plan', plan) → set('mode:plan', '') → set('mode:plan', plan)` 后动态数组长度不变、
  末态内容正确，且声明顺序不变。
- 真跑：`moss --plan -p` 的请求里出现 `exit_plan` 且模型能调用；默认模式请求里没有 `exit_plan`
  （模型自述"未注册给本次运行"）。见 §5.3。
- `moss --plan -p` 启动不报错（`--mock` 下跑通一轮，日志中的 dynamic 层包含该段）。

## 3. P0-2 项目指令装载 v2

### 3.1 设计

`src/cli/project-instructions.ts` 从"单文件、单目录"升级为"祖先链 + 多文件名 + 双上限"：

- **候选文件名**（同目录取第一个命中，避免重复注入）：
  `AGENTS.md` → `agents.md` → `CLAUDE.md` → `claude.md`。与既有提示词里已经出现的
  "`AGENTS.md` / `CLAUDE.md` 覆盖本节"表述一致（`software-engineering-prompt.ts:52`）。
- **祖先链**：从工作区向上走到最近的 `.git` 标记（最多 12 层），工作区必须在链上；无 `.git` 时
  只加载工作区（保持现有行为，避免把用户 HOME 的无关文件注入）。渲染顺序为**最外层 → 工作区**，
  更具体的指令更靠近对话尾部。
- **上限**：单文件 32KB（原 16KB；本仓库 25KB 的 AGENTS.md 因此可以完整装载），合计 48KB。
  预算按"工作区优先"分配（先保具体指令），超限从最外层丢弃并写显式提示；单文件超限仍保留
  "truncated + 丢了多少 KB + 怎么改"的可见提示，绝不静默截断。
- **头部**：单文件保持 `[Project instructions — AGENTS.md]` 原样（减少既有行为漂移）；多文件时为
  `[Project instructions — N files: AGENTS.md (workspace), CLAUDE.md (ancestor:..)]`，正文用
  `--- <name> (<label>) ---` 分隔。
- 入口签名保持 `buildAgentsMdLayer(workspaceDir, options?)`，`context-report` 与 CLI 无需改造调用点。

### 3.2 不做什么

- 不加载 `~/.claude/CLAUDE.md` 之类的用户级指令（Moss 的用户级身份在 `soul.md`，混入会污染项目语义）；
  用户级指令层列为 P2（需要显式的 `<configDir>/AGENTS.md` 约定）。
- 不递归扫描子目录（Cursor 的 glob-attached rules、CC 的 nested CLAUDE.md 是"文件级作用域"，需要
  与文件读取观测联动的 v2；单层祖先链先解决 90% 的"仓库根指令读不到"问题）。
- 不引入向量/自动记忆（memory 子系统维持冻结）。项目指令就是"记忆的文件形态"，读写都走可审查的
  Markdown，符合仓库既有纪律。

### 3.3 验收（确定性探针，不需要模型）

- 临时目录构造：只有工作区 `AGENTS.md` → 输出与旧格式一致；祖先有 `CLAUDE.md` → 两段都出现，
  外层在前；`agents.md` 与 `CLAUDE.md` 同时存在 → 只取 `agents.md`；单文件 40KB → 出现截断提示且
  保留 32KB；多文件合计超 48KB → 出现"超出总预算被跳过"提示。
- 本仓库实跑：`buildAgentsMdLayer(repoRoot)` 应包含完整 25KB AGENTS.md（不再截断）。

## 4. P0-3 拒绝语义

### 4.1 设计

`deniedToolResultText(reason, zh)` 在保留原有前缀（`Tool execution denied:` / `已拦截：`，多个下游分类器
依赖该前缀）与原文 reason 的前提下，追加一句**可执行的下一步指引**：

- 英文：`<prefix><reason>. Do not retry this call unchanged; adjust the request (narrower, safer, or
read-only) or ask the user how to proceed.`
- 中文：`已拦截：<reason>。不要原样重试这次调用；调整请求（更窄、更安全或只读）或询问用户下一步。`
- reason 末尾标点先规范化，避免 `..`；hook 自带的 `已拦截：…` / `Blocked …` 原文继续原样透传
  （hook 文案已含自己的处置说明，且 `protectedBlockSummary` 依赖首句解析）。

### 4.2 不做什么

- 不把 "denied" 重新分类成普通错误，也不改 `kind: 'denied'` 的结构化标记
  （`src/core/tools/execute-tool-call.ts:472`）。
- 不改 loop-guard 的拦截文案（那是"已经重复了"之后的处置，与本条互补）。

### 4.3 验收

- 探针：`deniedToolResultText('User denied exec.')` 以 `Tool execution denied:` 开头、包含
  `Do not retry this call unchanged` 且不出现 `..`；`deniedToolResultText(undefined, true)` 以 `已拦截：` 开头
  且包含"不要原样重试"；hook 风格 reason（`已拦截：…`）原样返回。

## 5. 验证结果（2026-11-04 实跑）

### 5.1 交付门

| 命令             | 结果                                                         |
| ---------------- | ------------------------------------------------------------ |
| `npm run build`  | PASS（clean，7.7s / 9.1s）                                   |
| `npm run check`  | PASS：format + lint(0 warning) + typecheck，22.3s            |
| `npm run verify` | PASS：static + build + smoke + 3 examples，23.1s（预算 60s） |

### 5.2 行为探针（临时脚本不入库；P0 版 `/tmp/moss-p0-probe.mjs`，清理后

`/tmp/moss-arch-probe.mjs`）

19/19 PASS（清理后版本）：

- `planModeLayer('plan') === PLAN_MODE_PROMPT`，`manual/acceptEdits/full` 为 `''`。
- 注册表槽位稳定性：同 id `set()` 覆盖文本、空串不进数组、声明顺序不变；`remove()` 幂等。
- 层报告含 id/stability/origin/chars（`MOSS_PROMPT_LAYERS=1` 的启动自检）。
- 订阅驱动：`setCliInteractionMode('plan'/'manual')` 即时改变 dynamic 数组内容
  （与 cli-main 的接线同一路径）。
- `composeSystemPrompt`：计划契约出现在 `dynamic`/`full`，**不进入** `stable`。
- 项目指令矩阵：单文件保持原头部；祖先 `CLAUDE.md` + 工作区 `AGENTS.md` 外层在前；
  同目录 `agents.md` 优先于 `CLAUDE.md`；40KB 单文件截到 32KB 并显示 `~8KB dropped`；
  总预算场景丢弃祖先、保留工作区并显示 `1 file(s) skipped over the 48KB total cap`；
  **本仓库 25KB `AGENTS.md` 全量装载、不再截断**。
- 拒绝文案：未分类时保持旧行为（英文含 `Do not retry this call unchanged`、中文含"不要原样重试"，
  且不出现 `..`/`。。`）；四类拒绝各有自己的"下一步"话术（user/mode/policy/headless），
  hook 原文（`已拦截：…`/`Blocked …`）原样透传（升级见架构清理文档 §3.1）。
- `exit_plan` 可见性：`planMode: true` 可见，`false`/未设置不可见，`read_file` 不受影响。

### 5.3 真实模型端到端（非 mock）

| 场景               | 观察                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 默认模式           | 模型回答 `Normal (default) coding mode — …`                                                                                                                          |
| `--plan`           | 模型回答 `Plan mode — I must not edit or write files (or run any mutating commands); …`                                                                              |
| 祖先目录链         | 临时仓库（`.git` + 根 `CLAUDE.md` + `sub/AGENTS.md`）下，模型原样输出 `ancestor-claude-42` 与 `workspace-agents-77`                                                  |
| 拒绝语义           | `-p` 写 `/etc/hosts` 触发保护路径拒绝，`stream-json` 捕获 `Do not retry this call unchanged; adjust the request …`（3 处）                                           |
| 计划模式行为       | 指令要求"必须调用 write_file"时模型仍未写文件（只做只读搜索），说明契约改变了行为而非仅到达提示词                                                                    |
| `exit_plan` 可见性 | `--plan`：模型直接调用 `exit_plan`（结果 "Plan submitted for approval…"）；默认模式：模型明确回答 "`exit_plan` is not registered for this run, so I did not call it" |
| 拒绝分类（policy） | `-p --workspace-write` 强制写工作区外文件 → 工具结果同时含拦截原因与"不要用其他工具绕行…"（分类话术），文件未创建                                                    |

### 5.4 未覆盖

- 未量化"plan 模式减少无效工具调用"的比率（需 bench 任务）；
- 未测 TUI 内 `/mode` 切换的视觉表现（只验证了订阅回调与提示词层，TUI 路径共用同一单例）。

## 6. 回滚

三项互相独立，均可单独回滚：

- P0-1：删除 `src/cli/plan-mode-layer.ts` 与 cli-main 的订阅，`dynamicPromptLayers` 回到只有环境/MCP/设备层。
- P0-2：`project-instructions.ts` 单文件重写，回滚即恢复 16KB 单目录行为（调用点签名未变）。
- P0-3：`execute-tool-call.ts` 的一处字符串构造函数。
