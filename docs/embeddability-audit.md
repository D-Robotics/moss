# Embeddability Audit: moss 架构干净度分析

> 审查日期: 2025-07-05
> 审查者: Claude Code (读源码, 非凭记忆)
> 目标: 评估 moss 能否被干净地嵌入到其他系统

## 总体结论: **架构基本干净, 但有 5 个关键耦合点需要解耦**

moss 有三层: `@rdk-moss/core` (契约) → `@rdk-moss/agent` (运行时) → `cli/` (CLI 特有). 嵌入方应该只需要前两层 + 构造自己的 CLI/宿主. 但目前 6 个关注点中有 5 个在 `cli/` 层硬编码, 嵌入方无法复用或覆盖.

## 逐项审查

### 1. 网关管理 — ❌ 耦合在 cli/ 层

**现状**:
- `cli/config.ts`: `PROVIDER_PRESETS` 硬编码 5 个 provider (deepseek/qwen/openai/anthropic/openai-compatible)
- `cli/config.ts`: `readBundledZeroConfigDefault()` 读 `zero-config-default.json` (打包时生成)
- `cli-main.ts:603`: `resolveSoulIdentity()` 调用 soul 发现逻辑

**问题**: 嵌入方（如 RDK Studio）想用自己的网关管理（可能有自己的 provider 列表、自己的认证方式），但 `PROVIDER_PRESETS` 和 `zero-config-default` 逻辑都在 `cli/config.ts`，不在 `core/` 或 `agent/` 层。

**建议**: 
- 将 `PROVIDER_PRESETS` 移到 `@rdk-moss/core` 作为默认值（可覆盖）
- `ProviderConfig` 接口已经是 `MossAgentConfig` 的一部分（`llmProvider: LLMProvider`），嵌入方可以注入自己的 provider ✓
- 网关发现逻辑应该是可注入的策略, 不是硬编码

### 2. 人格配置 — ⚠️ 部分可注入, 发现逻辑在 cli/

**现状**:
- `MossAgentConfig.baseSystemPrompt?: string` — 嵌入方可以注入 ✓
- `cli/soul.ts: resolveSoulIdentity()` — soul.md 发现逻辑在 cli/ 层
- `cli/identity.ts: buildMossCliIdentity()` — 默认 Moss 身份在 cli/ 层
- `core/contracts/soul.ts: MossSoul` — 契约在 core/ 层 ✓

**问题**: 嵌入方想用 soul.md 功能，需要复制 `resolveSoulIdentity` 逻辑到自己的宿主层，或者自己实现发现逻辑。`MossSoul` 契约在 core/，但发现实现不在。

**建议**: 将 `resolveSoulIdentity` 移到 `@rdk-moss/agent` 层（作为可选工具函数），让嵌入方可以直接调用。

### 3. Skill 配置和显示 — ⚠️ 注入可以, 但 SkillRegistry 内部创建

**现状**:
- `MossAgentConfig.skillLearner?: SkillLearner` — 可注入 ✓
- `MossAgentConfig.skillPipeline?: SkillPipeline` — 可注入 ✓
- `MossAgent.constructor`: `this.knowledge = new KnowledgeRegistry()` — 内部创建, 不可注入 ✗
- `SkillRegistry` 在 `skills/` 目录, 但不在 `MossAgentConfig` 中
- `cli-main.ts:553`: `new SkillLearner(...)` 在 CLI 层创建

**问题**: 嵌入方想控制 skill 的加载路径、显示方式、匹配逻辑，但 `KnowledgeRegistry` 在构造函数内部创建，`SkillRegistry` 不在 config 中。

**建议**: 
- `MossAgentConfig` 增加 `skillRegistry?: SkillRegistry` 和 `knowledgeRegistry?: KnowledgeRegistry`（可选，默认内部创建）
- Skill 显示应该是宿主层职责（CLI 有自己的 `/skills` 命令），moss 只提供数据接口

### 4. 自动任务查看 — ❌ 内部创建, 不可注入

