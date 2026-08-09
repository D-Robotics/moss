---
title: Moss-Drobotics 可观测性（埋点）重新设计
status: draft
date: 2026-07-16
owner: tongchun.zhao
---

# 重新埋点：D:\moss-drobotics 可观测性设计

## 1. 背景与目标

`D:\moss-drobotics` 是 `D-Robotics/moss` 最新代码的克隆，目前**没有任何运行时可观测性**：LLM 调用、工具执行、session 这些核心环节既不发 trace 也不发 metric，出问题只能靠日志盲猜。

参考实现 `D:\moss-from-remote`（用户的 fork）已经加了完整的 OTel 埋点，能发 trace+metric 到本地 receiver（端口 4318）并在 3000 面板展示。但它有一处技术债：**tracing 手写 OTLP/JSON（`otel-bridge.ts`，刻意零 SDK 依赖），metrics 却用了官方 `@opentelemetry/sdk-metrics`**——注释自己立的「不引入 SDK」原则被 metrics 打破，导致 trace 与 metric 各造一套 Resource、两套发送逻辑。

本设计目标：**从头为 moss-drobotics 埋点，纠正混搭债，同时保留本地文件 trace**。不是把 from-remote 原样搬过来。

### 设计原则

1. **一处 SDK**：tracing 与 metrics 同源，共享一个 Resource、一个 NodeSDK 实例。消除 from-remote 的混搭。
2. **本地文件 trace 保留**：作为独立 SpanProcessor 落盘，与 OTLP exporter 并存（不是 from-remote 那套手写 tracer + 单独 exportSpan）。
3. **YAGNI**：不搬 `ab-testing.ts`（A/B 测试不属可观测性）、不搬 from-remote 的 `trace-exporter.ts` 老实现（它假设了手写 tracer 的 SerializedSpan 形状，SDK 模式下重写为 SpanProcessor）。
4. **error 走 recordException**：异常自动记成 span event，redact 仍套在 message 上防敏感信息泄露。
5. **优雅 flush**：进程退出前 flush 残留 span/metric，不丢末批数据。
6. **零改动业务语义**：埋点不改变任何现有控制流，关闭时零开销（noop 桩）。

## 2. 架构

### 2.1 三层 span 结构

贴合 agent 真实调用栈（drobotics 实际代码：`moss-agent.chat()` → `agent-loop` 主循环 → `executeLlmTurn` / `processLlmResponse` → `executeOneToolCall`）：

```
moss.session           ← moss-agent.chat() 整个用户回合（根 span，1 个/用户消息）
├─ moss.agent.turn     ← agent-loop 主循环每轮迭代（N 个/session）
│  ├─ moss.llm.request ← executeLlmTurn 里单次 LLM 调用
│  └─ moss.tool.invoke ← executeOneToolCall 里单次工具执行（可并行）
```

上下文传播用 OTel SDK 自带的 `context` + `AsyncLocalStorage`（SDK 内部已实现），**业务代码不需要手动透传 `parentSpan` 参数**。这是对 from-remote 那套「到处传 parentSpan」的简化——手写桥接才需要手动透传，SDK 模式下子 span 自动继承当前 context 的父 span。

### 2.2 数据流

```
业务调用点 (withSpan / mossMetrics.xxx)
        │
        ▼
TracerProvider / MeterProvider  (NodeSDK 装配)
   ├── BatchSpanProcessor ──► OTLPTraceExporter  ──► http://localhost:4318/v1/traces
   ├── FileSpanProcessor   ──► traces.jsonl 落盘  (本地文件 trace，新增)
   └── PeriodicMetricReader ─► OTLPMetricExporter ──► http://localhost:4318/v1/metrics
                                                          │
                                                          ▼
                                                   本地 receiver (D:\otel)
                                                   面板 localhost:3000
```

三个 exporter 共享同一个 Resource（`service.name` + `service.version` + `process.*`），后端看到的 trace、metric、本地文件 resource 属性完全一致。

## 3. 文件组织

```
packages/moss-agent/src/observability/
  index.ts            ← 公共入口：initObservability / shutdownObservability / withSpan / mossMetrics
  sdk.ts              ← NodeSDK 装配、Resource、三个 exporter/processor 集中一处
  tracing.ts          ← withSpan 包装、attributes 构造器（turn/tool/llm/session）、Tracer handle
  metrics.ts          ← mossMetrics 句柄 + instruments 定义
  file-trace.ts       ← FileSpanProcessor + JSONL 落盘 + getStats 聚合（重写自 trace-exporter）
  redact.ts           ← 保留（drobotics 已有，与 from-remote 一致，不动）
  llm-usage.ts        ← 保留（drobotics 已有，本地 usage 日志，与埋点无关，不动）
```

