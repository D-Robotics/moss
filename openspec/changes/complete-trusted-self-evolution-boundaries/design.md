## Context

第一至第三阶段已经把 Plan、v2 Experience、TerminalVerdict、LearningEvent、候选补丁、发布、shadow A/B 和回滚串联起来，并在 RDK X5 上验证了失败到恢复的可信证据链。当前不足不是“没有闭环”，而是证据资格与因果解释仍偏粗：设备证据没有显式 execution domain，多 Skill 任务只有任务级归因，跨信号仅有少数专用 verifier，且 A/B assignment 虽记录 treatment/control，却没有在 outcome 端证明 treatment guidance 确实进入了该次 Agent 上下文。

所有日志必须保持 append-only、隐私最小化和历史可读。设备测试必须是只读或可控、无破坏性的。自动化不能把模型总结、模拟成功或用户意见提升为客观 proof。

## Goals / Non-Goals

**Goals:**

- 把 simulation/local/real 作为贯穿 Experience、Terminal、Learning、Patch 和 Experiment 的显式信任域。
- 只在步骤证据能唯一映射到一个 Skill 时进行多 Skill 归因。
- 补齐四个优先 RDK Skill 的机器验收契约，并验证其安全执行路径。
- 将跨信号变为可审计记录，而非运行时布尔回调的瞬时结果。
- 确保 A/B 的 treatment outcome 只在实际 guidance exposure 可证时计入，并输出效果与成本结论。

**Non-Goals:**

- 不让 simulation proof 自动折算为 real proof。
- 不用语言模型猜测多 Skill 因果责任。
- 不对危险硬件写入、ISP 参数落盘或不可逆系统配置做自动真板实验。
- 不把统计不显著解释为“没有效果”，也不因一次真实成功自动激活。

## Decisions

### 1. 执行域由可信运行时注入并逐层传播

新增 `ExecutionDomain = local | simulation | real` 和 `realEvidenceEligible`。CLI 的真实设备会话以完成身份探针作为 `real`；测试/模拟器必须显式标为 `simulation`；无设备的软件任务为 `local`。日志消费者只接受字段的保守交集，缺字段历史记录视为 legacy/audit-only。

对设备 Skill，Promotion proof、发布和 A/B outcome 必须同时满足 `executionDomain=real`、完整环境指纹和 `realEvidenceEligible=true`。模拟失败仍可生成负向诊断，但模拟成功不能增加真实置信度。候选的模拟置信度与真实置信度分别聚合，首次真板执行的真实计数为零。

替代方案是从环境指纹或工具名推断执行域；拒绝该方案，因为 mock、SSH 和本地代理会造成不可审计的误判。

### 2. 多 Skill 采用证据所有权归因，不采用贡献度估计

Plan step 的 `expectedAccept` 定义契约所有权，Experience 的 `stepId/evidenceId/contractSkill` 定义执行证据映射。若某次失败或恢复相关的新鲜 evidence 只关联一个步骤且该步骤只属于一个 Skill，则记录 `single-owner-step` 归因；否则保持 `multi-skill/none`，不产生 Skill proof。多 Skill 任务的整体 pass 只保留任务级审计，不把成功分发给全部 Skill。

替代方案包括平均分配、Shapley 值或模型解释；本阶段拒绝，因为没有受控干预时这些数值不是可信因果证据。

### 3. 跨信号作为带来源的 append-only observation

新增跨信号记录，包含 skill、task/run/evidence、channel、verdict、环境和时间。Promotion 要求主 acceptance 与至少一个不同 channel 的 pass 关联同一 task/run/evidence，且 verifier 配置声明两者独立。对图像采集可使用命令输出与文件元数据/解码；对模型推理可使用结构化检测输出与产物图像/独立解析。仅仅重复解析同一 stdout 不算独立信号。

替代方案是继续保留 `CrossSignalVerifier(skill): boolean`；它可作为兼容适配器，但不能单独形成新 promotion proof，因为缺少可审计的样本关联。

### 4. A/B outcome 必须携带并校验 exposure receipt

Assignment 创建不可伪造的确定性 `exposureId`。treatment guidance 注入 Agent 上下文时生成 receipt，记录 guidance 内容哈希、patch revision 和注入位置；control 明确记录无 guidance。Outcome 只有在 receipt 与 assignment、run、patch revision 匹配时才计入相应 arm。缺 receipt、treatment 空 guidance、或 control 被污染均进入 invalid/excluded，不参与效果估计。

效果报告保留 Wilson 区间，同时比较纠正次数、Token、耗时、工具调用、成本、安全失败和新增 failure class。激活仍要求最小样本、可信成功率优势和 guardrails；真实实验不为满足阈值而伪造重复硬编码任务。

### 5. Skill 契约只覆盖可安全验收的具体工作流

`rdk-capture-photo` 验证产物存在、非空和可解码；`rdk-isp-tuning` 默认验证只读状态/配置检查，不自动落盘；`rdk-hardware` 验证板型/设备节点等只读事实；`rdk-command-manual` 验证命令查询结果和安全只读命令的退出状态。知识型 Skill 不以“回答看起来正确”作为机器验收。

## Risks / Trade-offs

- [真实 A/B 达到 20/arm 成本高且受模型服务影响] → 运行器支持可恢复审计、无效样本排除和阶段性 inconclusive；绝不降低默认门槛来宣称有效。
- [跨信号看似不同但共享同一故障源] → 配置显式声明 channel/source，测试拒绝相同通道和同一原始载荷的双重解析。
- [步骤粒度不足导致大量多 Skill 结果无法归因] → 保守不计 proof，并在报告中列出 unassigned；后续可通过更细 Plan 改善，而不是猜测。
- [新增日志字段影响历史数据] → 字段追加可选，新生产统一写新 schema；旧数据只读审计，不迁移成可信 proof。
- [真板验收误触写操作] → 契约标注 safetyCritical，回归命令限定只读/临时目录，并对危险谓词 fail closed。

## Migration Plan

1. 先新增类型、日志字段和兼容读取；历史记录保持原样。
2. 让 CLI/ToolContext 写入 execution domain 和 exposure receipt；消费者先 fail closed。
3. 增加多 Skill 归因与跨信号日志，再收紧 Promotion/Candidate/Experiment 资格。
4. 增加四个 Skill 契约和单元测试，随后在已识别的 RDK X5 上执行安全真板回归。
5. 运行真实 Agent A/B；只有达到默认样本门槛且 guardrails 通过才激活，否则保持 shadow/inconclusive。
6. 回滚时仅撤销 learned artifact/active decision；append-only 证据和审计记录保留。

## Open Questions

- 真实 A/B 是否能在当前环境获得足够模型凭据与 40 个非重复、可比的安全任务；若不能，机制实现仍可完成，但效果结论必须保持 `inconclusive`。
- 各 RDK workflow 可用的独立跨信号由板端软件版本决定，运行时需先探测能力并对不可用通道 fail closed。
