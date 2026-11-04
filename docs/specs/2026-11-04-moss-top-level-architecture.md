# Moss 顶层架构：四个平面 + 六个波次（简化架构、能力变强的路线）

- 日期：2026-11-04｜状态：proposal（先定顶层，再自底向上实现；本文不含"顺手改一下"）
- 背景：同日已落地 [`P0`](2026-11-04-moss-agent-design-p0.md) 与 [`架构清理 D1–D6`](2026-11-04-moss-agent-architecture.md)。
  该轮修的是"错位的实现"；本文回答更大的问题：**模块怎么划、边界怎么定、先做什么能让能力整体变强**。
- 输入证据：[`moss-architecture-audit.md`](../research/2026-11-04-cursor-claude-agent-design/moss-architecture-audit.md)
  （45 工具/29 nudge/死代码/env/SDK 盘点）、[`why-design.md`](../research/2026-11-04-cursor-claude-agent-design/why-design.md)
  （Cursor/Claude 12 机制的产品原因）。

## 0. 一页结论

**现状**：分层规则（contracts → utils/safety → provider/context/device → core → tools → cli）是清楚的，
但**四个横切面没有主**，它们散落在每一层里，各自长出一套平行实现：

| 横切面       | 现状散落点                                                                                                                                                                                  | 代价                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 工具能力声明 | `ToolMetadata` + 6 张按名字建键的表（loop-guard 6 个 Set、截断预算表、tool-catalog 4 个族、edit-syntax 钩子、stale-read 分支、agent-file allow-list）                                       | 加一个工具要改 7 处；`read_file` 预算键写成 `read` 就是这么坏的  |
| 提示词装配   | `contracts/prompts/*`、`core/agent/buildSystemPrompt`、`cli/project-instructions`、`cli/prompt-layers`、`core/skills` 索引、`core/mcp` 索引、`context/runtime-capabilities` 等 ≥12 个生产者 | 层没有身份，缓存命中无法归因；子代理无法按需瘦身                 |
| 能力发现     | 4 个 loader（AGENTS/CLAUDE、skills、commands、agents）+ 3 个命名空间（slash 内置/custom/skill）+ `core/task/capability.ts` 的第四套匹配                                                     | 同名静默覆盖、优先级无文档、task 能力发现与 skill 索引各算各的   |
| 计划/目标    | `todo_write`（会话内）＋ task ledger（`task_define/task_plan_update/…`）＋ task runtime（`runTask`）＋ `exit_plan`                                                                          | 两套工具面同时在 25 个默认工具里；审批不绑定"批准的是哪一版计划" |

**目标**：把上述四个横切面各自收拢成**一个声明面 + 一个实现面**，顶层只留四个平面，
宿主（CLI/TUI/SDK）退化成薄壳。结果是"简化"（删重复、删名字表、删平行实现）与"变强"
（每工具预算/只读/发现语义自动正确、提示词逐层可归因、指令可作用域、计划与验收闭环、
headless/TUI 一致）**同时**发生，而不是拿能力换整洁。

**路线**：六个波次，每波都先改最底层的声明/装配点，再往上收口（顶层定契约，底层实现）。
W1 工具声明 → W2 提示词装配 → W3 能力发现 → W4 计划/目标 → W5 宿主壳 → W6 设备能力合并。
W1 是唯一"改一处、全局受益"的波次，先做。

## 1. 现状：模块清单（实测行数，`src/` 127k 行 TS）

