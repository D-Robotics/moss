# Moss Agent 开发方案（基于现有代码的差距分析与路线图）

## 一、现状概述

Moss 已完成 Claude Code 对标的核心能力建设，**不是一个从零开始的项目**。本文档基于现有代码审计结果，重新梳理已完成模块、待补强模块和新增方向。

### 1.1 已完成的核心能力

| 模块 | 实现文件/路径 | 完成度 |
|------|-------------|--------|
| **基础工具**（文件读写、搜索、exec、目录、Web、附件） | `core/tools/`、`tools/` | ✅ 完整 |
| **权限护栏**（safetyMode、approvalPolicy、trusted/deniedTools、guardrails input/output 正则阻断/脱敏） | `cli/config.ts`、`safety/` | ✅ 完整 |
| **上下文管理**（compaction、micro-compact、pruning、stale-read-invalidate、overflow recovery） | `context/` | ✅ 完整 |
| **错误恢复**（Steering Engine 4 条内置规则、Tool Loop Guard、连续错误熔断、correction message 注入） | `core/loop/steering.ts`、`core/tools/tool-loop-guard.ts` | ✅ 完整 |
| **任务状态持久化**（Goal mode pause/resume/complete、TaskFrame 工作上下文追踪、中断恢复） | `core/agent/moss-agent.ts`、`core/goal/` | ✅ 完整 |
| **Harness 运行时**（Hook 系统 PreToolUse/PostToolUse/SessionStart、Tracing、日志） | `core/tools/tool-hooks.ts`、`observability/` | ✅ 完整 |
| **流式输出 + TUI**（实时终端输出、进度展示、可中断） | `cli/tui.ts`、`provider/pi-ai-stream-parser.ts` | ✅ 完整 |
| **Skill 体系**（SKILL.md 可插拔架构、builtin skills、auto-learning、候选人审核 promote） | `skills/`、`skill-learning/` | ✅ 完整 |
| **MCP 集成**（mcp.json 配置、server 状态管理） | `cli/config.ts`（mcp 字段）、`mesh/` | ✅ 完整 |
| **多 Provider**（DeepSeek/Qwen/OpenAI/Anthropic/OpenAI 兼容接口） | `provider/provider-presets.ts` | ✅ 完整 |
| **API Key 加密存储**（AES-256-GCM、文件权限 600） | `cli/config.ts`（encryptApiKey/decryptApiKey） | ✅ 完整 |
| **链路监控**（LLM usage log、run metrics、tracing、run observer） | `observability/` | ⚠️ 基础完备，缺用户行为埋点 |

### 1.2 Moss 超越 Claude Code 对标范围的差异化能力

| 能力 | 说明 |
|------|------|
| **子 Agent 编排** | fan-out 并行派发、pipeline 串行链式、5 种作用域裁剪（read-only/explore/plan/verify/full），单次运行最多 8 个子 Agent |
| **设备/板卡连接** | SSH 透传、ROS2 全套工具、外设诊断（温度/BPU/摄像头）、Jetson/树莓派知识 |
| **Agent Mesh** | LAN 发现、多 Agent 通信、transport 层 |
| **Prompt Cache** | stable/dynamic 分层，减少 token 消耗 |
| **Skill 自学习** | 从成功会话自动提取 Skill 候选，用户审核 promote 后落盘 |
| **零配置启动** | 内置 D-Robotics 网关，无需 API Key 即可使用 |

---

## 二、差距分析：待补强模块

### 2.1 评测体系（P0 — 当前最大短板）

**现状**：moss 有 eval 基础设施（`eval/eval-driver.ts`、`eval/eval-tool.ts`、`eval/metrics.ts`），但缺乏体系化的评测框架和基准数据集。

**需建设**：

```
评测体系三层架构：
├── Layer 1: 单工具单元测试
│   - 每个工具的正确性 + 边界条件 + 异常输入
│   - 指标：精确率（工具调用参数正确率）、召回率（该调的工具是否调了）
│   - 执行方式：自动化脚本，CI 集成
│
├── Layer 2: 场景级端到端测试
│   - 固定任务集（如 "给项目加一个 REST API 端点"、"修复一个已知 bug"）
│   - 评分维度：
│     · 完成度：任务目标是否达成
│     · 代码质量：是否引入新问题、是否遵循项目风格
│     · 轮次效率：完成任务消耗的 LLM 轮次
│     · 工具效率：工具调用次数是否合理（不过度也不过少）
│   - 复用 moss 已有的 VERDICT: PASS/FAIL/PARTIAL 裁决格式
│
└── Layer 3: 回归测试
    - 每个版本跑固定用例集，对比历史得分
    - 自动检测 "修复了 A 但搞坏了 B" 的回归
    - CI 集成 + 结果可视化 dashboard
```

