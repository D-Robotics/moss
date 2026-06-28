# Moss 架构重构计划：Items 1-3

## Context

架构审查报告识别了 7 个浅模块与摩擦点。经证据核实与用户确认：

- **执行范围**：仅强推荐的第 1-3 项；跳过第 4 项（ToolRegistry 自注册违反 AGENTS.md 禁止模块级可变状态规则）；第 5-7 项报告自身标注为 Worth exploring / Speculative，暂不执行。
- **策略**：按报告完整重构——引入 ConfigManager / ModelCatalog / CliServices 类。
- **关键证伪**：报告称"43 文件围绕 tui.ts 聚集"——实际仅 `repl.ts` 导入 tui.ts；真正的枢纽是 `config.ts`（14 个文件导入它）。报告称"loop 6 个零导入文件=不合理抽取"——实际是通过 index.ts barrel re-export 的自洽叶子模块，是好的解耦设计。

**执行顺序**：先做第 3 项（测试，最低风险），再第 2 项（配置层类化），最后第 1 项（CliServices 外观）。

---

## Phase 1: 代理循环单元测试（Item 3）

**目标**：为 6 个零内部导入的 loop 模块编写单元测试，覆盖主要状态转换路径。

**测试模式**（参考现有 `test/cli-config.spec.mjs`）：
- 文件：`packages/moss-agent/test/loop-*.spec.mjs`
- 框架：`node:assert/strict`
- 导入：从 `../dist/core/loop/*.js` 导入（编译后输出）
- 结构：block-scoped `{ }` 测试组

### 1.1 `test/loop-steering.spec.mjs`

**被测文件**：`src/core/loop/steering.ts`（183 LOC，纯函数 + 类）

测试用例：
- `BUILTIN_ERROR_RECOVERY_RULE.check()` — consecutiveToolErrors < 3 返回 null；>= 3 返回引导文本
- `BUILTIN_TOOL_LOOP_RULE.check()` — turn < 8 返回 null；>= 8 且最近 4+ 条 assistant 全是 tool_use 返回引导
- `BUILTIN_CONTEXT_PRESSURE_RULE.check()` — ratio < 0.75 返回 null；>= 0.75 返回含百分比的引导
- `BUILTIN_WEB_SEARCH_VARIATION_RULE.check()` — < 2 个不同 query 返回 null；>= 2 返回防重复引导
- `SteeringEngine` — 规则按 priority 排序；cooldownTurns 内不重复触发；`evaluate()` 返回 triggered/guidances/firedRules；`reset()` 清除冷却记录；`addRule()` 动态添加

### 1.2 `test/loop-follow-up-guard.spec.mjs`

**被测文件**：`src/core/loop/follow-up-guard.ts`

测试用例：
- `lastMessageNeedsToolFollowUp()` — 空数组返回 false；最后非 user 返回 false；user + tool_result 返回 true；user + 纯文本返回 false
- `extractThinkingTagBodies()` — 空字符串返回空；含 `<thinking>` 标签提取内容；多标签拼接；`redacted_thinking` 变体
- `hasToolResultAfterLastAssistant()` — 验证 assistant 后是否有 tool_result
- `shouldSuppressReasoningForToolFollowUpRound()` — 验证抑制逻辑
- `detectUnexecutedToolIntents()` — 验证未执行工具意图检测

### 1.3 `test/loop-context-budget-planner.spec.mjs`

**被测文件**：`src/core/loop/context-budget-planner.ts`

测试用例：
- `planContextBudgetActions()` — turn <= 1 返回 first_turn 空动作；isToolFollowUpRound 返回 invalidate_stale_reads；低于 warning 返回 baseline_hygiene；超 warning 返回 snip_tail_tool_results；超 proactive 返回 microcompact + llm_summarize
- 验证 warningThreshold / proactiveThreshold 正确计算

### 1.4 `test/loop-compact-hooks.spec.mjs`

**被测文件**：`src/core/loop/compact-hooks.ts`

