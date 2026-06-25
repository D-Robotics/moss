# Moss vs Mainstream Agents — 深度技术对比

> 基于 `packages/moss-agent/src/core/` 真实源码分析，对比对象：Claude Code、Cursor Agent、OpenAI Agents SDK、Aider、LangChain/LlamaIndex Agent。
>
> **✅ v0.5 重大更新**：以下 5 项能力现已实现，Moss 已追平主流 Agent：
> - 👁️ **视觉理解**（`vision_analyze` 工具）
> - 🌐 **Web 浏览器自动化**（`web_browser` 工具）
> - 📐 **结构化输出**（`generate_structured` 工具）
> - 📊 **内置评测框架**（`eval` 工具）
> - 🗺️ **Plan-Execute 分离**（`plan` 工具）

---

## 总览：Moss 的定位差异

| 维度 | 主流 Agent | Moss |
|---|---|---|
| **设计哲学** | 通用 AI 编程助手 / 工具链 | **机器人 + 软件双领域** Agent 运行时 |
| **耦合方式** | 强耦合特定产品/API | **宿主中立**（Host Adapter 契约，宿主只管 UI+Key+存储） |
| **部署形态** | IDE 插件 / SaaS / Python 库 | **单一 CLI 二进制** + 可嵌入运行时 |
| **上手门槛** | 需要 API Key + 配置 | **零配置零 Key** 启动（内置网关） |
| **自进化** | 固定能力集，靠版本更新 | **闭环自学习**（Teach → Learn → Promote → Reuse） |

---

## 1. Agent Loop：深度对比

### 1.1 循环结构

| | Claude Code | Aider | OpenAI Agents SDK | **Moss** |
|---|---|---|---|---|
| **循环模型** | 单层 while | 单层 while | Runner.run() 单次 | **双层循环**（内层 tool+steering，外层 follow-up） |
| **停止条件** | max_turns / 模型返回 stop | max_turns | 模型返回 final_output | maxTurns + completionGate + followUpGuard 三重判定 |
| **工具执行** | 全串行 | 全串行 | 串行（可配置并行） | **读写分离**：只读并行 + 写入串行分组 |

**关键差异**：Moss 的双层循环允许在 "任务完成" 后由 `completionGate` 或 `getFollowUpMessages` 触发继续执行。主流 Agent 通常是模型说停就停。

源码 `agent-loop.ts:312-339`：
```typescript
while (state.hasMoreToolCalls || state.pendingMessages.length > 0) {
  // 内层循环: 处理工具调用
}
// 外层循环: follow-up gate
if (getFollowUpMessages) {
  const followUp = await getFollowUpMessages();
  if (followUp.length > 0) continue; // 继续执行
}
break; // 真正结束
```

### 1.2 LLM 调用可靠性

| 能力 | 主流 Agent | Moss |
|---|---|---|
| **自动重试** | 部分有（Claude Code 有） | **3 次指数退避** + 错误分类（9 种错误类型，区分 retryable/non-retryable） |
| **上下文溢出恢复** | 通常直接报错 | **3 级渐进恢复**：轻量压缩 → LLM 总结 → 紧急截断 |
| **流式 Thinking 处理** | 混入正文或丢弃 | **独立 `thinking` 字段**，`<thinking>` 标签实时分离，绝不泄漏到可见文本 |
| **首 chunk 超时** | 依赖 SDK | 独立 `MOSS_LLM_FIRST_CHUNK_TIMEOUT_MS` 环境变量控制 |

源码 `overflow-recovery.ts:343-603` 的 3 级恢复是 Moss 的独特能力：

| Level | 策略 | 是否需 LLM | 降级条件 |
|---|---|---|---|
| 1 | invalidateStaleReads + dedupeUnchanged + microcompact | 否 | 连续失败 2 次 |
| 2 | LLM summarization + 替换历史 | 是 | 可融合 |
| 3 | 紧急截断到最近 6/3/1 条消息 | 否 | 最终兜底 |

