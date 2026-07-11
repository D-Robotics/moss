# Trace 收尾 + 本地趋势看板 设计

> 2026-07-11 · 子项目 1（共 5 个监控子项目）

## 一、背景

`D:\moss-from-remote`（`packages/moss-agent`）已实现一套自研 tracing 抽象（`Tracer`/`withSpan`/`TraceRegistry`），并在 agent 主循环接入了三种 span：`session`、`agent.llm_turn`、`tool.execute`，父子链打通。`D:\otel` 提供接收/展示后端（Jaeger all-in-one + 自研 `otel-receiver.mjs` 实时调用链看板）。

但存在多处欠债与断点：

- **未提交接线**：`session` span 创建、`parentSpan` 透传那批改动在工作区脏状态，未 commit。
- **OTLP 逐个发**：`otel-bridge.ts` 每个 `span.end()` 一个 `fetch`，无批量、无背压。
- **本地导出断电**：`enableLocalTracing()` 定义了但无调用点；`TraceFileExporter.getStats()` 写好了但无 CLI 入口读取。
- **测试被 gitignore**：`__tests__/observability/` 下测试存在但不进 CI，无回归保护。
- **env 未文档化**：`MOSS_OTEL_URL`/`MOSS_OTEL_ENABLED`/`MOSS_OTEL_SERVICE_NAME` 在 `docs/env-vars.md` 缺失。
- **会话级数据不落盘**：outcome（completed/error/cancelled/completed_partial）只在 `notifyRunObserver` 发给 otel receiver 的内存里，未进 `traces.jsonl`，趋势图无法画会话质量维度。

本次只做"子项目 1：Trace 采集收尾 + 本地趋势看板"。metrics 管线、结构化日志、sampling、告警为后续子项目，本次仅在采集层预留接口占位。

## 二、范围与边界

**做什么**：补完已写好但没接通的 trace 能力，让监控在**不依赖 docker/Jaeger** 时也能本地用，并能基于沉淀的 JSONL 出历史趋势图。

**不做什么**（留后续 spec）：
- metrics 管线（Prometheus `/metrics` 或 OTLP metrics）
- 结构化日志导出（Loki/ES）
- sampling、resource 丰富、告警
- 改动 `D:\otel\otel-receiver.mjs` 那个实时调用链看板

**两个看板，互不混淆**：

| | 实时调用链看板（已有，不动） | 历史趋势看板（本次新建） |
|---|---|---|
| 数据源 | 内存（otel-receiver 收的 span） | 磁盘 `.moss/analytics/traces.jsonl` + `sessions.jsonl` |
| 回答的问题 | "这次会话的调用链长啥样" | "这段时间工具错误率/耗时趋势如何" |
| 归属 | `D:\otel` | 独立目录/包（新建） |

**成功标准**：
1. `MOSS_TRACE=file` 启动 Moss → 会话结束后 `traces.jsonl` 有完整 `session → agent.llm_turn → tool.execute` 数据，session span 含 outcome。
2. `moss stats --serve` → 浏览器打开本地看板，能看到趋势图（工具调用次数/错误率/平均耗时、会话 outcome 分布、token 趋势）。
3. OTLP 导出改成批量，单会话不再一个 span 一个 HTTP 请求。
4. observability 测试进 CI，env 变量文档化，session span 接线提交。

## 三、组件与改动清单

按"采集层 → 落盘层 → 展示层"三层组织。

### 采集层（`packages/moss-agent/src/observability/` + agent 循环）

| 组件 | 动作 | 说明 |
|---|---|---|
| session span | **改** `moss-agent.ts:1560` | 补会话级属性：`outcome`、`turns`、`toolCalls`、`tokensIn`、`tokensOut`。outcome 在 `teardownAgentLoopRun`/`notifyRunObserver` 中已知，通过 `sessionSpan.setAttribute` 写回 |
| OTLP bridge | **改** `otel-bridge.ts` | 单 span 单 fetch → 内存缓冲 + 定时/满量 flush。模式照抄 `TraceFileExporter`（30s 定时 + 满量阈值） |
| `enableLocalTracing` 接线 | **改** `cli-main.ts:614` | 现只接 `enableOtelTracing`。加 `MOSS_TRACE=file` 分支调 `enableLocalTracing(workspace)` |
| env 文档 | **改** `docs/env-vars.md` | 补 `MOSS_OTEL_URL`/`MOSS_OTEL_ENABLED`/`MOSS_OTEL_SERVICE_NAME`/`MOSS_TRACE` 完整说明 |
| 未提交接线 | **提交** | session span + parentSpan 透传那批脏改动先 commit |
| metrics/log 出口占位 | **新增占位** | `Tracer` 旁留 `Meter` 接口空壳、log 出口空壳，标注 TODO 给后续子项目，不实现 |