对比 from-remote：砍掉 `otel-bridge.ts`（手写 OTLP/JSON，被 SDK 取代）、`ab-testing.ts`（非可观测性）；`trace-exporter.ts` 重写为 `file-trace.ts`（从「手写 tracer 的 SerializedSpan 落盘」改为「SDK SpanProcessor 落盘」，形状对齐 SDK 的 `ReadableSpan`）。

## 4. 组件设计

### 4.1 `sdk.ts` —— SDK 装配

单一初始化点。tracing 与 metrics 同一个 NodeSDK，共享 Resource。

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BatchSpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { semconv } from '@opentelemetry/semantic-conventions';
import { FileSpanProcessor } from './file-trace.js';

export interface ObservabilityConfig {
  serviceName: string;
  otlpUrl: string; // receiver 根地址，如 http://localhost:4318
  enabled: boolean; // tracing 开关
  metricsEnabled: boolean;
  fileTraceEnabled: boolean;
  workspaceDir: string; // 落盘到 {workspaceDir}/.moss/analytics/traces.jsonl
}

let sdk: NodeSDK | null = null;

export function initObservabilitySdk(cfg: ObservabilityConfig): void {
  if (!cfg.enabled) return;
  const pkg = readPackageVersion(); // 读 packages/moss-agent/package.json 的 version
  const resource = resourceFromAttributes({
    [semconv.ATTR_SERVICE_NAME]: cfg.serviceName,
    [semconv.ATTR_SERVICE_VERSION]: pkg, // 当前 0.5.3，但不硬编码
  });

  const spanProcessors: SpanProcessor[] = [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${cfg.otlpUrl}/v1/traces` })),
  ];
  if (cfg.fileTraceEnabled) {
    spanProcessors.push(new FileSpanProcessor(cfg.workspaceDir));
  }

  const readers = cfg.metricsEnabled
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${cfg.otlpUrl}/v1/metrics` }),
          exportIntervalMillis: 10_000,
        }),
      ]
    : [];

  // NodeSDK 的 metricReader 选项接单个 MetricReader；若需要多 reader，
  // 用底层 MeterProvider({ resource, readers }) 自行装配（from-remote 即如此）。
  // 本设计单 metric reader，走 NodeSDK 即可：
  sdk = new NodeSDK({
    resource,
    spanProcessors,
    metricReader: readers[0], // 单数；readers 为空时 undefined，metrics 关闭
  });
  sdk.start();
}

export async function shutdownObservabilitySdk(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown(); // flush 残留 span/metric
  sdk = null;
}
```

### 4.2 `tracing.ts` —— withSpan 与 attributes

```typescript
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import { errorMessage } from '../errors.js';
import { redactSensitiveData } from './redact.js';

const tracer = trace.getTracer('moss-agent');

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const span = tracer.startSpan(name, { attributes });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err); // 异常自动记成 event：type/message/stack
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: redactSensitiveData(errorMessage(err)), // message 上 redact
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// attributes 构造器：集中定义 span 维度，避免散落
export const sessionAttributes = (runId: string, model: string, sessionKey: string) => ({
  runId,
  model,
  sessionKey,
});
export const turnAttributes = (runId: string, turn: number, model: string) => ({
  runId,
  turn,
  model,
});
export const llmAttributes = (runId: string, model: string, inputTokens: number) => ({
  runId,
  model,
  inputTokens,
});
export const toolAttributes = (runId: string, toolName: string, toolCallId: string) => ({
  runId,
  toolName,
  toolCallId,
});
```

注意：drobotics 现有 `agent-loop-llm-call.ts:133` 已经在用 `withSpan('agent.llm_turn', turnAttributes(...))`。迁移时 span 名从 `agent.llm_turn` 改为 `moss.llm.request`（命名规范统一），attributes 构造器签名保持不变以最小化调用点改动。

### 4.3 `metrics.ts` —— instruments

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('moss-agent');

export const mossMetrics = {
  // LLM
  llmTokens: meter.createCounter('moss.llm.tokens', { unit: '{token}' }),
  llmDuration: meter.createHistogram('moss.llm.request.duration', { unit: 'ms' }),
  // tool
  toolInvocations: meter.createCounter('moss.tool.invocations'),
  toolDuration: meter.createHistogram('moss.tool.invoke.duration', { unit: 'ms' }),
  // session
  sessionCount: meter.createCounter('moss.session.count'),
  sessionDuration: meter.createHistogram('moss.session.duration', { unit: 'ms' }),
  sessionToolCount: meter.createHistogram('moss.session.tool_count'), // 纠正错位：每轮工具数，不是 turns
};
```

SDK 的 `meter` 在未 `setGlobalMeterProvider` 时返回 noop meter，instruments 都是 noop——关闭即零开销，业务代码无条件调用 `.add()`/`.record()`，与 from-remote 的 noop 模式一致。