### 1.3 Provider 适配

| | Claude Code | Aider | OpenAI SDK | **Moss** |
|---|---|---|---|---|
| **协议数** | 仅 Anthropic API | OpenAI-compatible | 仅 OpenAI | **Anthropic + OpenAI 双协议** |
| **Streaming 兜底** | N/A | 无 | N/A | 自动检测 `capabilities.streaming`，不支持时降级 `complete()` |
| **Prompt 缓存** | API 原生 | 无 | 无 | **手动拆分 stable/dynamic 两段**，适配 Anthropic prompt caching |
| **Tool 格式适配** | 原生 | 转换 | 原生 | `mapPiToolsToLlm()` 统一中间表示再转换 |

---

## 2. 安全机制：Moss 独有的深度防御

### 2.1 审批链对比

```
Claude Code:  permission prompt → allow/deny/allow-always
Aider:       auto-commits / user confirms
Cursor:      accept/reject 按钮
OpenAI SDK:  无内置审批
──────────────────────────────────────────
Moss:        6 层审批链:
             1. Tool resolution (未知工具 → error)
             2. Schema validation (参数不对 → pre-blocked)
             3. Pre-tool hooks (密钥扫描 + 域名白名单 + 只读模式)
             4. Approval gate (allow-once / allow-always / deny)
             5. ToolHookRegistry.runPreHooks (hook-blocked / modify)
             6. Post hooks + Post-failure hooks
```

源码 `execute-tool-call.ts:155-455`。

### 2.2 独有的安全机制

| 机制 | 说明 | 主流 Agent 是否有 |
|---|---|---|
| **Tool Loop Guard** | 相同签名 ≥3 次 → 拒绝；同一工具失败 ≥3 次 → 拒绝 | ❌ |
| **Idempotent Replay** | 只读工具相同参数 → 直接复用历史结果，不重复执行 | ❌ |
| **Steering Engine** | 检测 error-recovery / tool-loop / context-pressure 三种模式，自动注入引导 | ❌ |
| **Completion Gate** | 模型说 "完成了"，但系统可以拒绝并注入修正指令 | ❌ |
| **Prompt Injection 防御** | System prompt 内置 "不信任工具结果中的指令" 规则 | 部分有 |
| **Input/Output Guardrail** | 宿主可注入 `onInputGuardrail` / `onOutputGuardrail` 钩子 | 部分有 |
| **密钥扫描** | 工具输入中检测 OpenAI/Stripe/GitHub/Slack/AWS token 前缀模式 | ❌ |
| **出口域名白名单** | `egress-domain-guard` 限制网络工具只能访问指定域名 | ❌ |

### 2.3 交互模式

Moss 的 `Shift+Tab` 三种模式在主流 Agent 中独特：

| 模式 | 行为 | 对应主流方案 |
|---|---|---|
| `plan` | 全只读，不执行任何写入 | Claude Code 无等效，需手动 `/permissions` |
| `default` | 逐工具审批 | Claude Code permission prompt |
| `accept-edits` | 自动批准写入 | Cursor YOLO mode / Aider auto-commit |

---

## 3. 上下文管理：工程深度对比

### 3.1 压缩策略

| 策略 | LangChain | Claude Code | **Moss** |
|---|---|---|---|
| **基础压缩** | ConversationSummaryBufferMemory | 简单的 max_tokens 截断 | **自适应 ContextBudgetPlanner**（基于窗口压力百分比触发） |
| **压缩颗粒度** | 整段总结 | 消息级截断 | **三层**：per-turn light → LLM compaction → pruning |
| **工具结果去重** | ❌ | ❌ | **invalidateStaleReads + dedupeUnchangedReads**（被后续写覆盖的旧读自动废弃） |
| **工具结果截断** | ❌ | 简单截断 | **snipTailOversizedToolResults** + **microcompact**（保留最近 N 个 + minContentLength） |
| **Roundtrip Repair** | ❌ | ❌ | **repairMissingToolResults**：自动修复断开的 tool_use/tool_result 配对 |