### 落盘层（`observability/trace-exporter.ts`）

| 组件 | 动作 | 说明 |
|---|---|---|
| `TraceFileExporter` | 基本不动 | 现有 init/exportSpan/flush/getStats 已够用 |
| local tracer `setAttribute` | **改** `tracing.ts:203` | 现为空实现，改成把属性写进 span 的 attributes，使 outcome 能落进 `traces.jsonl` |
| 会话摘要落盘 | **新增** | `notifyRunObserver` 现只 POST 给 otel receiver。加一路：本地模式下写 `.moss/analytics/sessions.jsonl`（与 `traces.jsonl` 平行） |

**会话级数据双写**：span 上补 outcome（趋势图按 span 维度够用），`sessions.jsonl` 给看板做会话卡片列表（与 otel 看板会话卡片同源）。两者都做，增量很小。

### 展示层（独立目录，本次新建）

| 组件 | 动作 | 说明 |
|---|---|---|
| 趋势看板 | **新增** `packages/moss-analytics-dashboard/` | 一个 node http server 读 `traces.jsonl` + `sessions.jsonl`，serve 内嵌 HTML。结构照搬 `otel-receiver.mjs` |
| `moss stats` 命令 | **新增** CLI 子命令 | `moss stats` 终端打印 `getStats()` 聚合；`moss stats --serve` 起看板 |

## 四、数据流

### 写入流（agent 运行时）

```
MossAgent.run()
  └ session span (startSpan, 初始属性 runId/model/sessionKey)
      └ agent.llm_turn (withSpan, parent=sessionSpan)
          └ tool.execute (withSpan, parent=sessionSpan)
  ...
  teardownAgentLoopRun()
    ├ notifyRunObserver()
    │   ├ 算 outcome (completed/error/cancelled/completed_partial)
    │   ├ sessionSpan.setAttribute('outcome', outcome, turns, toolCalls, tokensIn/Out)  ← 新增
    │   ├ if MOSS_OTEL_URL → POST /v1/session-summary  (已有)
    │   └ if MOSS_TRACE=file → append sessions.jsonl    ← 新增
    └ sessionSpan.end()
        └ Tracer.end() → 按 tracer 类型分流：
           ├ local tracer  → globalTraceExporter.exportSpan() → 缓冲 → 30s flush → traces.jsonl
           ├ otel tracer   → 缓冲 → 30s/满量 flush → OTLP HTTP  (改后)
           └ noop tracer   → 丢弃
```

关键改动点：
1. local tracer 的 `setAttribute` 改成真写入，outcome 才能落进 `traces.jsonl`。
2. otel tracer 的 `setAttribute` 已写进 `mutableAttributes`（`otel-bridge.ts:154`），OTLP 路 outcome 也能带上。两条路一致。

### 读取流（看板）

```
moss stats --serve
  └ 起 node http server (:3100，避开 otel 的 :3000)
      ├ GET /             → 内嵌 HTML 看板
      ├ GET /api/traces   → 读 traces.jsonl，返回 span 数组（按时间倒序，限量）
      ├ GET /api/sessions → 读 sessions.jsonl，返回会话摘要数组
      └ GET /api/stats    → 调 globalTraceExporter.getStats() 返回聚合
  └ 前端 JS 轮询（2s，照搬 otel-receiver）→ 渲染趋势图
```

### 端口/路径约定
- otel 实时看板：`:3000`（已有，不动）
- 新趋势看板：`:3100`
- 数据目录：`<workspace>/.moss/analytics/`（`traces.jsonl` + `sessions.jsonl`）

## 五、错误处理与配置

### 错误处理（统一原则：监控永不阻塞 agent）

| 层 | 失败场景 | 处理 |
|---|---|---|
| 采集层 | `withSpan` 回调内抛错 | 已有：`setStatus(false)` + 重抛（不影响业务异常传播） |
| 采集层 | span 属性写入异常 | 包 try-catch，静默丢弃属性，不影响 span 结束 |
| 落盘层 | `traces.jsonl` 写失败 | 已有：catch 静默，缓冲清空继续 |
| 落盘层 | `sessions.jsonl` 写失败 | 新增：同上，静默丢弃 |
| 落盘层 | JSONL 行损坏 | 已有：`getStats()` 跳过坏行；看板读盘同样跳过 |
| OTLP 导出 | fetch 失败 | 已有静默。批量后：**丢弃不重试**——监控 best-effort，不堆积避免内存涨 |
| 看板 | JSONL 文件不存在 | 返回空数据集，前端显示"暂无数据" |
| 看板 | 端口被占 | server 启动 catch，提示换端口退出，不影响 agent |

