## Context

Moss 已有 eval 基础设施（`EvalSuite`/`EvalRunner`/`EvalDriver`/6 种 metrics），位于 `packages/moss-agent/src/eval/`。当前缺少的是体系化的评测用例和运行入口。本设计基于现有基础设施，新增评测套件和 CLI 运行器，不引入外部依赖，不修改现有 eval 核心模块。

## Goals / Non-Goals

**Goals:**
- 提供可直接运行的评测套件，覆盖 Layer 1（单工具）、Layer 2（场景 E2E）、Layer 3（回归）、对抗性测试
- 每个套件是一个独立 TypeScript 模块，导出 `EvalSuite` 实例
- 新增 CLI 运行器，支持按套件名/层级运行，输出文本/JSON 报告
- 新增 3 个自定义 metrics：代码质量、轮次效率、完成度
- 所有用例遵循 `EvalCase` 接口，与现有 `EvalRunner` 完全兼容

**Non-Goals:**
- 不修改 `EvalSuite`/`EvalRunner`/`EvalDriver` 核心逻辑
- 不引入 CI 集成（Phase 2）
- 不实现评测结果可视化 Dashboard（Phase 3）
- 不实现自动回归检测（Phase 2）

## Decisions

### Decision 1: 套件组织方式 — 按层级分文件

**选择**: 每个层级一个独立 `.ts` 文件，通过 `suites/index.ts` 统一导出。

**理由**: 清晰分层，便于按需运行和独立维护。每个文件约 15-55 个用例，大小可控。

**备选方案**: 单一大文件 vs YAML/JSON 配置。JSON 更易维护但因缺少代码逻辑无法复用现有 TypeScript 类型；单文件太大不便协作。

### Decision 2: 用例定义方式 — 纯 TypeScript 实例

**选择**: 直接用 `new EvalSuite({...})` 构造套件，每个 case 是 `EvalCase` 对象。

**理由**: 利用 TypeScript 类型检查，编译期即可发现用例格式错误；可直接引用 `metrics.ts` 中的 metric 函数，无需映射表。

**备选方案**: 通过 `loadEvalSuiteFromConfig()` 加载 JSON 配置。更易维护但失去类型安全，需维护 metric 名称→函数映射。

### Decision 3: 新增 Metrics — 3 个

**选择**:
- `codeQualityMetric`: 检测代码规范性（缩进一致性、未使用变量引用、空 catch 块等）
- `stepEfficiencyMetric`: 基于预期步骤数 vs 实际步骤数评估效率
- `completionMetric`: 多维度完成度评分（包含多个子项的 checklist）

**理由**: 现有 6 个 metrics 偏通用（精确匹配、包含检查等），无法评估代码质量和任务完成度。新 metrics 针对 Agent 场景设计。

### Decision 4: CLI 运行器 — 新增 `run-eval.ts`

**选择**: 在 `eval/` 目录下新增 `run-eval.ts`，提供 `runSuite()` 和 `runAllSuites()` 函数，复用 `EvalDriver`。

**理由**: 轻量级，不依赖额外 CLI 框架。`EvalDriver` 已提供超时、重试、并发控制。

### Decision 5: 输出格式

**选择**: 支持两种输出格式 — 文本（`EvalRunner.formatReport()`）和 JSON（`EvalRunner.formatReportJson()`）.

**理由**: 文本适合人工阅读，JSON 适合 CI 集成和后续 Dashboard 消费。

## Risks / Trade-offs

- **[用例维护成本]**: 107 个用例需持续维护 → 用例按稳定度分层：L1（高稳定，工具接口不变则用例不变）优先实现，L2（中稳定，场景可能调整）次之
- **[Mock 依赖]**: Layer 2 场景 E2E 需要 mock LLM 响应 → 用例设计为"输入-期望输出"对，不依赖真实 LLM 调用，通过 `EvalRunner` 直接评估响应文本
- **[覆盖率盲区]**: 无法覆盖所有工具的所有边界 → 优先覆盖高频使用场景和已知问题点，后续迭代补充

## Open Questions

- 是否需要在 `metrics.ts` 中新增 metrics，还是放在 `suites/` 目录下作为自定义函数？→ 建议放在 `suites/custom-metrics.ts`，避免修改核心模块
- 是否需要为每个用例定义 `expectedToolCalls`？→ 建议 Layer 1 必填，Layer 2 可选