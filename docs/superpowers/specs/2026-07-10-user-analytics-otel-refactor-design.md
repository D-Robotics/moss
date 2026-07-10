# 用户埋点 OpenTelemetry 化重构

> 2026-07-10 · 基于现有 tracing 基础设施，将 user-analytics 从自定义事件收集器重构为 Span 数据后处理器

## 一、背景

`user-analytics.ts` 当前状态：
- 自定义事件模型（CorrectionEvent / ToolUsageEvent / SessionEvent / TurnEvent）
- 自定义 JSON 存储（`.moss/analytics/events-*.json`）
- 自定义聚合逻辑（SessionSummary / getAggregateStats / getToolHotspots）
- **零消费者** — 全局单例存在但没有任何代码调用 `track()` 或 `init()`

Moss 已有 `tracing.ts`（TraceRegistry / Tracer / Span / withSpan），默认 noop 实现，开销为零。Agent 循环中已有一处 `withSpan('agent.llm_turn')`。

## 二、设计目标

将埋点从"自定义事件收集"改为"标准 Span 采集"，对接 Moss 现有 tracing 层。

## 三、架构

```
Agent 主循环
  └─ withSpan('agent.llm_turn')   ← 已有
  └─ withSpan('tool.execute')     ← 新增
  └─ withSpan('session')          ← 新增
       ↓
  Tracer 接口（已有，不变）
       ↓
  TraceFileExporter               ← 新增：Span → JSONL 落盘
       ↓
  .moss/analytics/traces.jsonl
```

## 四、组件

### 4.1 TraceFileExporter（新增）

- `init(workspaceDir)` — 创建 `.moss/analytics/` 目录
- `exportSpan(span)` — 内存缓冲，30 秒批量 flush
- `flush()` — 强制落盘
- `cleanup()` — 停止定时器，flush 剩余
- `getStats()` — 从 JSONL 读取聚合统计

SerializedSpan 格式（一行一个 JSON）：
```json
{"name":"tool.execute","startTime":...,"endTime":...,"attributes":{...},"events":[...],"status":"ok"}
```

### 4.2 enableLocalTracing()（tracing.ts 新增）

便捷方法，创建包装了 TraceFileExporter 的 Tracer，Span 结束时自动 `exportSpan()`。

### 4.3 Agent 循环 Span（新增）

- `tool.execute` — 包裹工具调用，记录 toolName / success / durationMs
- `session` — 包裹整个会话，记录 start/end 事件和 outcome

## 五、错误处理

- 写入失败 → 静默丢弃，不阻塞 Agent
- 磁盘满 → flush 跳过，内存清空，console.warn
- JSONL 解析失败 → 跳过损坏行

核心原则：**采集层永不抛出异常影响 Agent 运行**。

## 六、改动清单

| 文件 | 改动 | 行数 |
|------|------|------|
| 新增 `trace-exporter.ts` | 文件写入 + 统计读取 | ~100 |
| 修改 `tracing.ts` | 加 `enableLocalTracing()` | +15 |
| 删除 `user-analytics.ts` | 功能迁移到 trace-exporter | -240 |
| 修改 `observability/index.ts` | 更新导出 | ~10 |
| 修改 `execute-tool-call.ts` | 加 `withSpan` 包裹 | +10 |
| 修改 `moss-agent.ts` | 加 `withSpan` 包裹 | +10 |

## 七、测试

| 文件 | 数量 | 测点 |
|------|------|------|
| `trace-exporter.test.ts` | ~12 | init/exportSpan/flush/JSONL 格式/cleanup/损坏行跳过/读统计 |
| `tracing.test.ts`（补充） | ~3 | enableLocalTracing 后 Tracer 非 noop、Span 结束时自动 export |

## 八、运行方式

默认不启用，零开销。显式启用：

```ts
import { enableLocalTracing } from '@rdk-moss/agent/observability';
enableLocalTracing(workspaceDir);
```