测试用例：
- `CompactHookRegistry` — 注册 pre/post hook；按序执行；异常不中断后续 hook
- `buildCompactionCheckpointOutline()` — 验证 outline 生成

### 1.5 `test/loop-pending-tool-aborts.spec.mjs`

**被测文件**：`src/core/loop/pending-tool-aborts.ts`

测试用例：
- `notePendingAbortedToolCalls()` + `consumePendingAbortedToolSyntheticMessages()` — note 后 consume 返回合成消息；consume 后清空；不同 sessionKey 隔离

### 1.6 `test/loop-compaction-timeout.spec.mjs`

**被测文件**：`src/core/loop/compaction-timeout.ts`

测试用例：
- `resolveCompactionPrepareTimeoutMs()` — 验证超时值解析
- `runWithCompactionPrepareTimeout()` — 正常完成返回结果；超时抛出错误

### Phase 1 验证

```bash
npm run build
npm run test -w @rdk-moss/agent
```

所有 6 个新测试文件必须通过。

---

## Phase 2: 配置层类化（Item 2）

**目标**：将 config.ts（59 导出）、model-catalog.ts（14 导出）的散落函数封装为 ConfigManager / ModelCatalog 类，消除跨文件直接引用。

### 2.1 创建 `src/cli/config-manager.ts`

**新文件**，包含 `ConfigManager` 类：

```typescript
export class ConfigManager {
  constructor(private env: NodeJS.ProcessEnv = process.env) {}

  // ── 路径解析 ──
  resolveConfigDir(): string
  resolveConfigPath(): string
  resolveProjectConfigPath(startDir?: string): string | null

  // ── 文件加载/保存 ──
  loadConfigFile(configPath?: string): ConfigFile
  loadCliConfigFile(configPath?: string, startDir?: string): LoadedCliConfigFile
  mergeConfigFiles(project: ConfigFile, user: ConfigFile): ConfigFile
  saveConfigFile(config: ConfigFile, configDir?: string): void
  saveConfigFileAtPath(config: ConfigFile, configPath: string): void

  // ── 配置解析（主入口）──
  resolveCliConfig(overrides?: CliConfigOverrides): ResolvedCliConfig

  // ── Provider 预设 ──
  parseProviderPreset(value: string | undefined): CliProviderPreset | null
  normalizeProvider(value: string | undefined): CliProviderPreset

  // ── 归一化 ──
  normalizeConfigProfile(value: string | undefined): CliConfigProfile | null
  normalizeSafetyModeConfig(value: string | undefined): CliSafetyModeConfig | null
  normalizeApprovalPolicyConfig(value: string | undefined): ConfigApprovalPolicy | null
  normalizeGuardrailsConfig(raw: unknown): ResolvedGuardrailsConfig
  parseTrustedTools(value: string | string[] | undefined): string[] | undefined

  // ── 审计 ──
  auditResolvedCliConfig(config: ResolvedCliConfig): CliConfigAuditWarning[]
  hasTrustedToolWildcard(config: Pick<ResolvedCliConfig, 'trustedTools'>): boolean
  isBroadTrustedToolPattern(pattern: string): boolean

  // ── 加密 ──
  maybeEncryptApiKeyInConfig(config: ConfigFile, configDir: string): ConfigFile
  maybeDecryptApiKeyInConfig(config: ConfigFile, configDir: string): ConfigFile

  // ── Env 加载 ──
  loadEnvFile(envPath: string): void
  loadEnvFromAncestors(startDir: string): void

  // ── 模型上下文窗口 ──
  resolveModelContextWindow(model: string | undefined): number
}
```

**设计原则**：
- 所有类型/interface（ConfigFile, ResolvedCliConfig, CliConfigOverrides 等）保持在 `config.ts` 中导出，不变
- 常量（PROVIDER_PRESETS, CLI_PROFILE_DEFAULTS）保持在 `config.ts` 中导出
- 错误类（CliConfigFileError, CliConfigWriteError）保持在 `config.ts` 中导出
- ConfigManager 的方法实现从 config.ts 的函数体移入，config.ts 的原函数改为委托给默认实例