| 顶层块                           | 行数 / 文件  | 职责                                                                                    | 现状问题                                                                    |
| -------------------------------- | ------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/contracts/`                 | 2,144 / 17   | 跨层共享契约（prompt 常量、task runtime 协议、device 契约）                             | 只有"类型"，声明面没有收口（工具/能力/层都还没进）                          |
| `src/errors.ts`, `src/logger.ts` | 311+ / 2     | 根级错误与日志                                                                          | 干净（边界规则禁止依赖任何模块）                                            |
| `src/utils/`                     | 4,341 / 34   | 纯工具（进程、路径、语言、token…）                                                      | 干净                                                                        |
| `src/safety/`                    | 12,045 / 27  | 设备风险、信任、dotenv、权限规则                                                        | 偏大但内聚；`dotenv-safety-env.ts` 的 env 白名单是第二份 env 面             |
| `src/provider/`                  | 5,226 / 22   | LLM 网关、pi-ai 适配、路由                                                              | 干净                                                                        |
| `src/context/`                   | 4,587 / 23   | 压缩、截断、运行时能力、tool-result 折叠                                                | 截断预算表按名字建键（W1）；压缩契约强（保留）                              |
| `src/device/`                    | 1,904 / 10   | SSH 目标、设备风险分级                                                                  | 干净；工具侧 12 个工具偏多（W6）                                            |
| `src/core/`                      | 36,436 / 162 | 内核（agent/loop/tools/session/subagent/task/mcp/skills/rsi/superagent/llm/experience） | 子模块清楚，但横切面在此各长一套（见 §0）                                   |
| `src/tools/`                     | 12,172 / 32  | 45 个内置工具实现                                                                       | 与 `core/tools` 的边界是"实现 vs 契约"，OK；工具名重复出现在 6 张表里（W1） |
| `src/cli/`                       | 45,896 / 142 | CLI/TUI/args/config/approval/hooks/oneshot/commands                                     | 最大块；`cli-main.ts` 2,069 行里 `main()` 是一个 ~1,600 行的巨型函数（W5）  |
| `src/cli/tui/`                   | 12,637 / 32  | 全屏渲染器（动态 import，冻结决策保留）                                                 | 保留；只消费内核事件（W5 收口）                                             |

依赖方向本身没问题（ESLint `moss/boundary-*` 强制执行）；**问题不在分层，而在"每层都自己实现一遍横切面"**。

## 2. 判定"该简化"的四条症状（每条都有实测）

1. **双真源**：同一个事实存在两处，改一处另一处就坏。
   - 工具输出预算：`ToolMetadata` 无预算字段 → `tool-output-truncate.ts` 按名字建表 →
     `read_file` 查不到键落到 4k（本轮 D6 修的 bug，就是双真源的直接产物）。
   - 计划：`todo_write`（710 chars）与 `task_plan_update`（任务台账 5,671 chars 的一部分）同时可见，
     靠 `todo-nudge` 的特判让两者不打架（`nudges/todo-nudge.ts:45-52`）。
2. **按名字查表**：行为依赖字符串集合而非声明。
   - `tool-loop-guard.ts` 6 个 Set（`:8,:22,:97,:107,:242,:250`）、`tool-catalog.ts` 4 个族、
     `tool-output-truncate.ts` 预算表、`edit-syntax-check-hook.ts` 的 `MUTATING_TOOLS`、
     `stale-read-invalidate.ts` 的工具名分支、`agent-file-loader` 的 allow-list。
   - 合计 ≈100 个字面量，其中 27 个是"本构建不存在"的幽灵名（审计 §0.2 B3）。
3. **多入口同语义**：同一个业务事件有 2+ 个入口，语义靠人记住优先级。
   - "一段 Markdown 进入对话"：项目指令 / skills / 自定义命令 / 文件定义代理，4 个 loader；
     slash 命名空间 3 家争用（内置 32 + custom + skill），优先级无用户可见文档。
4. **宿主壳承担内核职责**：`cli-main.ts` 的 `main()` 里同时做：配置解析、session 恢复、
   agent 组装、MCP 连接、skills 同步、approval 钩子、task runtime、TUI/REPL/oneshot 分派。
   → 任何"headless 和 TUI 行为不同"的 bug 都从这里长出来（G4 类的误判也源于此）。

## 3. 顶层目标架构：四个平面 + 一条依赖规则

顶层只允许四个平面，宿主只做 I/O。平面之间只通过**声明**与**端口**耦合（下面的接口是形状，不是最终签名）。

```ts
// ── 平面 1：声明面（contracts/）─────────────────────────────────────────
interface ToolDeclaration {
  name: string;
  description: string; // lean：做什么 + 何时不用 + 硬约束
  longDescription?: string; // full：示例、跨工具路由（W2 按模型/预算选）
  readonly?: boolean; // 只读：并行、重试、发现类阈值的唯一真源
  discovery?: boolean; // 发现类工具（取代 DISCOVERY_TOOLS）
  maxResultSizeChars?: number; // 取代截断预算表
  searchHint?: string; // tool_search 检索文本
  editPathScoped?: boolean; // 取代 SURGICAL_EDIT_TOOLS
  sideEffectClass: 'readonly' | 'mutating' | 'device_mutation' | 'runtime_state';
  planMode: 'allow' | 'deny-on-write' | 'class-deny';
  timeoutMs?: number;
  requiresApproval?: boolean;
  retainResult?: boolean;
}