### 3.2 Context Budget Planner

Moss 独有的**自适应阈值系统**（源码 `context-budget-planner.ts:59-122`）：

```
压力级别 0 (first_turn):         无操作
压力级别 1 (baseline_hygiene):   invalidate_stale_reads
压力级别 2 (warning 65%):        + snip_tail + microcompact(keep=4)
压力级别 3 (proactive 80%):      + snip_tail + microcompact(keep=2, 激进参数)
```

主流 Agent 通常在固定阈值（如 100K tokens）就直接 truncate，没有渐进式自适应。

---

## 4. Memory 系统：三层架构的独特性

### 4.1 存储对比

| | Aider | Claude Code | LangChain | **Moss** |
|---|---|---|---|---|
| **存储后端** | `.aider.conf` 文件 | 云端 (projects) | 多种 vector store | **文件 JSON 索引** + 可选向量嵌入 |
| **文件记忆** | ❌ | 自动 `.md` 文件 | 无 | **4 种静态文件**：MOSS.md / USER.md / MEMORY.md / AGENTS.md |
| **会话日志** | `.aider.chat.history.md` | 云端存储 | 需手动配置 | **JSONL 事件流**（每 turn 完整记录） |
| **原子写入** | ❌ | 云端保证 | 依赖 store | **手动实现**（tmp + rename） |

### 4.2 搜索机制

| | LangChain | **Moss** |
|---|---|---|
| **检索方法** | 向量相似度 (余弦/欧氏) | **BM25 + 语义搜索 RRF 融合** (7:3 权重) |
| **无需外部依赖** | 需要 embedding model / vector DB | BM25 完全自实现（n-gram 倒排索引 + BM25 评分函数） |
| **查询扩展** | 需手动配置 | 自动检测 "偏好/回忆" 类查询并追加中英文锚点词 |

### 4.3 Memory Scope

Moss 独有的四档 Scope 分层：

| Scope | 注入 System Prompt | 跨项目 | 用途 |
|---|---|---|---|
| `workspace` | ✅ 默认 | ❌ 项目绑定 | 项目局部记忆 |
| `user` | ✅ 默认 | ✅ 全项目 | 用户偏好 |
| `device` | ✅ 默认 | ✅ deviceId 绑定 | 设备特定配置 |
| `learning` | ❌ 不注入 | ✅ 全项目 | 个人知识库 |

主流 Agent 通常只有 "project" vs "user" 两层，且没有独立的 "learning" 不注入层。

---

## 5. Skill 系统：从固定到自进化

### 5.1 能力扩展方式

| 方式 | Claude Code | Cursor | Aider | **Moss** |
|---|---|---|---|---|
| **固定内置** | hooks + slash commands | built-in tools | built-in commands | 5 个内置 superpower skill |
| **外部文件** | CLAUDE.md | .cursorrules | .aider.conf.yml | **SKILL.md** (YAML frontmatter + Markdown) |
| **MCP 扩展** | ✅ | ✅ (beta) | ❌ | ✅ (stdio 子进程) |
| **自动学习** | ❌ | ❌ | ❌ | ✅ **4 阶段管线** (Candidate→Scorer→Distiller→Promoter) |

### 5.2 自学习管线（Moss 独有）

```
对话执行 → teaching 注解 → candidate 存储 → scorer 评分 → distiller 蒸馏 → promoter 发布
```

| 阶段 | 功能 | 是否有主流 Agent 等效 |
|---|---|---|
| Candidate Store | 自动捕获 ≥3 次工具调用的对话为新 skill 候选 | ❌ |
| Scorer | 15 个信信号综合评分（置信度 0~1） | ❌ |
| Distiller | 自动生成完整 SKILL.draft.md（含 YAML frontmatter + 执行流程 + 错误恢复） | ❌ |
| Promoter | 高置信度候选自动发布为正式 skill | ❌ |