**评测数据集设计原则**：

1. **覆盖工具边界**：大文件、空文件、二进制文件、特殊字符路径
2. **覆盖任务类型**：新增功能、修 bug、重构、探索未知项目、文档生成
3. **覆盖难度梯度**：单步任务 → 多步任务 → 需子 Agent 编排的复杂任务
4. **对抗性用例**：模糊需求（Agent 应主动追问）、错误信息（Agent 应识别并报告）

**量化对齐率**：

```
功能对齐率 = 实际得分 / 满分 × 100%

评分维度权重：
- 基础工具正确性: 25%
- Agent 执行能力（规划/恢复/效率）: 40%
- 安全与交互: 20%
- 高级功能（Skill/MCP/子Agent）: 15%

分级参考：
- <30%: 基础聊天机器人
- 30-60%: 简单任务可替代
- 60-80%: 日常开发主力
- >80%: 可正面竞争
```

### 2.2 数据闭环（P1 — 有基础，需体系化）

**现状**：moss 已有 Skill Learning（从成功会话自动提取 Skill 候选）、Session Events 记录、run metrics 采集。但缺少结构化的数据闭环 pipeline。

**需建设**：

```
数据闭环技术路径：
├── 采集层
│   [已有] run metrics（轮次、工具调用、token 消耗）
│   [已有] session events（完整会话回放）
│   [已有] LLM usage log
│   [需补] 用户反馈采集：隐式（用户纠正消息）→ 显式（👍/👎 按钮）
│   [需补] 纠错行为标记：用户说 "不对，应该是..." 的模式识别
│
├── 分析层
│   [已有] error classification（llm-error-classifier.ts）
│   [需补] 失败模式聚合：自动聚类失败原因（工具调用失败 vs 规划错误 vs 理解偏差）
│   [需补] 热点分析：哪些工具/场景最容易出问题
│   [需补] 用户满意度信号提取
│
└── 优化层
    [已有] Skill Learning（auto-distill 从成功会话提取 Skill）
    [需补] 失败案例 → Prompt 优化建议（半自动）
    [需补] 高频指令 → 快捷 Skill 模板
    [需补] A/B 测试框架：新 Prompt/策略 vs 旧版本，量化效果差异
```

### 2.3 模型路由策略（P1 — 新增模块）

**现状**：moss 支持多 Provider 切换，子 Agent 支持 model override（`moss-agent.ts:981`），但没有自动路由。

**需建设**：

```
模型路由策略：
├── 按任务复杂度路由
│   - 简单问答（"这个文件是干什么的"）→ 小模型（便宜）
│   - 复杂任务（"给项目加一个微服务"）→ 大模型（强）
│   - 探索子 Agent → 便宜模型
│   - 验证子 Agent → 强模型
│
├── 按成本路由
│   - 设置每日/每任务 token 预算
│   - 预算耗尽自动降级到便宜模型
│
├── 故障降级
│   - 主模型不可用 → 自动切备用模型
│   - 主模型超时 → 重试一次后切备用
│
└── 按延迟路由
    - 交互式场景优先低延迟模型
    - 后台任务可用高延迟大模型
```

### 2.4 专用 Git 工具（P2 — 工具层补全）

**现状**：moss 通过通用 `exec` 工具执行 git 命令，但没有专用 Git 工具。

**需建设**：

| 工具 | 功能 | 安全考量 |
|------|------|---------|
| `git_diff` | 查看工作区/暂存区 diff | 只读，无需确认 |
| `git_status` | 查看工作区状态 | 只读 |
| `git_commit` | 创建 commit | 需确认，可限制 commit message 格式 |
| `git_branch` | 切换/创建分支 | 切换分支需确认 |
| `git_log` | 查看提交历史 | 只读 |

### 2.5 修改前自动备份（P2 — 安全补强）

**现状**：moss 没有修改前自动备份机制。

**需建设**：

- `write_file` / `edit_file` / `apply_patch` 执行前自动备份原文件
- 备份存储：`.moss/backups/<timestamp>/` 目录
- 回滚命令：`/undo` 或 `moss rollback` 恢复最近一次修改
- 备份清理策略：保留最近 N 次备份，自动清理过期备份

---