### 4.4 `file-trace.ts` —— 本地文件 trace（SpanProcessor 重写）

from-remote 的 `TraceFileExporter` 假设手写 tracer 产出的 `SerializedSpan`。SDK 模式下重写为 `SpanProcessor`，消费 SDK 的 `ReadableSpan`：

```typescript
import { SpanProcessor, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import fs from 'node:fs/promises';
import path from 'node:path';

const FLUSH_INTERVAL_MS = 30_000;

export class FileSpanProcessor implements SpanProcessor {
  private buffer: ReadableSpan[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private file: string;

  constructor(workspaceDir: string) {
    this.file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  onStart(): void {} // 无需处理
  onEnd(span: ReadableSpan): void {
    this.buffer.push(span);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const snapshot = this.buffer.splice(0);
    const lines = snapshot.map(serializeSpan).join('\n') + '\n';
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, lines, 'utf-8');
    } catch {
      /* never block agent */
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
  async forceFlush(): Promise<void> {
    await this.flush();
  }
}
```

`serializeSpan` 把 `ReadableSpan` 拍平成 JSONL 一行（name / startTimeUnixNano / endTimeUnixNano / attributes / events / status），形状对齐 from-remote 的 `SerializedSpan` 便于复用其 `getStats` 聚合逻辑（保留 stats 面板能力）。

### 4.5 `index.ts` —— 公共入口与初始化

```typescript
import { initObservabilitySdk, shutdownObservabilitySdk } from './sdk.js';

export interface InitOptions {
  workspaceDir: string;
  serviceName?: string;
  otlpUrl?: string;
}

export function initObservability(opts: InitOptions): void {
  const enabled = process.env.MOSS_OTEL_ENABLED === '1' || !!process.env.MOSS_OTEL_URL;
  if (!enabled) return; // noop
  initObservabilitySdk({
    serviceName: process.env.MOSS_OTEL_SERVICE_NAME ?? opts.serviceName ?? 'moss',
    otlpUrl: process.env.MOSS_OTEL_URL ?? opts.otlpUrl ?? 'http://localhost:4318',
    enabled: true,
    // tracing 开则 metrics 默认开（纠正 from-remote 两个开关易漏配）
    metricsEnabled: process.env.MOSS_METRICS_ENABLED !== '0',
    // 本地文件 trace：默认开（用户要求保留），MOSS_FILE_TRACE=0 关
    fileTraceEnabled: process.env.MOSS_FILE_TRACE !== '0',
    workspaceDir: opts.workspaceDir,
  });
}

export { shutdownObservabilitySdk as shutdownObservability } from './sdk.js';
export {
  withSpan,
  sessionAttributes,
  turnAttributes,
  llmAttributes,
  toolAttributes,
} from './tracing.js';
export { mossMetrics } from './metrics.js';
export { FileSpanProcessor } from './file-trace.js';
```

`redact.ts`、`llm-usage.ts` 的导出从 drobotics 现有 `index.ts` 保留。

## 5. 调用点（5 处业务 + 1 处工具函数）

| #   | 文件                                   | 埋什么                                                                            | drobotics 现状                                       |
| --- | -------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | `cli-main.ts`                          | `initObservability()` 一次（agent 创建前）；退出时 `shutdownObservability()`      | 仅有 `setTracer('console')`                          |
| 2   | `core/agent/moss-agent.ts`             | `chat()` 开 `moss.session` 根 span + session metrics（count/duration/tool_count） | 无                                                   |
| 3   | `core/loop/agent-loop.ts`              | 主循环每轮迭代外包 `moss.agent.turn` span（新增这层）                             | 无                                                   |
| 4   | `core/loop/agent-loop-llm-call.ts`     | `withSpan('moss.llm.request')` + llm metrics                                      | 已有 `withSpan('agent.llm_turn')`，需改名+加 metrics |
| 5   | `core/tools/execute-tool-call.ts`      | `withSpan('moss.tool.invoke')` + tool metrics                                     | 无                                                   |
| 6   | `tools/web-fetch.ts` + `web-search.ts` | `propagation.inject(headers)` 注入 traceparent（收敛到一个工具函数）              | 无                                                   |

对比 from-remote：少一处「手动透传 parentSpan」（SDK 自动传播）；web-fetch/web-search 的 `injectTraceparent` 改用 SDK `propagation.inject`。

## 6. 环境变量