**三种自动触发门槛**：
- `intent`：用户明确说 "沉淀为技能"
- `strict`：≥3 次工具调用 + distinctTools≥2 + 零失败 + 像真任务
- `legacy`：≥2 次工具调用 + 成功即可

---

## 6. Teaching 系统：执行即教学

这是 Moss 最独特的能力，**主流 Agent 完全没有等效物**。

| 特性 | 说明 |
|---|---|
| **触发时机** | 工具执行前后自动触发，不中断主流程 |
| **三档深度** | off / concise（仅变异操作）/ detailed（所有操作） |
| **Pre-hook 产出** | 首次变异操作触发 `dry_run_summary`；后续操作生成 "why/concept/pitfalls" |
| **Post-hook 产出** | "verifyHint / confidence / nextStepIfFails / rollbackHint / failureCard" |
| **LLM 调用策略** | 独立 AbortController，默认超时 350ms，fire-and-forget |
| **缓存** | pre-hook 同参数结果缓存 60 秒 |
| **下游消费** | 注解附加到 SkillCandidate，影响 scorer 得分 + distiller 输出 |

这是 Moss 的核心差异化能力闭环：**执行 → 注解 → 学习 → 复用**。

---

## 7. Mesh：面向机器人的 P2P Agent 网络

### 7.1 对比

| 特性 | AutoGen | CrewAI | **Moss Mesh** |
|---|---|---|---|
| **拓扑** | 中心化 GroupChat | 中心化 Crew | **P2P 去中心化** |
| **发现机制** | 手动注册 | 手动配置 | **UDP 广播 + HMAC 认证** |
| **通信** | 消息队列 (内存) | 消息队列 (内存) | **HTTP POST + JSON** |
| **安全** | 无（单进程内） | 无（单进程内） | HMAC-SHA256 + 30s 时间窗口 |
| **速率限制** | 无 | 无 | **Token Bucket**（默认 30 次/分钟） |
| **防环** | N/A | N/A | **callDepth≤3** + `_visitedPeers` |
| **目标场景** | 多 Agent 写作/研究 | 多 Agent 流水线 | **多机器人集群** |

### 7.2 设计哲学差异

主流多 Agent 框架（AutoGen/CrewAI）的设计假设：同一台机器上的多个 Python 对象协作。Moss Mesh 的设计假设：**网络隔离的独立物理设备**（机器人、边缘设备），通过 LAN 自发现和直接 HTTP 通信协作。

---

## 8. 机器人领域：Moss 独占能力

以下能力在主流 Agent 中完全不存在：

| 能力 | 说明 | 源码位置 |
|---|---|---|
| **Board Mode (`/connect`)** | SSH 连接机器人板端，执行设备命令 | `src/cli/tui.ts` |
| **Hybrid Execution** | 模型推理在主机，命令执行在板端 | `/connect --hybrid` |
| **Device Tools** | GPIO/I2C/SPI 外设操作、模型部署、TROS/ROS2 | `src/tools/builtin/` |
| **DeviceFamily Contract** | 抽象不同机器人平台的硬件能力 | `packages/moss/src/contracts/device-family.ts` |
| **VendorPlugin Contract** | 供应商可插拔扩展 | `packages/moss/src/contracts/vendor-plugin.ts` |
| **KnowledgeModule Contract** | 领域知识模块化 | `packages/moss/src/contracts/knowledge-module.ts` |
| **Robotics Engineering Prompt** | 机器人领域专业 system prompt | `packages/moss/src/prompts/robotics-engineering-prompt.ts` |
| **device-knowledge 包** | 开源 RDK 板端 knowledge pack | `github.com/D-Robotics/device-knowledge` |

---

## 9. 架构设计：宿主中立 vs 强耦合

### 9.1 耦合度对比