### 2.2 改造 `src/cli/config.ts`

- 保留所有 type/interface/const/class 导出不变
- 创建模块内默认实例：`const defaultManager = new ConfigManager();`
- 每个原 `export function` 改为委托：`export function resolveConfigDir(...) { return defaultManager.resolveConfigDir(...); }`
- 删除模块级 `export const PROVIDER = ...` 等急切求值（改为通过 ConfigManager 访问），或保留为委托 getter

### 2.3 创建 `src/cli/model-catalog-manager.ts`

**新文件**，包含 `ModelCatalog` 类：

```typescript
export class ModelCatalog {
  // ── 模型选择 ──
  commonModelChoices(...): ModelChoiceList
  async loadModelChoicesForRuntime(...): Promise<ModelChoiceList>
  async autoSelectGatewayModel(...): Promise<ModelChoice | null>
  resolveModelSelection(...): ModelChoiceList
  formatModelChoices(list: ModelChoiceList): string

  // ── 自定义模型配置 ──
  parseCustomModelConfigInput(input: string): CustomModelConfigParseResult
  formatCustomModelConfigInstructions(configPath?: string): string
  describeModelListSource(list: ModelChoiceList): string

  // ── 上下文窗口解析 ──
  async resolveModelContextWindowFromApi(...): Promise<number | undefined>
  async resolveContextTokensForModel(...): Promise<number>
}
```

### 2.4 改造 `src/cli/model-catalog.ts`

- 保留 type/interface 导出
- 创建默认实例，原函数委托

### 2.5 迁移调用方

14 个导入 config.ts 的文件改为导入 ConfigManager 类型 + 创建/接收实例：
- `tui.ts` — 使用注入的 ConfigManager
- `approval.ts` — 使用 ConfigManager
- `help.ts`, `doctor.ts`, `hooks.ts` — 使用 ConfigManager
- `mcp-command.ts`, `mcp.ts`, `providers.ts` — 使用 ConfigManager
- `preferred-model-store.ts`, `community-auth.ts`, `model-resolution.ts`, `migrate-command.ts` — 使用 ConfigManager
- `agent-runtime.ts` — 使用 ConfigManager
- `repl.ts` — 使用 ConfigManager

3 个导入 model-catalog.ts 的文件改为使用 ModelCatalog：
- `tui.ts`, `setup.ts`, `repl.ts`

### Phase 2 验证

```bash
npm run build
npm run typecheck
npm run test -w @rdk-moss/agent
npm run lint
```

所有现有测试必须继续通过；类型检查无错误；导出数量不增加。

---

## Phase 3: CliServices 外观（Item 1）

**目标**：创建 CliServices 外观类，协调 ConfigManager、ModelCatalog 和审批工作流，供入口点使用。

### 3.1 创建 `src/cli/cli-services.ts`

**新文件**：

```typescript
export class CliServices {
  constructor(
    private config: ConfigManager,
    private models: ModelCatalog,
  ) {}

  // ── 配置解析 ── 协调加载、合并、验证
  resolveConfig(overrides?: CliConfigOverrides): ResolvedCliConfig

  // ── 模型选择 ── 管理目录、缓存、用户偏好
  async selectModel(params: {
    workspaceDir?: string;
    config: ResolvedCliConfig;
  }): Promise<ModelChoice>

  // ── 审批工作流 ── 协调 approval + approval-detail
  showApprovalFlow(params: {
    tool: string;
    input: unknown;
    safetyMode: CliSafetyMode;
  }): Promise<boolean>

  // ── 配置命令 ── 委托 setup.ts 的命令函数
  runConfigShow(): void
  runConfigValidate(args: string[], startDir?: string): void
  runConfigInit(args: string[], startDir?: string): void
  runConfigSet(args: string[], startDir?: string): void
  runConfigUnset(args: string[], startDir?: string): void

  // ── 引导向导 ──
  async runSetupWizard(): Promise<void>
  async offerSetupForInteractiveMissingConfig(): Promise<void>
}
```