| 变量                      | 默认                    | 作用                                                         |
| ------------------------- | ----------------------- | ------------------------------------------------------------ |
| `MOSS_OTEL_ENABLED`       | unset=关                | 总开关（设 `1` 或配 `MOSS_OTEL_URL` 即开）                   |
| `MOSS_OTEL_URL`           | `http://localhost:4318` | OTLP 根地址                                                  |
| `MOSS_OTEL_SERVICE_NAME`  | `moss`                  | service.name                                                 |
| `MOSS_METRICS_ENABLED`    | tracing 开时默认开      | 设 `0` 单独关 metrics                                        |
| `MOSS_FILE_TRACE`         | 开                      | 设 `0` 关本地文件 trace                                      |
| `MOSS_TRACE_SAMPLE_RATIO` | 1.0                     | 采样率（SDK TailSampling 或 ParentBased，初版可用 alwaysOn） |

对比 from-remote：去掉了需要同时设 `MOSS_OTEL_ENABLED` + `MOSS_METRICS_ENABLED` 的冗余（tracing 开则 metrics 默认开）。

## 7. 依赖

`packages/moss-agent/package.json` 新增（drobotics 当前一个 OTel 包都没有）：

```json
"@opentelemetry/api": "^1.9.0",
"@opentelemetry/sdk-node": "^0.200.0",
"@opentelemetry/sdk-trace-base": "^0.200.0",
"@opentelemetry/sdk-metrics": "^2.9.0",
"@opentelemetry/exporter-trace-otlp-http": "^0.200.0",
"@opentelemetry/exporter-metrics-otlp-http": "^0.220.0",
"@opentelemetry/resources": "^2.9.0",
"@opentelemetry/semantic-conventions": "^1.43.0"
```

**版本对齐策略（关键，避免歧义）**：OTel JS 分两条版本线——experimental `0.x`（`sdk-node` / `sdk-trace-*` / `exporter-trace-*`，仍带 `-experimental` tag）与 stable `1.x`/`2.x`（`api` / `sdk-metrics` / `resources` / `semantic-conventions`）。两者可共存——from-remote 已用 `api@1.9 + sdk-metrics@2.9 + exporter-metrics-otlp-http@0.220` 验证可跑。本设计补充 tracing 的 experimental 包，与 metrics 现有版本线各自向前对齐：tracing 侧统一 `^0.200`，metrics 侧沿用 from-remote 的 `^2.9` / `^0.220`。

实现时以 `npm install` 实际解析的版本为准，不锁死补丁号；若 `sdk-node@0.200` 与 `sdk-metrics@2.9` 出现 peer 冲突，优先把 tracing experimental 包升到与 `exporter-metrics-otlp-http@0.220` 同一 experimental 线（`^0.220`），保持 experimental 包彼此对齐。

## 8. 关闭即零开销

- 未 `setGlobalMeterProvider` 时，`metrics.getMeter()` 返回 noop meter，所有 instrument 是 noop——`.add()`/`.record()` 无条件调用零成本。
- `trace.getTracer()` 返回的 tracer 在未注册 provider 时是 noop tracer，`startSpan` 返回 noop span。
- `initObservability()` 在 `enabled=false` 时直接 return，不启动任何 timer/SDK。
- 业务代码不写任何 `if (tracingEnabled)` 分支——全靠 noop 桩。

## 9. 错误处理

- `initObservability` 失败（receiver 连不上、SDK 构造异常）只记一行 log，不抛——监控是 best-effort。
- `withSpan` 里业务抛错时 `recordException` + `setStatus(ERROR)`，再原样 rethrow——埋点不吞错误。
- `FileSpanProcessor.flush` 落盘失败静默——不阻塞 agent。
- 进程退出：`process.on('beforeExit', shutdownObservability)` 兜底 flush；CLI 正常退出路径也显式调用。

## 10. 验证

1. `npm install` 装齐依赖后 `npm run -w @rdk-moss/agent build` 通过（TS 类型对齐）。
2. `MOSS_OTEL_ENABLED=1 node packages/moss-agent/dist/cli.js` 跑一次对话，确认：
   - receiver（4318）收到 trace（session→turn→llm/tool 三层 span 在面板能展开成树）。
   - 4318 收到 metrics（token/duration/invocation 计数）。
   - `.moss/analytics/traces.jsonl` 有落盘内容，行数 = span 数。
3. 不设任何 env 跑一次，确认无报错、无额外开销、无文件产生。
4. 关掉 receiver 跑一次，确认 agent 正常工作（fire-and-forget）。

## 11. 不做（YAGNI）

- 不搬 `ab-testing.ts`——A/B 测试是实验框架，与可观测性无关。
- 不做分布式 context 跨进程传播（moss 是单进程 CLI，W3C traceparent 注入出站 HTTP 已够）。
- 不做 TailSampling——本地单机，alwaysOn 采样即可，`MOSS_TRACE_SAMPLE_RATIO` 预留但初版不接。
- 不做 metrics 语义到 OTel GenAI semconv 的完整对齐（那是另一项工作），只保证命名清晰、单位正确。
