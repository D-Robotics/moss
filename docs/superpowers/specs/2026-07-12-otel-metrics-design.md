# OTel Metrics + 采样（spec2）

> 2026-07-12 · 分支 2026_07_08 · 给 Moss 加 metrics 指标采集，经 OTel SDK → OTLP 发到现有 receiver → SQLite → 面板；trace 不动，仅加简易采样。这是"补齐监控四个短板"系列的第 2 个 spec（spec1 持久化已完成）。

## 一、背景

spec1 做完持久化后，receiver 重启不丢、面板可查历史。但**只有 trace，没有 metrics**——想看"今天烧了多少 token""哪个工具平均最慢""错误率趋势"这种时序指标，得从 trace 一条条数。本 spec 补 metrics，顺势补 trace 采样。

spec1 已建立的存储地基（SQLite + receiver + 清理 + 面板契约）被本 spec 复用：metrics 走同一 receiver、同一 SQLite、同一面板，只加端点/表/区。

## 二、目标与范围

**目标：** 给 Moss 加 metrics 指标采集（LLM token/调用、工具耗时/成功率、会话指标），经 OTel SDK → OTLP 发到现有 receiver → SQLite → 面板可见；trace 完全不动，仅给手写 bridge 加简易采样（默认 1.0）。让"看趋势"成为可能。

**纳入范围：**
- Moss 引入 `@opentelemetry/api` + `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-metrics-otlp-http`（这次真用）
- 用 SDK Meter 定义三类指标的 Counter/Histogram，在现有业务点（LLM 调用、tool.execute、session 结束）记录
- OTLP metrics exporter 发到 `:4318/v1/metrics`
- receiver 加 `/v1/metrics` 端点 + SQLite `metrics` 表 + `/api/metrics` 读端点
- 面板加 metrics 概览区
- trace 简易采样：手写 bridge 加 traceId-hash 比例采样，默认 1.0，`MOSS_TRACE_SAMPLE_RATIO` 可配

**排除范围：** trace 迁 SDK（留作未来）、运行时进程指标（可选/后续）、跨进程 propagation（spec3）、Prometheus/Grafana（以后加 Collector 即可）。

**关键取舍：**
- 只 metrics 接 SDK，trace 仍用现有手写 bridge（风险小）。
- metrics 开关独立于 trace（可只开一个，互不依赖）。
- trace 采样用简易版（不迁 SDK），只影响发送、不影响 span 树结构。

## 三、架构

```
Moss 业务点（LLM调用/tool.execute/session结束）
  └─ meter.record... → PeriodicExportingMetricReader（10s 批量）
                          └─ OTLPMetricExporter
                               ↓ POST :4318/v1/metrics
                          otel-receiver.mjs
                               └─ SQLite metrics 表（持久化，复用 spec1 机制）
                               ↑ /api/metrics（面板读）
                          面板 :3000 metrics 概览区

  trace（不变）→ otel-bridge.ts（手写，加采样：ratio<1 时跳过 sendSpan）
```

核心：metrics 是 trace 旁的一条**独立**链路，复用 receiver/SQLite/面板基建，trace 不动。

## 四、指标定义

OTel 原语：Counter（只增计数）、Histogram（分布/耗时）。

### LLM 类
| 指标名 | 类型 | 属性 | 来源 |
|---|---|---|---|
| `moss.llm.tokens` | Counter | `direction=input/output`、`model` | 每次 LLM 调用，从 `llm-usage` 数据 |
| `moss.llm.calls` | Counter | `model`、`status=ok/error` | 每次 `agent.llm_turn` |
| `moss.llm.duration_ms` | Histogram | `model` | LLM 调用耗时 |

### 工具类
| 指标名 | 类型 | 属性 | 来源 |
|---|---|---|---|
| `moss.tool.calls` | Counter | `tool`、`status=ok/error` | 每次 `tool.execute` |
| `moss.tool.duration_ms` | Histogram | `tool` | 工具调用耗时 |