核心约束：采集层任何异常都不允许冒泡到 agent 主循环。新增代码保持现有静默 catch 纪律。

### 配置（全部 env 驱动，默认零开销）

| 变量 | 作用 | 默认 |
|---|---|---|
| `MOSS_TRACE` | `console` → stderr span；`file` → 本地 JSONL | 未设 = noop |
| `MOSS_OTEL_ENABLED` | 启用 OTLP 导出（用默认 url） | 未设 = 关 |
| `MOSS_OTEL_URL` | OTLP HTTP 端点 | `http://localhost:4318/v1/traces` |
| `MOSS_OTEL_SERVICE_NAME` | service.name | `moss` |

互斥/组合规则：
- `MOSS_TRACE` 与 OTLP 三变量**独立**，可同时开（一个会话既落本地 JSONL 又发 OTLP）。
- 都不设 → noop tracer，零开销。
- `MOSS_TRACE=console` 和 `MOSS_TRACE=file` 互斥（同一变量不同值）；同时设其他值或冲突时，按 `file` > `console` > noop 优先级取一个，不报错。

## 六、看板图表与测试

### 看板图表（数据维度 → 图）

纯前端渲染，零图表库依赖，用内联 SVG 手写（与 otel-receiver 零依赖风格一致）。

| 区 | 图 | 数据来源 | 说明 |
|---|---|---|---|
| **概览** | 4 个 stat 卡片 | `getStats()` | 总会话数、总 span 数、错误数、平均耗时 |
| **会话区** | outcome 分布饼图 + 会话卡片列表 | `sessions.jsonl` | 饼图按 completed/error/cancelled/completed_partial 分；卡片复用 otel-receiver 会话卡片样式 |
| **趋势区** | 工具调用次数/错误率折线图、各工具平均耗时柱状图、token 趋势折线图 | `traces.jsonl` 按 startTime 时间桶聚合 | 时间窗口可切（近 1h/24h/全部） |

前端图表实现：**内联 SVG 手写**。数据量为会话级（几十到几百条），不需图表库性能；零依赖与现有看板调性一致；hover 用原生 SVG 事件。

### 测试

| 测试 | 位置 | 覆盖 |
|---|---|---|
| `trace-exporter.test.ts` | 已存在（被 gitignore） | 解除忽略，接进 `run-package-tests.mjs` |
| `tracing.test.ts` | 已存在（被 gitignore） | 同上 |
| **新增** otel-bridge 批量导出测试 | `__tests__/observability/` | 缓冲 + flush：多个 span 不立即发、满量/定时才发、fetch 失败静默不抛 |
| **新增** session span outcome 写回测试 | `__tests__/observability/` | `setAttribute('outcome', ...)` 在 local tracer 下真写入 `traces.jsonl` |
| **新增** sessions.jsonl 落盘测试 | `__tests__/observability/` | `notifyRunObserver` 在 file 模式下写会话摘要、写失败不抛 |

测试进 CI：解除 `__tests__/observability/` 的 gitignore，加入 `scripts/run-package-tests.mjs` 运行集。**推翻设计文档原本"gitignore 排除测试"的旧约束**——这层代码已是核心采集层，必须有回归保护。

### 验收

1. `MOSS_TRACE=file moss chat "测试"` → 会话结束后 `.moss/analytics/{traces,sessions}.jsonl` 有数据，traces.jsonl 里 session span 带 outcome。
2. `moss stats --serve` → 浏览器 :3100 看到三区图表，数据与 jsonl 一致。
3. `MOSS_OTEL_ENABLED=1` 起长会话 → 确认 span 批量发而非逐个。
4. `npx vitest run __tests__/observability/` 全绿，且在 CI 里跑。

## 七、后续子项目（本次不实现，预留接口）

- 子项目 2：Metrics 管线（`Meter` 接口占位已在本次预留）
- 子项目 3：结构化日志导出（log 出口占位已在本次预留）
- 子项目 4：Sampling + Resource 丰富
- 子项目 5：告警 + 复盘闭环

各子项目后续独立走 spec → plan → 实现循环。
