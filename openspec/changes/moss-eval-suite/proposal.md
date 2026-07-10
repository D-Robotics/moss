## Why

Moss 已有 eval 基础设施（`EvalSuite`、`EvalRunner`、`EvalDriver`、6 种 metrics），但缺少体系化的评测用例和基准数据集。当前功能对齐率（vs Claude Code）估计约 65%，但所有指标均为"未量化"——没有量化标准就无法证明"更好"，也无法在迭代中防回归。按照 Moss 开发方案 Phase 1 要求，评测体系是当前最大短板，需要优先建设。

## What Changes

- 新增 **Layer 1 单工具单元测试套件**：覆盖全部 24 个内置工具的正确性、边界条件和异常输入，约 55 个用例
- 新增 **Layer 2 场景端到端测试套件**：覆盖新增功能、修 Bug、重构、探索、文档生成、多步复杂任务等 6 类场景，约 30 个用例
- 新增 **Layer 3 回归测试框架**：版本对比基线用例，约 10 个用例
- 新增 **对抗性测试套件**：模糊需求、错误输入、安全边界等，约 12 个用例
- 新增 **CLI 运行器**：`moss eval run` 命令，支持按套件/层级运行，输出文本/JSON 报告
- 新增 **自定义 metrics**：3 个新指标（代码质量、轮次效率、完成度），补充现有 6 个通用指标

## Capabilities

### New Capabilities
- `eval-tool-unit-tests`: Layer 1 — 单工具正确性 + 边界条件 + 异常输入测试，覆盖文件/搜索/exec/Web/patch/subagent/device/skill/browser 等全部工具类别
- `eval-scenario-e2e-tests`: Layer 2 — 场景级端到端测试，覆盖新增功能、Bug 修复、重构、项目探索、文档生成、多步复杂任务
- `eval-regression-tests`: Layer 3 — 回归测试框架，版本对比基线，历史失败用例快照
- `eval-adversarial-tests`: 对抗性用例，模糊需求、错误信息、边界条件、安全边界
- `eval-cli-runner`: CLI 运行器入口，支持 `moss eval run --suite <name>` 按套件运行，输出文本/JSON 报告

### Modified Capabilities
<!-- 无现有 spec 需要修改 -->

## Impact

- **Affected code**: `packages/moss-agent/src/eval/` — 新增 `suites/` 目录（4 个套件文件 + index.ts）、`run-eval.ts` CLI 入口、`metrics.ts` 扩展（新增 3 个 metric 函数）
- **Dependencies**: 无外部新依赖，全部复用现有 `EvalSuite`/`EvalRunner`/`EvalDriver` 基础设施
- **Breaking changes**: 无
- **CI integration**: 后续可集成到 CI pipeline，每次提交自动跑 Layer 1 + Layer 3