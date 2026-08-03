## Why

Moss 已能从可信终局证据形成候选补丁并执行保守发布流程，但仍缺少把“流程闭环”提升为“可证明真实变强”所需的边界：模拟与真板 proof 未形成严格信任域，多 Skill 任务没有步骤级因果归因，部分常用 RDK Skill 没有机器验收契约，跨信号不足，而且现有 A/B 不能保证 Agent 实际收到不同处理。现在需要补齐这些边界，防止自动发布被伪证据、共享终局结果或无效实验污染。

## What Changes

- 为所有可信证据增加执行域和真板资格，禁止 simulation/local 成功增加设备 Skill 的真实 proof；候选首次上真板从零真实置信度开始。
- 对多 Skill Plan 建立步骤所有权和新鲜证据映射；仅在单一 Skill 可保守归因时产生该 Skill 的 proof，任务级成功不再被平均分配。
- 为 `rdk-capture-photo`、`rdk-isp-tuning`、`rdk-hardware`、`rdk-command-manual` 增加可执行工作流的 `ACCEPTANCE.json`，并在 RDK X5 上验证安全谓词。
- 为设备任务建立独立跨信号记录和晋升门槛；主验收与跨信号必须来自不同观测通道并能关联同一执行证据。
- 建立 Agent 暴露感知的真实 A/B：实验组必须实际收到已发布 Skill 指导，对照组不得收到；记录成功率、纠正次数、Token、耗时、工具调用和新失败类型，并支持保守回滚。
- 增加端到端审计和真板回归，区分“发布机制可运行”与“发布后效果显著改善”。

## Capabilities

### New Capabilities

- `execution-domain-trust`: 模拟、本地与真实设备证据的信任边界及真板 proof 资格。
- `multi-skill-attribution`: 多 Skill 任务的步骤级保守因果归因和防污染规则。
- `device-skill-acceptance`: 四个优先 RDK Skill 的机器验收契约及安全真板验证。
- `independent-cross-signal`: 独立观测通道的跨信号采集、关联与晋升判定。
- `agent-exposure-ab`: Agent 实际暴露于 treatment/control 的真实 Skill A/B 和效果判定。

### Modified Capabilities

- `self-evolution-operations`: 将现有候选、实验、发布与回滚流程收紧为只接受符合执行域、归因和跨信号要求的证据。

## Impact

主要影响 `packages/moss-agent` 的 Experience/Learning/Terminal/Patch/Experiment 日志结构、Promotion 与 Trusted coordinators、Plan/Objective/Terminal 运行时注入、RDK Skill 资产和 CLI 自进化报告。新增字段保持追加兼容；历史 v1/v2 日志仍可审计，但不会被追认为新的真板 proof。真板验证仅执行只读或可控、无破坏性的命令。