### 3.2 改造 `src/cli/repl.ts`

- 当前导入：tui.ts（78 导出）、config.ts、model-catalog.ts、approval.ts
- 改为：接收 `CliServices` 实例，通过它访问配置、模型、审批
- 保留对 tui.ts 渲染函数的直接导入（这些是纯渲染函数，不适合放入外观）

### 3.3 改造入口点

- 找到 CLI 主入口（main.ts 或 index.ts），创建 ConfigManager + ModelCatalog + CliServices 实例
- 传递给 repl.ts

### 3.4 内联单用途适配器

经验证后，将真正单用途的适配器文件内联到调用方：
- `approval-detail.ts`（仅 approval.ts 导入）→ 内联到 approval.ts 或 CliServices
- 其他单用途文件按需合并

### Phase 3 验证

```bash
npm run build
npm run typecheck
npm run test -w @rdk-moss/agent
npm run lint
npm run verify  # 完整验证：boundaries + hygiene + build + typecheck + lint + test
```

---

## 关键文件清单

### 新建文件
| 文件 | 用途 |
|---|---|
| `packages/moss-agent/test/loop-steering.spec.mjs` | SteeringEngine + 4 规则测试 |
| `packages/moss-agent/test/loop-follow-up-guard.spec.mjs` | follow-up-guard 纯函数测试 |
| `packages/moss-agent/test/loop-context-budget-planner.spec.mjs` | 上下文预算规划测试 |
| `packages/moss-agent/test/loop-compact-hooks.spec.mjs` | CompactHookRegistry 测试 |
| `packages/moss-agent/test/loop-pending-tool-aborts.spec.mjs` | 待中止工具调用测试 |
| `packages/moss-agent/test/loop-compaction-timeout.spec.mjs` | 压缩超时测试 |
| `packages/moss-agent/src/cli/config-manager.ts` | ConfigManager 类 |
| `packages/moss-agent/src/cli/model-catalog-manager.ts` | ModelCatalog 类 |
| `packages/moss-agent/src/cli/cli-services.ts` | CliServices 外观 |

### 修改文件
| 文件 | 变更 |
|---|---|
| `packages/moss-agent/src/cli/config.ts` | 函数委托给 ConfigManager |
| `packages/moss-agent/src/cli/model-catalog.ts` | 函数委托给 ModelCatalog |
| `packages/moss-agent/src/cli/repl.ts` | 使用 CliServices |
| `packages/moss-agent/src/cli/tui.ts` | 使用注入的 ConfigManager |
| `packages/moss-agent/src/cli/approval.ts` | 使用 ConfigManager |
| 14 个 config.ts 导入方 | 迁移到 ConfigManager |
| 3 个 model-catalog.ts 导入方 | 迁移到 ModelCatalog |
| `CHANGELOG.md` | 记录所有变更 |

---

## 端到端验证

每个 Phase 完成后执行：

```bash
# 1. 构建
npm run build

# 2. 类型检查
npm run typecheck

# 3. 单元测试
npm run test -w @rdk-moss/agent

# 4. Lint
npm run lint

# 5. 完整验证（Phase 3 后）
npm run verify
```

**成功标准**：
- Phase 1：6 个新测试文件全部通过，现有测试不回归
- Phase 2：类型检查无错误，现有测试不回归，config.ts 导出数不增加
- Phase 3：`npm run verify` 全部通过，CHANGELOG 已更新

---

## AGENTS.md 合规性

- **无模块级可变状态**：ConfigManager/ModelCatalog/CliServices 均为实例化类，不创建模块级单例。config.ts 中的默认实例是无状态的（env 不可变），可接受。
- **boundary 规则**：不引入 product-host 路径依赖；不引入新外部依赖
- **API 稳定性**：config.ts 和 model-catalog.ts 的现有导出保留（委托模式），不破坏下游消费者
- **CHANGELOG**：每个 Phase 完成后更新 CHANGELOG.md