### 会话类
| 指标名 | 类型 | 属性 | 来源 |
|---|---|---|---|
| `moss.session.count` | Counter | `outcome=completed/error/cancelled/...` | 每个 session 结束 |
| `moss.session.duration_ms` | Histogram | `outcome` | 会话总耗时 |
| `moss.session.turns` | Histogram | — | 会话轮次数 |

**设计决定：**
- 指标名前缀统一 `moss.`，遵循 OTel 命名（小写点分）。
- 属性用低基数维度（model/tool/outcome/direction/status）。**禁用** sessionKey/runId 等高基数维度（撑爆存储与 cardinality）。
- token 用 Counter（累加量），耗时一律 Histogram（能看 p50/p99）。
- 记录点在**各业务调用点**各自记（`agent-loop-llm-call.ts`/`execute-tool-call.ts`/`moss-agent.ts`），数据在手边，且 metrics 与 trace 解耦（trace 没开 metric 也能记）。

## 五、组件改动

### 5.1 Moss 侧：`observability/metrics.ts`（新增）

- `MeterProvider` + resource attributes（`service.name`，默认 moss，与 trace 一致）。
- `meter = provider.getMeter('moss-agent')`，创建三类指标实例，导出供业务点 import。
- `enableOtelMetrics(options)`：serviceName、exportUrl（默认 `http://localhost:4318/v1/metrics`）、exportInterval（默认 10000）。在 cli-main 启动时调一次。
- `disableOtelMetrics()`：关闭、flush。
- 未启用时返回 noop 实例（零开销，对称 trace 的 noop tracer）。
- 用 `PeriodicExportingMetricReader` + `OTLPMetricExporter`（10s 批量发，解决每条一次 fetch）。

### 5.2 Moss 侧：业务点记录（修改 3 文件）

- `agent-loop-llm-call.ts`：LLM 调用后记 `moss.llm.tokens`(in/out)、`moss.llm.calls`、`moss.llm.duration_ms`。
- `execute-tool-call.ts`：工具调用后记 `moss.tool.calls`、`moss.tool.duration_ms`。
- `moss-agent.ts`：session 结束记 `moss.session.count`、`moss.session.duration_ms`、`moss.session.turns`。

### 5.3 Moss 侧：`cli-main.ts`（修改）

- 加 `enableOtelMetrics()` 调用，环境变量门控（见 §六）。
- 与 `enableOtelTracing()` 并列，独立开关。

### 5.4 Moss 侧：`otel-bridge.ts`（修改，加采样）

- `OtelSpanState` 加 `sampled: boolean`。
- root span：`sampled = hash(traceId) < ratio`（hash 取 traceId 前若干 hex 转 [0,1)）。
- 子 span：从 parentState 继承 `sampled`。
- `sendSpan`：`if (!state.sampled) return;` 跳过未采样的——**采样只影响发送，不影响 span 树结构**（未采样的 span 仍建，保证 parentSpan 链完整）。
- `ratio` 从 `MOSS_TRACE_SAMPLE_RATIO` 读，默认 1.0。

### 5.5 receiver：`otel-receiver.mjs`（修改）

- 新增 `/v1/metrics` POST 端点（解析 OTLP metrics JSON → 写 `metrics` 表）。
- 新增 SQLite `metrics` 表 + 索引（见 §七）。
- 新增 `/api/metrics` GET 端点（`?name=`、`?since=` 过滤，返回最近 N 数据点）。
- metrics 概览区面板统计（今日 token/工具调用/会话数）走 `/api/metrics` 聚合。

### 5.6 receiver：面板 UI（修改）

- 顶部统计区旁加 metrics 概览卡：今日 token 入/出、工具调用数、会话数/成功率。
- 数据从 `/api/metrics` 取。

### 5.7 `observability/index.ts`（修改）

- 导出 `enableOtelMetrics`/`disableOtelMetrics` 及 metrics 实例。

### 5.8 `D:\otel\README.md`（修改）

- 后端 A 段补 metrics 说明（端点 `/v1/metrics`、`MOSS_METRICS_*` 环境变量）。