interface PromptLayerSpec {
  id: string;
  stability: 'stable' | 'dynamic';
  origin: string;
  text: string | (() => string);
}
interface CapabilityDescriptor {
  id: string;
  kind: 'instruction' | 'skill' | 'command' | 'agent' | 'mcp_server' | 'device';
  scope: 'user' | 'project' | 'workspace';
  activation: 'always' | { globs: string[] } | 'manual';
  source: string;
  cost?: number;
}

// ── 平面 2：内核面（core/kernel：loop + tools runtime + context + session）──
interface RunKernel {
  run(input: RunInput): AsyncIterable<RunEvent>;
}
interface ToolRuntime {
  visible(run: RunContext): Tool[];
  execute(call: ToolCall, run: RunContext): Promise<ToolOutcome>; // 审批/截断/重试从声明派生
}
interface ContextAssembler {
  assemble(run: RunContext): {
    stable: string;
    dynamic: string;
    tools: ToolDeclaration[];
    report: LayerReport[];
  };
}

// ── 平面 3：能力面（provider / device / mcp / skills / task / superagent）──
interface CapabilityPort<T> {
  list(): T[];
  resolve(id: string): T | undefined;
}

// ── 平面 4：宿主面（cli / tui / sdk）── 只做 I/O 与呈现
interface HostSurface {
  runHeadless(input: HeadlessInput): Promise<ExitCode>;
  runInteractive(): Promise<ExitCode>;
}
```

**依赖规则**（在现有 ESLint 边界上再加一条）：

> 只有声明面可以被所有人 import；内核面不得 import 能力面的具体实现（只经端口）；
> 宿主面不得被任何下层 import；**任何"按工具名/能力名查表"的行为都属于违反本规则**——
> 行为必须从声明派生，或由端口解析。

## 4. 旧模块 → 新职责映射

| 现有位置                                                                                | 归属平面                         | 动作                                                           |
| --------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| `core/agent/moss-agent.ts` + `core/loop/*`                                              | 内核面（RunKernel）              | 保留；工具可见性/审批改为从声明派生（W1）                      |
| `core/tools/{tool-catalog,tool-loop-guard,execute-tool-call}`                           | 内核面                           | 表 → 派生函数（W1）；`tool-catalog` 只留 legacy 别名与族名导出 |
| `context/tool-output-truncate.ts`                                                       | 内核面                           | 预算表 → `ToolDeclaration.maxResultSizeChars`（W1）            |
| `contracts/prompts/*` + `core/agent/buildSystemPrompt` + `cli/prompt-layers.ts`         | 声明面 + 内核面                  | 新建 `core/prompt/`（PromptAssembler），CLI 只声明内容（W2）   |
| `cli/project-instructions.ts`                                                           | 声明面（instruction capability） | 进 `core/capabilities/`，带 scope/activation（W3）             |
| `core/skills/`、`cli/commands/custom-commands.ts`、`core/subagent/agent-file-loader.ts` | 能力面                           | 统一 `CapabilityDescriptor` 加载器，slash 由注册表派生（W3）   |
| `core/task/capability.ts`                                                               | 能力面                           | 复用同一注册表，删第二套匹配（W3）                             |
| `core/task/*` + `tools/todo-tool.ts` + `tools/plan-gate.ts`                             | 内核面（目标面）                 | 合一个 Plan API（W4）                                          |
| `cli-main.ts`                                                                           | 宿主面                           | 拆 bootstrap / runtime / surfaces（W5）                        |
| `tools/device-tools.ts`（12 个）                                                        | 能力面                           | 只读探针 7→1 + kind（W6，owner 决策）                          |

## 5. 六个波次（顶层定契约，底层实现）

每波都给出：**底层起点 → 顶层收口 → 能力增量 → 验收（可跑）→ 风险**。

### W1 工具声明单一真源（最高杠杆，先做）

- **底层起点**：`src/core/tools/tool-types.ts` 的 `ToolMetadata` 增补 `readonly / discovery /
maxResultSizeChars / searchHint / editPathScoped`；45 个工具逐个补声明（机械、可校验）。
- **顶层收口**：`tool-loop-guard` 的 6 个 Set 改为派生谓词（`isDiscoveryTool(tool)` 等）；
  `tool-output-truncate` 预算表删除；`tool-catalog` 族集合改为"从声明派生 + 导出名"；
  `edit-syntax-check-hook`、`stale-read-invalidate`、`agent-file-loader` 同理。
- **能力增量**：新工具自动获得正确预算/只读/并行/发现语义（不再靠人记住 7 张表）；
  `tool_search` 用 `searchHint` 命中更准；`read_file` 类 bug 结构性消失；
  同时为 W2 的 lean/long description 提供落点。
- **验收**：探针遍历 45 个注册工具，断言每个都有 `sideEffectClass` + 预算/只读声明；
  预算用例（read_file 10k / exec 4.5k / device_file_read 10k 不变）；
  `npm run verify`；真实跑一次读文件 + 一次 exec（观察截断行为不变）。
- **风险**：漏改某张表会让行为静默变化 → 探针必须**遍历注册表**断言覆盖，而不是抽查。

### W2 提示词装配面上移 `core/prompt/`

- **底层起点**：把 `cli/prompt-layers.ts` 上移为 `core/prompt/assembler.ts`（`PromptLayerSpec` 进
  `contracts/`），`MossAgent.buildSystemPrompt` 改为"向 assembler 要 stable/dynamic"。
- **顶层收口**：能力模块各自导出自己的层（instructions / skills index / mcp index / runtime caps /
  context window / mode），CLI 只负责声明值；`run_metrics` 写入每层 `{id, stability, chars, hash}`，
  让缓存命中可归因（当前 `hashSystemPromptForTelemetry(prompt, [])` 传空数组，审计 §3.2）。
- **能力增量**：逐层归因；子代理按需瘦身（lean 变体有落点）；prompt 变更可 diff；
  为 W3 的"作用域层"提供运行时装配点。
- **验收**：同一会话前后 stable 字节一致；`run_metrics` 出现 10+ 层记录；
  真实跑一次 `/mode` 切换，观察 dynamic 层变化而 stable 不变。
- **风险**：字节漂移会破坏缓存命中 → 用"改动前后 prompt 快照对比"做验收门。

### W3 能力发现注册表 `core/capabilities/`

- **底层起点**：`CapabilityDescriptor`（id/kind/scope/activation/source/cost）+ 4 个 loader 输出统一描述符；
  `activation: always | {globs} | manual` 决定它是 stable 层、路径命中时的 dynamic 层、还是只进菜单。
- **顶层收口**：slash 命令表、`tool_search` 提示、task 能力发现、TUI 菜单全部从注册表派生；
  删 `core/task/capability.ts` 的第二套匹配；删隐式优先级，改为注册表排序 + 文档。
- **能力增量**：路径级指令作用域（Cursor `.cursor/rules` 模型）；单一命名空间；
  用户可发现（`/skills` 显示"何时生效"）；四套 loader 的维护面收敛。
- **验收**：装一个带 globs 的规则文件，改 `src/` 下文件时该层出现、读文档时不出现；
  slash 冲突用例（skill 与内置同名）有明确、可文档化的优先级；`npm run verify`。

### W4 计划/目标面统一 `core/plan/`

- **底层起点**：一个 `PlanItem` 模型 + 两个适配器：有 task → 写 task plan；无 task → 会话 todo。
- **顶层收口**：`todo_write` 与 `task_plan_update` 只暴露一个语义入口（保留另一个为隐藏别名）；
  `exit_plan` 携带 plan 版本；审批绑定"批准的是哪一版"（Claude Code 的 `plan_approval_response`
  绑定 requestId 的等价物），TUI/CLI/SDK 读同一份计划视图。
- **能力增量**：计划与验收闭环打通；审批防"批 A 做 B"；工具面 −1.4k chars；
  `todo-nudge` 的特判可删。
- **验收**：plan 模式提交计划 → 修改计划 → 审批 → 执行的是批准版本；
  task 场景下计划落到 `.moss/task-events.jsonl`；`npm run verify`。

### W5 宿主壳拆分（`cli-main.ts` 2,069 → 三个文件）

- **底层起点**：`cli/bootstrap.ts`（配置/诊断/首启）、`cli/runtime.ts`（agent + 能力 + 层 + 审批接线）、
  `cli/surfaces/{oneshot,repl,tui}.ts`（只做 I/O 与事件呈现）。
- **顶层收口**：`main()` 只剩"解析参数 → 选宿主 → 交给 runtime"；TUI/REPL/headless 共用同一 runtime；
  SDK 示例直接构造 runtime（不再 import dist 内部路径，审计 C5）。
- **能力增量**：headless 与 TUI 行为一致性由结构保证；启动路径可测；新宿主（Web/IDE）接 runtime 即可。
- **验收**：三条宿主路径跑同一 prompt，工具列表/系统提示/拒绝行为逐项一致（diff 事件流）；
  `npm run smoke` + PTY smoke + `npm run verify`。
- **风险**：搬动全局单例容易引入 init 顺序 bug → 用"事件流 diff"而不是人工点 UI 做验收。

### W6 设备能力合并（owner 决策后）

- **底层起点**：只读探针 7 个空 schema 工具 → `device_probe(kind: 'info'|'processes'|'resources'|
'temperature'|'file_list'|'file_read')` 结构化返回；写/部署保留独立工具名（审批与保留名契约）。
- **顶层收口**：device 工具从 12 → 6 左右；`tool_search` 域收敛；能力发现复用 W3 注册表。
- **能力增量**：schema 体积 −3k chars；探测结果结构化（模型少解析）；审批语义不变。
- **风险**：工具名是保留名契约（subagent scope/截断/loop-guard 按名引用）→ 需 owner 批准，
  且旧名保留为隐藏别名一版。

## 6. 能力增强矩阵（"简化"与"变强"同时发生的证据面）

| 能力维度                | 当前                 | W1                             | W2               | W3                 | W4                       | W5           | 度量方式                    |
| ----------------------- | -------------------- | ------------------------------ | ---------------- | ------------------ | ------------------------ | ------------ | --------------------------- |
| 工具选择正确率          | 描述单档、名字表     | 声明含 `searchHint`/否定段落点 | lean/long 两档   | 能力发现统一       | 计划面唯一               | —            | bench 误选工具次数          |
| 每轮 token              | 45 工具 40.5k chars  | 预算按工具正确                 | 描述 −3~4k chars | 索引更短           | −1.4k chars              | —            | 首请求 schema/prompt chars  |
| 缓存可归因              | 只有整体 hash        | —                              | 逐层 hash        | —                  | —                        | —            | `run_metrics.layers` 覆盖率 |
| 指令作用域              | 全量 stable          | —                              | 层可装配         | always/glob/manual | —                        | —            | 路径命中实验                |
| 计划-验收闭环           | 两套工具面           | —                              | —                | —                  | 单一 Plan API + 版本绑定 | —            | 审批执行版本一致            |
| headless/TUI 一致       | 共享 cli-main 巨函数 | —                              | —                | —                  | —                        | runtime 统一 | 事件流 diff                 |
| 扩展成本（加工具/能力） | 改 7 处              | 改 1 处声明                    | 声明 + 可选层    | 声明 + descriptor  | —                        | —            | 新增项改动文件数            |

## 7. 不做什么（冻结与 owner 决策）

- **memory 不碰**：2026-09-30 冻结决策不变；W3 的"能力注册表"不引入跨会话自动记忆。
- **RSI / SDK 通配导出 / superagent 范围**：属 owner 决策（审计 C1/C2），本文只留接口位置。
- **TUI 保留**：v0.17 翻案结论不变，只把它降为宿主面消费者（W5）。
- **不为"整齐"重写压缩/nudge/验收门**：它们是 Moss 的领先项（why-design §4），只做接口收口不做逻辑重写。

## 8. 顺序、依赖与验收门

```
W1 工具声明 ──► W2 提示词装配 ──► W3 能力发现（依赖 W2 的层装配点）
   │                                   │
   └────────► W4 计划面（依赖 W1 的可见性派生）◄──┘
                       │
                       └──► W5 宿主壳（依赖 W1–W4 的端口稳定）
                                     │
                                     └──► W6 设备合并（owner 决策）
```

每波验收门（缺一不可）：① 目标行为真实跑的观察；② 行为探针（探针入库到
`scripts/verify` 的一个 stage，替代已删除的 spec 套件）；③ `npm run check`；④ `npm run verify`。
公共面变更单列说明（`src/index.ts` 语义不变是本路线的前提）。

## 9. 基线数字与目标

| 指标               | 当前（实测）                               | W1–W5 目标                              |
| ------------------ | ------------------------------------------ | --------------------------------------- |
| 按工具名建键的表   | 6 处（≈100 字面量，含 27 幽灵名）          | 0（仅 legacy 别名保留）                 |
| 断言覆盖的工具声明 | 无                                         | 45/45 声明完整（verify stage 遍历断言） |
| 提示词层           | CLI 10 层有 id；core 归因传空数组          | 全部层有 id/hash，`run_metrics` 可归因  |
| 指令装载方式       | 全量 stable（本仓库 19,005 chars）         | always/glob/manual 三档，路径命中才付钱 |
| 计划工具面         | 2 套（todo 710 + task ledger 5,671 chars） | 1 套语义 + 版本绑定审批                 |
| `cli-main.ts`      | 2,069 行，`main()` ~1,600 行               | ≤300 行，main 只做三件事                |
| 设备工具           | 12 个（7 个空 schema 只读探针）            | ≈6 个（探针合并，旧名一版隐藏别名）     |
| 宿主路径一致性     | 靠人工                                     | 事件流 diff（headless vs TUI）          |

## 10. 第一批要动的文件（供实施时直接照着开）

- W1：`src/core/tools/tool-types.ts`（加字段）、`src/core/tools/tool-loop-guard.ts`（表→谓词）、
  `src/context/tool-output-truncate.ts`（删表）、`src/core/tools/tool-catalog.ts`（族派生）、
  `src/tools/edit-syntax-check-hook.ts`、`src/core/tools/stale-read-invalidate.ts`、
  `src/core/tools/tool-search.ts`（searchHint）、`src/tools/*.ts`（45 个声明补字段）。
- W2：`src/core/prompt/{assembler,layers}.ts`（新）、`src/contracts/prompt-layer.ts`（新）、
  `src/core/agent/moss-agent.ts`（buildSystemPrompt 改装配）、`src/cli/prompt-layers.ts`（迁走）。
- W3：`src/core/capabilities/{descriptor,registry,loaders}.ts`（新）、`src/cli/commands/custom-commands.ts`、
  `src/core/skills/skill-registry.ts`、`src/core/subagent/agent-file-loader.ts`、`src/core/task/capability.ts`。
- W4：`src/core/plan/{plan-item,adapters}.ts`（新）、`src/tools/todo-tool.ts`、`src/tools/task-tools.ts`、
  `src/tools/plan-gate.ts`、`src/cli/tui/app.ts`（计划视图）。
- W5：`src/cli/{bootstrap,runtime}.ts`（新）、`src/cli/surfaces/*`（新）、`src/cli-main.ts`（缩到入口）、
  `examples/*`（改走 runtime）。
- W6：`src/tools/device-tools.ts`、`src/device/*`、`docs/design/tool-surface-rea.md`（保留名契约）。

## 11. 实施进度（同一 main 线，逐波落地）

| 波次                           | 状态 | commit                  | 落点                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ---- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1 工具声明单一真源            | 完成 | `ceb5ff32` + `11264a7e` | `ToolMetadata.maxResultTokens/truncationHint/classification`；截断名字表删除，改为 builtin 声明安装；loop-guard 六个名字集合删除；可选 provider 名字收敛为显式常量                                                                                                                                                                                                                         |
| W2 提示词装配面上移            | 完成 | `6e2f8cf8`              | `contracts/prompt-layer.ts` + `core/prompt/{assembler,report}`；`MossAgentConfig.promptLayers`；`run_metrics.systemPromptLayerCount/LayerHashes`（此前恒为 0）；`cli/prompt-layers.ts` 删除；W5a 进一步抽成 `cli/prompt-setup.ts`                                                                                                                                                          |
| W3 能力发现注册表 + 指令作用域 | 完成 | `0dac0b5f` + 本轮       | `contracts/capability.ts`、`core/capabilities/registry.ts`；`.moss/rules/*.md` + `<configDir>/rules/*.md`（frontmatter `globs`/`description`，always/glob 两档）；工具触达路径后动态装载。W3b：`core/capabilities/slash.ts` 把斜杠优先级变成数据（builtin > workspace command > user command > skill），`cli/slash-namespace.ts` 启动时报出被遮蔽的名字并发布 command/skill 描述符进注册表 |
| W4 计划/目标面统一             | 完成 | `2d850065` + 本轮       | `todo_write` 在有 live task 时写入 task plan（一个清单）；`exit_plan` 输出 plan version，TUI 审批回执使用该 version（W4b），审批后版本作废、下一版计划必须重新提交                                                                                                                                                                                                                         |
| W5 宿主壳拆分                  | 完成 | `5d24ec8c` + 本轮       | `cli/prompt-setup.ts`（W5a）；`cli/bootstrap.ts` 承载加载期关注点（参数/语言/告警过滤/颜色/日志级别/mock provider/启动配置），`cli/runtime.ts` 承载运行期装配；`cli-main.ts` 2,069 → **13 行**入口 shim；交互面本来就是独立模块（`cli/repl.ts`、`cli/tui/app.ts`，按 TTY 动态 import）                                                                                                     |
| W6 设备能力合并                | 完成 | `ed010ae8`              | `device_probe(kind=info/processes/resources/temperature/network/cameras/robotics_status)`（派发复用原实现）；7 个空 schema 探针标 `hiddenFromModel`（仍注册，旧 transcript/SDK 按名可达）；配置设备时模型可见工具 45→36；子代理只读 scope 与提示改指 `device_probe`                                                                                                                        |

> Skill 平面的独立设计见 [Skill Library 架构](2026-11-04-moss-skill-library-architecture.md)：目录发现、catalog 预算、
> 信任与来源、子代理/SDK 供给面、evals，按 SK1–SK7 分波。

**W3 的已知边界**：glob 规则只在"工具触达匹配路径"或"用户消息里出现路径 token"时激活；模型在纯对话轮次不会凭空激活规则（与 Cursor 的 model-decided 类相比，这是有意的确定性取舍——可预测 > 自动嗅探）。