## 三、新增方向：构建差异化壁垒

### 3.1 设备/机器人能力（Moss 独有优势）

moss 的设备连接、ROS2 工具、外设诊断是 Claude Code 不具备的能力。应作为核心竞争力重点建设。

**建议方向**：

- 设备端 Skill 市场（社区贡献 RDK 板卡 Skill）
- 设备端 Agent 部署（子 Agent 直接在板卡上运行）
- 设备诊断报告（一键生成板卡健康报告）
- 多设备协同（一个 Agent 同时操控多块板卡）

### 3.2 多 Agent 协作协议

moss 已有 Agent Mesh 基础设施（LAN 发现、transport），可以扩展为：

- 多 Agent 任务协商（谁擅长什么就干什么）
- 跨机器 Agent 通信（开发机 Agent ↔ 板卡 Agent）
- Agent 间知识共享（Skill 同步、Memory 共享）

---

## 四、更新后的优先级排序

| 优先级 | 模块 | 当前状态 | 下一步 |
|--------|------|---------|--------|
| **P0** | 评测体系 | ⚠️ 最薄弱 | 建设三层评测架构 + 基准数据集 |
| **P0** | 基础工具维护 | ✅ 已完成 | 补专用 Git 工具、持续修 bug |
| **P0** | 权限护栏维护 | ✅ 已完成 | 补修改前自动备份、diff 预览 |
| **P1** | 数据闭环 | ⚠️ 部分完成 | 基于 Skill Learning 体系化 |
| **P1** | 模型路由策略 | ❌ 未开始 | 按复杂度/成本/延迟自动选模型 |
| **P1** | 链路监控补强 | ⚠️ 基础完成 | 补用户行为埋点、失败热点分析 |
| **P2** | Skill 生态 | ✅ 已完成 | 社区贡献 + Skill 市场 |
| **P2** | MCP 生态 | ⚠️ 基础完成 | 更多内置 MCP Server |
| **P2** | 设备能力深化 | ✅ 已完成 | 设备端 Agent 部署、多设备协同 |
| **P3** | 多 Agent 协作 | ⚠️ 基础完成 | 任务协商、跨机器通信 |

---

## 五、实施路线图

### Phase 1（1-2 个月）：补齐评测 + 安全补强

```
□ 建设单工具单元测试框架（CI 集成）
□ 编写 30+ 场景端到端测试用例
□ 建立 V0 基线版本，记录各项指标
□ 实现修改前自动备份（write_file/edit_file/apply_patch）
□ 实现 /undo 回滚命令
□ 开发专用 Git 工具（git_diff、git_status、git_commit、git_branch）
```

### Phase 2（2-4 个月）：数据闭环 + 模型路由

```
□ 用户反馈采集（隐式纠正 + 显式 👍/👎）
□ 失败模式自动分类与聚合
□ 基于分析结果的 Prompt 优化 pipeline
□ 模型路由策略（按任务复杂度自动选模型）
□ 故障降级（主模型不可用自动切备用）
□ 用户行为埋点补全
```

### Phase 3（4-6 个月）：差异化 + 生态

```
□ 设备端 Agent 部署（子 Agent 在板卡上运行）
□ 多设备协同操控
□ Skill 社区市场
□ 多 Agent 协作协议
□ 评测结果可视化 dashboard
```

---

## 六、关键指标

| 指标 | 当前估计 | Phase 1 目标 | Phase 2 目标 |
|------|---------|-------------|-------------|
| 功能对齐率（vs Claude Code） | ~65% | 75% | 85% |
| 端到端任务通过率 | 未量化 | 70% | 80% |
| 单工具正确率 | 未量化 | 95% | 98% |
| 平均任务轮次效率 | 未量化 | 建立基线 | 优化 20% |
| 用户纠正率 | 未采集 | 开始采集 | 降低 30% |
| Skill 自动学习转化率 | 已有 | 量化基线 | 提升 50% |

---

## 七、总结

Moss 已经是一个功能完整的生产级 Agent 框架，不是原型或 Demo。当前阶段的重点应从"功能建设"转向"质量量化 + 体验优化 + 差异化壁垒"：

1. **评测体系是第一优先级**——没有量化标准就无法证明"更好"
2. **数据闭环让优化有据可依**——基于 Skill Learning 已有基础，体系化数据采集和分析
3. **模型路由降低使用成本**——自动选择合适模型，让用户不用关心底层
4. **设备/机器人能力是独有壁垒**——Claude Code 做不到的事，Moss 能做到