## 六、配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MOSS_METRICS_URL` | `http://localhost:4318/v1/metrics` | OTLP metrics 端点 |
| `MOSS_METRICS_ENABLED` | — | 设非空值即开启 |
| `MOSS_METRICS_EXPORT_INTERVAL` | `10000` | 导出周期 ms |
| `MOSS_METRICS_SERVICE_NAME` | `moss` | resource service.name |
| `MOSS_TRACE_SAMPLE_RATIO` | `1.0` | trace 采样比例（0~1），只影响发送 |

## 七、SQLite metrics 表

| 列 | 类型 | 说明 |
|---|---|---|
| `time` | INTEGER | 毫秒（数据点时间） |
| `name` | TEXT | 指标名 |
| `kind` | TEXT | `counter`/`histogram` |
| `value` | REAL | 数值 |
| `attrs` | TEXT | 维度 JSON 串 |

索引 `idx_metrics_name_time(name, time)`。**不设主键**（metrics 时序点允许多行，靠清理定时器删超期）。复用 spec1 的 `cleanupOld` 扩展：删 `metrics` 表超期行。

## 八、错误处理

- metrics SDK 初始化失败 → 日志，降级 noop（不让 metrics 搞挂 Moss）。
- receiver `/v1/metrics` 解析失败 → 400，不崩。
- exporter 发送失败 → SDK 内部处理，不报错给 Moss。
- 原则：metrics 与 trace 同为 fire-and-forget，监控永不反噬被监控方。

## 九、测试与验证

1. **metrics 端到端**：开 metrics → 跑 Moss 对话 → `/api/metrics` 查到 `moss.llm.tokens` 等 → 面板概览卡有数。
2. **采样独立性**：`MOSS_TRACE_SAMPLE_RATIO=0` → trace 不发、metrics 照发（独立）。
3. **持久化**：metrics 存 SQLite，重启不丢（复用 spec1 机制）。
4. **`npm run verify` 全绿**（Moss 仓库，metrics.ts 不破坏现有）。
5. receiver 纯 JS，手动端到端（沿袭 spec1）。

## 十、改动清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `packages/moss-agent/src/observability/metrics.ts` | 新增 | MeterProvider + 三类指标 + enable/disable |
| `packages/moss-agent/src/observability/index.ts` | 修改 | 导出 metrics |
| `packages/moss-agent/src/observability/otel-bridge.ts` | 修改 | 加简易采样 |
| `packages/moss-agent/src/cli-main.ts` | 修改 | enableOtelMetrics 调用 |
| `packages/moss-agent/src/core/loop/agent-loop-llm-call.ts` | 修改 | 记 LLM 指标 |
| `packages/moss-agent/src/core/tools/execute-tool-call.ts` | 修改 | 记工具指标 |
| `packages/moss-agent/src/core/agent/moss-agent.ts` | 修改 | 记会话指标 |
| `packages/moss-agent/package.json` | 修改 | 加 3 个 @opentelemetry/* 依赖 |
| `D:\otel\otel-receiver.mjs` | 修改 | /v1/metrics + metrics 表 + /api/metrics + 面板 |
| `D:\otel\README.md` | 修改 | 补 metrics 说明 |
| `docs/observability.md` | 修改 | 补 metrics 启用文档 |

## 十一、验收清单

- [ ] Moss 引入 3 个 `@opentelemetry/*` 包，`npm run verify` 全绿
- [ ] `metrics.ts` + enable/disable，noop 兜底
- [ ] 三类指标在业务点记录
- [ ] receiver `/v1/metrics` + `metrics` 表 + `/api/metrics`
- [ ] 面板 metrics 概览区有数
- [ ] trace 采样：ratio=0 不发 span、metrics 照发
- [ ] metrics 重启不丢
- [ ] `D:\otel\README.md` + `docs/observability.md` 补 metrics 说明

## 十二、后续

- spec3：跨进程 W3C context propagation（web_search/web_fetch 下游）
- 未来：trace 迁 SDK（统一两套、白得 ParentBased 正经采样 + propagation）
- 可选：运行时进程指标（host-metrics）