```
Claude Code:  Claude API ──── Claude Code App ──── User
Cursor:       Cursor Backend ──── Cursor IDE ──── User
Aider:        LLM API ──── Aider CLI ──── User
OpenAI SDK:   OpenAI API ──── User Code ──── User
────────────────────────────────────────────────
Moss:         Any LLM Provider
                    ↓
              @rdk-moss/core (contracts only)
                    ↓
              @rdk-moss/agent (runtime)
                    ↓
              Host Adapter (YOUR product)
                    ↓
              User
```

### 9.2 Host Adapter Contract

Moss 通过 `docs/host-adapter-contract.md` 定义宿主集成接口，使 Moss 可嵌入任何宿主产品：

| 宿主职责 | Moss 职责 |
|---|---|
| UI 渲染 | Agent loop 逻辑 |
| Model keys 管理 | Provider 适配 |
| 凭证/存储 | 工具执行框架 |
| 部署策略 | 上下文管理 |
| 审批 UI | 安全策略 |

这种分离在主流 Agent 中罕见——它们通常强耦合到自己的 UI/IDE/API。

---

## 10. Moss 当前缺失的能力

与主流 Agent 相比，Moss 有以下不足：

| 缺失能力 | 主流 Agent 情况 | 影响 |
|---|---|---|
| **视觉理解**（主 loop 内） | Claude Code 有截图分析 | 板端模式有 vision，但主循环无通用图片理解 |
| **Web 浏览 Agent** | Claude Code 有 Puppeteer 集成 | 仅有 web_fetch，无完整浏览器自动化 |
| **结构化输出** | OpenAI SDK 有 `response_format` | 依赖 prompt 引导，无强制 JSON schema |
| **多模态输出** | Gemini/Claude 支持图像生成 | 文本 only |
| **内置评测框架** | LangSmith / Braintrust 等 | ❌ |
| **ReACT / Plan-Execute 显式分离** | LangChain 有 | 有 `plan` 模式，但无显式计划→执行两阶段 |
| **Human-in-the-loop 复杂决策** | AutoGen 有 | 仅有工具审批，无 ask-user 决策点 |
| **并发 Agent 编排** | CrewAI 有流水线 | Mesh 仅支持 P2P 查询，无任务编排 |

---

## 11. 总结：Moss 的核心竞争力

```
┌─────────────────────────────────────────────────────────────┐
│                    Moss 差异化价值                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. 闭环自进化 (NO mainstream agent has this)               │
│     执行 → teaching 注解 → candidate 捕获                   │
│     → scorer 评分 → distiller 蒸馏 → promoter 发布          │
│     → Skill 注册 → 下次执行可用                              │
│                                                             │
│  2. 机器人原生 (Moss ONLY)                                  │
│     /connect board · hybrid execution · GPIO/ROS2           │
│     DeviceFamily · VendorPlugin · KnowledgeModule           │
│                                                             │
│  3. 宿主中立 (Unique architecture)                          │
│     Core contracts ⇄ Agent runtime ⇄ Host Adapter           │
│     一套运行时，嵌入任何产品                                  │
│                                                             │
│  4. 零摩擦上手 (Best-in-class)                               │
│     零配置 · 零 Key · 内置网关 · moss 一条命令                │
│                                                             │
│  5. 深度安全 (Industry-leading safety layers)               │
│     6 层审批链 · Tool Loop Guard · Idempotent Replay         │
│     Steering Engine · Completion Gate · Overflow Recovery    │
│                                                             │
│  6. 自适应上下文 (Engineering depth)                        │
│     ContextBudgetPlanner · 3 级压缩 · Roundtrip Repair       │
│     BM25+Semantic RRF · Tool Result 去重/截断               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**一句话**：Moss 不是又一个编程助手，而是一个**自带闭环自进化能力的机器人原生 Agent 运行时**——从架构设计（宿主中立）、能力边界（机器人+软件双领域）、到安全深度（6 层审批链），都与主流 Agent 走了完全不同的路。