**现状**:
- `MossAgent.constructor:204`: `this.asyncTasks = createInMemoryMossAsyncTaskRegistry()` — 硬编码内存实现
- `MossAgentConfig` 中**没有** `asyncTaskRegistry` 字段
- `core/contracts/async-task.ts`: `MossAsyncTaskRegistry` 接口在 core/ 层 ✓

**问题**: 嵌入方想用自己的任务管理系统（如 RDK Studio 的任务面板），但 `asyncTasks` 在构造函数内部创建为内存实现，不可注入。

**建议**: `MossAgentConfig` 增加 `asyncTaskRegistry?: MossAsyncTaskRegistry`，默认 `createInMemoryMossAsyncTaskRegistry()`。

### 5. 记忆查看 — ❌ 不在 MossAgentConfig 中

**现状**:
- `MemoryManager` 在 `memory/` 目录, 从 `index.ts` 导出 ✓
- `cli-main.ts:552`: `new MemoryManager(...)` 在 CLI 层创建
- `MossAgentConfig` 中**没有** `memoryManager` 字段
- `MossAgent` 内部不直接持有 `MemoryManager` — 它通过 `skillLearner` 间接使用

**问题**: 嵌入方想查看/管理记忆（如在 UI 中显示记忆列表），但 `MemoryManager` 不在 `MossAgentConfig` 中，嵌入方需要自己创建实例并确保路径一致。

**建议**: `MossAgentConfig` 增加 `memoryManager?: MemoryManager`（可选），或提供 `agent.getMemoryManager()` 访问器。

### 6. 模型配置 — ⚠️ ProviderConfig 可注入, 但预设和发现逻辑在 cli/

**现状**:
- `MossAgentConfig` extends `ProviderConfig`:
  - `llmProvider: LLMProvider` — 嵌入方注入自己的 provider ✓
  - `model?: string` — 模型名 ✓
- `cli/config.ts`: `CliProviderPreset` + `PROVIDER_PRESETS` + `resolveCliConfig()` — CLI 特有
- `cli/config.ts`: `readBundledZeroConfigDefault()` — 网关发现

**问题**: 嵌入方可以注入 `llmProvider` ✓，但如果想用 moss 的 provider 发现逻辑（provider preset、baseUrl 推断、模型目录），这些都在 `cli/config.ts`。

**建议**: 将 provider 发现逻辑（`PROVIDER_PRESETS`、`resolveProviderPreset`、`normalizeProvider`）移到 `@rdk-moss/agent` 层作为工具函数，CLI 层调用它们。

## 总结: 需要解耦的 5 个点

| # | 关注点 | 当前位置 | 应移到 | 优先级 |
|---|---|---|---|---|
| 1 | `PROVIDER_PRESETS` + provider 发现 | `cli/config.ts` | `agent/` 层工具函数 | P1 |
| 2 | `resolveSoulIdentity` (soul.md 发现) | `cli/soul.ts` | `agent/` 层可选函数 | P2 |
| 3 | `asyncTaskRegistry` 不可注入 | `MossAgent` 构造函数内部 | `MossAgentConfig` 可选字段 | P1 |
| 4 | `memoryManager` 不可注入 | CLI 层创建 | `MossAgentConfig` 可选字段 | P2 |
| 5 | `knowledgeRegistry` 不可注入 | `MossAgent` 构造函数内部 | `MossAgentConfig` 可选字段 | P3 |

## 好的方面（已经做对的）

- ✅ `@rdk-moss/core` 契约层零依赖，纯类型定义
- ✅ `MossAgentConfig` 接受 `llmProvider`、`sessionStore`、`hooks`、`skillLearner`、`skillPipeline` 注入
- ✅ `Host Adapter` 契约定义了 13 种宿主能力
- ✅ `MossSoul` 契约在 core/ 层
- ✅ `MossAsyncTaskRegistry` 接口在 core/ 层
- ✅ `SessionStore` 接口可注入（`JsonlSessionStore` 或自定义）
- ✅ `ToolRegistry` 可通过 `registerBuiltinTools` 或自定义注册
- ✅ `AgentHooks` 提供了宿主干预点（`onBeforeToolExec`、`onToolResult` 等）
