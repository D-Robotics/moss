# OTel Metrics + 采样（spec2）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Moss 加 metrics 指标采集（LLM token/调用、工具耗时/成功率、会话指标），经 OTel SDK → OTLP 发到现有 receiver → SQLite → 面板；trace 不动，仅加简易采样（默认 1.0）。

**Architecture:** metrics 是 trace 旁的独立链路——Moss 用 OTel SDK 的 Meter 采三类指标（Counter/Histogram），PeriodicExportingMetricReader 10s 批量发 OTLP 到 receiver `/v1/metrics`，receiver 写 SQLite `metrics` 表，面板加 metrics 区。trace 不动，仅在手写 otel-bridge 加 traceId-hash 比例采样。复用 spec1 的 receiver/SQLite/清理基建。

**Tech Stack:** Node.js ESM、TypeScript、`@opentelemetry/api` + `@opentelemetry/sdk-metrics` + `@opentelemetry/exporter-metrics-otlp-http`、SQLite（receiver）。改 Moss 仓库（`D:\moss-from-remote`，git）+ `D:\otel`（非 git）。

**对应 spec:** `docs/superpowers/specs/2026-07-12-otel-metrics-design.md`

## Global Constraints

- **trace 不动**：otel-bridge 的父子 span 链接（已提交的 `43fdc6b`）保持，只在 sendSpan 前加采样跳过。不迁 SDK。
- **metrics 开关独立于 trace**：可只开一个，互不依赖；不开 metrics 时业务点的 record 调用是 noop，零开销。
- **采样只影响发送不影响 span 树**：未采样的 span 仍建（保证 parentSpan 链完整），只 sendSpan 跳过。
- **监控永不反噬被监控方**：metrics SDK 初始化失败降级 noop；exporter/receiver 发送失败静默；Moss 不因监控报错。
- **低基数维度**：指标属性只用 model/tool/outcome/direction/status，禁用 sessionKey/runId。
- **环境变量带默认值**：见 §六，全可省。
- **复用 spec1 基建**：receiver 持久化（DELETE+FULL）、清理定时器、面板契约——metrics 加端点/表/区，不改既有。

---

## File Structure

| 文件 | 动作 | 责任 |
|------|------|------|
| `packages/moss-agent/src/observability/metrics.ts` | 新增 | MeterProvider + 三类指标 + enable/disable + noop 兜底 |
| `packages/moss-agent/src/observability/index.ts` | 修改 | 导出 metrics |
| `packages/moss-agent/src/observability/otel-bridge.ts` | 修改 | 加采样（OtelSpanState.sampled + sendSpan 跳过） |
| `packages/moss-agent/src/cli-main.ts` | 修改 | enableOtelMetrics 调用 |
| `packages/moss-agent/src/core/loop/agent-loop-llm-call.ts` | 修改 | 记 LLM 指标 |
| `packages/moss-agent/src/core/tools/execute-tool-call.ts` | 修改 | 记工具指标 |
| `packages/moss-agent/src/core/agent/moss-agent.ts` | 修改 | 记会话指标 |
| `packages/moss-agent/package.json` | 修改 | 加 3 个 @opentelemetry/* 依赖 |
| `D:\otel\otel-receiver.mjs` | 修改 | /v1/metrics + metrics 表 + /api/metrics + 面板区 |
| `D:\otel\README.md` | 修改 | 补 metrics 说明 |
| `docs/observability.md` | 修改 | 补 metrics 启用文档 |

任务顺序：装 SDK 依赖（Task1）→ metrics.ts 骨架（Task2）→ 业务点记指标（Task3）→ cli-main 接线（Task4）→ otel-bridge 采样（Task5）→ receiver /v1/metrics + 表（Task6）→ /api/metrics + 面板区（Task7）→ 文档（Task8）→ 端到端验证（Task9）。

---

### Task 1: 装 @opentelemetry/* 依赖

**Files:**
- Modify: `D:\moss-from-remote\packages\moss-agent\package.json`

**Interfaces:**
- Consumes: 无
- Produces: moss-agent 可 import `@opentelemetry/api`、`sdk-metrics`、`exporter-metrics-otlp-http`。

- [ ] **Step 1: 看 moss-agent/package.json 现有依赖**

Run: `cat /d/moss-from-remote/packages/moss-agent/package.json`
确认 `dependencies` 块（不是 devDependencies——运行时需要）。

- [ ] **Step 2: 加 3 个依赖到 dependencies**

在 `dependencies` 加：
```json
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-metrics": "^1.28.0",
    "@opentelemetry/exporter-metrics-otlp-http": "^0.200.0",
```
（版本以 npm 最新稳定为准，install 时确认。）

- [ ] **Step 3: install + 同步 lockfile**

Run: `cd /d/moss-from-remote && npm install`
Expected: 装成功，无缺失模块错误。

- [ ] **Step 4: 验证可 import + verify 兜底**

Run: `cd /d/moss-from-remote && npm run build`
Expected: tsc 编译通过，无 `Cannot find module '@opentelemetry/...'`。

- [ ] **Step 5: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/package.json package-lock.json
git commit -m "chore(metrics): 加 @opentelemetry metrics 依赖

metrics 指标采集将用官方 SDK Meter。这 3 个是真实运行时依赖
(非上轮删的未用死依赖)，见 spec2。"
```
Expected: 仅 package.json + package-lock.json 入库。

---

### Task 2: metrics.ts 骨架（MeterProvider + 指标 + enable/disable）

**Files:**
- Create: `D:\moss-from-remote\packages\moss-agent\src\observability\metrics.ts`
- Modify: `D:\moss-from-remote\packages\moss-agent\src\observability\index.ts`

**Interfaces:**
- Consumes: Task1 的 SDK 包。
- Produces: `enableOtelMetrics()`/`disableOtelMetrics()` + 导出的指标实例（`metrics` 对象，含 counter/histogram），供 Task3 业务点用。不开时指标实例为 noop。

- [ ] **Step 1: 写 metrics.ts**

创建 `packages/moss-agent/src/observability/metrics.ts`：
```ts
/**
 * OpenTelemetry metrics for Moss.
 *
 * Records LLM token/call, tool duration/success, session metrics via the
 * official OTel SDK Meter. Sent periodically (10s) to an OTLP/HTTP backend
 * (the local receiver's /v1/metrics). Independent of tracing.
 *
 * When not enabled, all record calls are noop — zero overhead.
 */
import { metrics } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

export interface OtelMetricsOptions {
  serviceName?: string;
  url?: string;
  exportIntervalMs?: number;
}

let enabled = false;
let provider: MeterProvider | null = null;

// Noop meter/instruments — used when metrics disabled.
interface NoopCounter { add(_v: number, _a?: Record<string, string>): void {} }
interface NoopHistogram { record(_v: number, _a?: Record<string, string>): void {} }

export const mossMetrics = {
  llmTokens: { add() {} } as NoopCounter,
  llmCalls: { add() {} } as NoopCounter,
  llmDuration: { record() {} } as NoopHistogram,
  toolCalls: { add() {} } as NoopCounter,
  toolDuration: { record() {} } as NoopHistogram,
  sessionCount: { add() {} } as NoopCounter,
  sessionDuration: { record() {} } as NoopHistogram,
  sessionTurns: { record() {} } as NoopHistogram,
};

export function enableOtelMetrics(options: OtelMetricsOptions = {}): void {
  if (enabled) return;
  enabled = true;
  const serviceName = options.serviceName ?? 'moss';
  const url = options.url ?? 'http://localhost:4318/v1/metrics';
  const interval = options.exportIntervalMs ?? 10000;

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
  });
  const exporter = new OTLPMetricExporter({ url });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: interval,
  });
  provider = new MeterProvider({ resource, readers: [reader] });
  metrics.setGlobalMeterProvider(provider);

  const meter = provider.getMeter('moss-agent');
  // Replace noop instances with real ones.
  mossMetrics.llmTokens = meter.createCounter('moss.llm.tokens');
  mossMetrics.llmCalls = meter.createCounter('moss.llm.calls');
  mossMetrics.llmDuration = meter.createHistogram('moss.llm.duration_ms');
  mossMetrics.toolCalls = meter.createCounter('moss.tool.calls');
  mossMetrics.toolDuration = meter.createHistogram('moss.tool.duration_ms');
  mossMetrics.sessionCount = meter.createCounter('moss.session.count');
  mossMetrics.sessionDuration = meter.createHistogram('moss.session.duration_ms');
  mossMetrics.sessionTurns = meter.createHistogram('moss.session.turns');
}

export function disableOtelMetrics(): void {
  if (!enabled) return;
  try { provider?.shutdown(); } catch {}
  enabled = false;
}
```
注：`@opentelemetry/resources`、`semantic-conventions` 是 sdk-metrics 的传递依赖，能直接 import；若 typecheck 报找不到，把它们也加进 Task1 的 dependencies。

- [ ] **Step 2: index.ts 导出**

在 `packages/moss-agent/src/observability/index.ts` 加：
```ts
// OTel metrics
export { enableOtelMetrics, disableOtelMetrics, mossMetrics } from './metrics.js';
export type { OtelMetricsOptions } from './metrics.js';
```

- [ ] **Step 3: typecheck**

Run: `cd /d/moss-from-remote && npm run typecheck`
Expected: 通过。若报 `@opentelemetry/resources` 找不到，回 Task1 加该依赖。

- [ ] **Step 4: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/observability/metrics.ts packages/moss-agent/src/observability/index.ts
git commit -m "feat(metrics): metrics.ts 骨架 - MeterProvider + 三类指标 + enable/disable"
```

---

### Task 3: 业务点记录指标

**Files:**
- Modify: `agent-loop-llm-call.ts`、`execute-tool-call.ts`、`moss-agent.ts`

**Interfaces:**
- Consumes: Task2 的 `mossMetrics`。
- Produces: 业务点调用 `mossMetrics.xxx.add/record(...)`；不开 metrics 时是 noop。

- [ ] **Step 1: agent-loop-llm-call.ts 记 LLM 指标**

在 LLM 调用完成、拿到 usage 后（`withSpan('agent.llm_turn')` 的 fn 体内或之后），加：
```ts
import { mossMetrics } from '../../observability/index.js';
// ...
mossMetrics.llmCalls.add(1, { model, status: ok ? 'ok' : 'error' });
if (usage?.inputTokens) mossMetrics.llmTokens.add(usage.inputTokens, { direction: 'input', model });
if (usage?.outputTokens) mossMetrics.llmTokens.add(usage.outputTokens, { direction: 'output', model });
mossMetrics.llmDuration.record(durationMs, { model });
```
（`model`/`usage`/`durationMs`/`ok` 取该文件 LLM 调用已有的局部变量；若变量名不同，对齐实际。）

- [ ] **Step 2: execute-tool-call.ts 记工具指标**

在 tool.execute 的 `withSpan` fn 体末尾（拿到结果/状态后），加：
```ts
import { mossMetrics } from '../../observability/index.js';
// ...
mossMetrics.toolCalls.add(1, { tool: toolName, status: success ? 'ok' : 'error' });
mossMetrics.toolDuration.record(durationMs, { tool: toolName });
```

- [ ] **Step 3: moss-agent.ts 记会话指标**

在 session span 结束处（`sessionSpan.end()` 前后，或 session 摘要上报那段），加：
```ts
import { mossMetrics } from '../observability/index.js';
// ...
mossMetrics.sessionCount.add(1, { outcome });
mossMetrics.sessionDuration.record(durationMs, { outcome });
mossMetrics.sessionTurns.record(turns);
```

- [ ] **Step 4: typecheck + build**

Run: `cd /d/moss-from-remote && npm run typecheck && npm run build`
Expected: 通过（确认业务点取的变量名/路径都正确）。

- [ ] **Step 5: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/core/loop/agent-loop-llm-call.ts \
        packages/moss-agent/src/core/tools/execute-tool-call.ts \
        packages/moss-agent/src/core/agent/moss-agent.ts
git commit -m "feat(metrics): 业务点记录 LLM/工具/会话指标"
```

---

### Task 4: cli-main 接线 enableOtelMetrics

**Files:**
- Modify: `cli-main.ts`（`enableOtelTracing` 调用旁，约 :619 后）

**Interfaces:**
- Consumes: Task2 的 `enableOtelMetrics`。
- Produces: 设环境变量即开启 metrics。

- [ ] **Step 1: import enableOtelMetrics**

在 cli-main.ts 的 `import { enableOtelTracing } from './observability/otel-bridge.js';` 旁加：
```ts
import { enableOtelMetrics } from './observability/metrics.js';
```

- [ ] **Step 2: 加开启逻辑**

在 `enableOtelTracing` 的 if 块之后加：
```ts
  if (process.env.MOSS_METRICS_URL || process.env.MOSS_METRICS_ENABLED) {
    enableOtelMetrics({
      serviceName: process.env.MOSS_METRICS_SERVICE_NAME ?? process.env.MOSS_OTEL_SERVICE_NAME ?? 'moss',
      url: process.env.MOSS_METRICS_URL ?? undefined,
      exportIntervalMs: process.env.MOSS_METRICS_EXPORT_INTERVAL
        ? Number(process.env.MOSS_METRICS_EXPORT_INTERVAL) : undefined,
    });
  }
```

- [ ] **Step 3: typecheck + build**

Run: `cd /d/moss-from-remote && npm run typecheck && npm run build`
Expected: 通过。

- [ ] **Step 4: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/cli-main.ts
git commit -m "feat(metrics): cli-main 接线 enableOtelMetrics"
```

---

### Task 5: otel-bridge 加简易采样

**Files:**
- Modify: `otel-bridge.ts`

**Interfaces:**
- Consumes: 无
- Produces: trace 按 `MOSS_TRACE_SAMPLE_RATIO`（默认 1.0）采样；只影响 sendSpan 发送，不影响 span 树。

- [ ] **Step 1: OtelSpanState 加 sampled 字段**

在 `otel-bridge.ts` 的 `interface OtelSpanState {` 里加 `sampled: boolean;`。

- [ ] **Step 2: root span 定采样决策**

在 `enableOtelTracing` 里读 ratio（模块级变量）：
```ts
const TRACE_SAMPLE_RATIO = Number(process.env.MOSS_TRACE_SAMPLE_RATIO ?? 1.0);
```
在 root span 创建（`const traceId = parentState?.traceId ?? generateTraceId();` 后）加：
```ts
      const sampled = parentState ? parentState.sampled : sampleByTraceId(traceId, TRACE_SAMPLE_RATIO);
```
`sampleByTraceId` 辅助函数（取 traceId 前 8 hex 转 [0,1) 与 ratio 比）：
```ts
function sampleByTraceId(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  const hex = (traceId.slice(0, 8) || '0').padStart(8, '0');
  const v = Number.parseInt(hex, 16) / 0xffffffff;
  return v < ratio;
}
```
把 `sampled` 放进 `state` 对象。

- [ ] **Step 3: sendSpan 跳过未采样**

在 `sendSpan(state)` 开头加：
```ts
  if (!state.sampled) return;
```

- [ ] **Step 4: typecheck + build + verify**

Run: `cd /d/moss-from-remote && npm run typecheck && npm run build`
Expected: 通过。注意：默认 ratio=1.0 时 `sampleByTraceId` 返回 true，行为不变。

- [ ] **Step 5: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/observability/otel-bridge.ts
git commit -m "feat(observability): otel-bridge 加简易 trace 采样

按 MOSS_TRACE_SAMPLE_RATIO(默认1.0)采样,traceId-hash 比例。
只影响 sendSpan 发送,不影响 span 树结构;子 span 继承父采样决策。"
```

---

### Task 6: receiver 加 /v1/metrics 端点 + metrics 表

**Files:**
- Modify: `D:\otel\otel-receiver.mjs`

**Interfaces:**
- Consumes: Task1-4 发来的 OTLP metrics。
- Produces: metrics 入 SQLite `metrics` 表。

- [ ] **Step 1: 建表 SQL 加 metrics 表**

在 `db.exec(\`...\`)` 里加（spans/sessions 表之后）：
```sql
    CREATE TABLE IF NOT EXISTS metrics (
      time INTEGER NOT NULL,
      name TEXT NOT NULL,
      kind TEXT,
      value REAL,
      attrs TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_name_time ON metrics(name, time);
```

- [ ] **Step 2: 预编译 insertMetric**

在 `insertSession` 后加：
```js
const insertMetric = db.prepare(`
  INSERT INTO metrics (time, name, kind, value, attrs) VALUES (?, ?, ?, ?, ?)
`);
```

- [ ] **Step 3: 加 /v1/metrics POST 端点**

在 `/v1/session-summary` handler 之后加：
```js
  if (req.method === 'POST' && req.url === '/v1/metrics') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const now = Date.now();
        const rows = [];
        for (const rm of data.resourceMetrics ?? []) {
          for (const sm of rm.scopeMetrics ?? []) {
            for (const m of sm.metrics ?? []) {
              const name = m.name;
              const kind = (m.data?.[0])?.value ? Object.keys(m.data[0].value)[0] : 'unknown';
              for (const dp of m.data ?? []) {
                const v = dp.value;
                let value = null;
                if (typeof v?.value === 'number') value = v.value;
                else if (typeof v?.sum === 'number') value = v.sum;
                else if (v?.count) value = v.count;
                const attrs = {};
                for (const a of dp.attributes ?? []) attrs[a.key] = a.value?.value ?? '';
                rows.push([dp.timeUnixNano ? Number(BigInt(dp.timeUnixNano)/1_000_000n) : now, name, kind, value, JSON.stringify(attrs)]);
              }
            }
          }
        }
        const insertMany = db.transaction((rs) => { for (const r of rs) insertMetric.run(...r); });
        try { insertMany(rows); } catch (e) { console.error('[otel-receiver] metrics insert failed:', e.message); }
      } catch {}
      res.writeHead(200);
      res.end(JSON.stringify({ partialSuccess: {} }));
    });
    return;
  }
```

- [ ] **Step 4: cleanupOld 扩展删 metrics**

在 `cleanupOld` 里加一行：
```js
    const m = db.prepare('DELETE FROM metrics WHERE time < ?').run(cutoff);
    if (s.changes || t.changes || m.changes) {
      console.log(`[otel-receiver] cleanup: ${s.changes} spans, ${t.changes} sessions, ${m.changes} metrics removed (>${RETENTION_DAYS}d)`);
    }
```

- [ ] **Step 5: 手动验证收 metrics**

起 receiver，用 curl 发一条假 metric：
```bash
cd /d/otel && node otel-receiver.mjs &
sleep 1
curl -s -X POST http://localhost:4318/v1/metrics -H 'Content-Type: application/json' -d '{"resourceMetrics":[{"resource":{"attributes":[]},"scopeMetrics":[{"scope":{"name":"x"},"metrics":[{"name":"moss.llm.calls","data":[{"timeUnixNano":"1000000000","value":{"value":1},"attributes":[{"key":"model","value":{"stringValue":"gpt"}}]}]}]}]}]}'
sleep 1
# 查库(写临时脚本,见 spec1 经验:从 /d/otel 跑)
```
Expected: metrics 表有 1 行 name=`moss.llm.calls`。停 receiver。

- [ ] **Step 6: 无 git 提交（非 git）**

直接落盘。

---

### Task 7: /api/metrics 读端点 + 面板 metrics 区

**Files:**
- Modify: `D:\otel\otel-receiver.mjs`（UI server 的 http.createServer）

**Interfaces:**
- Consumes: Task6 的 metrics 表。
- Produces: `/api/metrics` 返回指标数据点；面板显示 metrics 概览。

- [ ] **Step 1: 加 /api/metrics GET 端点**

在 `/api/sessions` handler 旁加：
```js
  } else if (req.url.startsWith('/api/metrics')) {
    const u = new URL(req.url, 'http://x');
    const name = u.searchParams.get('name') ?? '';
    const since = Number(u.searchParams.get('since') ?? 0);
    const rows = name
      ? db.prepare('SELECT time, name, kind, value, attrs FROM metrics WHERE name=? AND time>=? ORDER BY time DESC LIMIT 200').all(name, since)
      : db.prepare('SELECT time, name, kind, value, attrs FROM metrics ORDER BY time DESC LIMIT 200').all();
    const out = rows.map(r => ({ time: r.time, name: r.name, kind: r.kind, value: r.value, attrs: JSON.parse(r.attrs || '{}') }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ metrics: out }));
  }
```

- [ ] **Step 2: 面板加 metrics 概览区**

在 UI_HTML 的 stats 区（`<div class="stats">...</div>`）后加一个 metrics 卡片区 + 脚本拉取：
```html
<div id="metricsOverview" class="section-title">指标概览（加载中...）</div>
```
在 `<script>` 的 refresh 函数里加 fetch `/api/metrics`，渲染今日 token/工具调用/会话数。具体渲染逻辑：取最近 metrics 按名字聚合 sum（counter）/ last（histogram），显示到 metricsOverview div。

- [ ] **Step 3: 手动验证**

起 receiver，发几条 metrics，curl `/api/metrics`：
```bash
curl -s 'http://localhost:3000/api/metrics?name=moss.llm.calls' | head -c 300
```
Expected: 返回 metrics 数组。面板浏览器打开 `:3000` 看 metrics 概览区有数。

- [ ] **Step 4: 无 git 提交（非 git）**

直接落盘。

---

### Task 8: 文档补 metrics 说明

**Files:**
- Modify: `D:\otel\README.md`、`docs/observability.md`

**Interfaces:**
- Consumes: Task1-7 的实际行为。
- Produces: 两端文档都补 metrics 启用方式。

- [ ] **Step 1: otel README 后端 A 段补 metrics**

在持久化段后加：
```markdown
### Metrics

receiver 也收 OTLP metrics（`:4318/v1/metrics`），存 SQLite `metrics` 表，面板有指标概览。Moss 侧设 `MOSS_METRICS_URL` 或 `MOSS_METRICS_ENABLED` 开启。
```

- [ ] **Step 2: docs/observability.md 补 metrics 启用**

加一节"Metrics 指标"，列 `MOSS_METRICS_*` 环境变量 + 三类指标清单 + 与 trace 独立 + `MOSS_TRACE_SAMPLE_RATIO` 采样说明。

- [ ] **Step 3: 提交（observability.md 在 git）**

```bash
cd /d/moss-from-remote
git add docs/observability.md
git commit -m "docs(observability): 补 metrics 启用文档"
```
otel README 非 git，直接落盘。

---

### Task 9: 端到端验证

**Files:**
- 无文件改动，仅验证。

**Interfaces:**
- Consumes: Task1-8 全部。
- Produces: 验收清单全勾。

- [ ] **Step 1: npm run verify 全绿**

Run: `cd /d/moss-from-remote && npm run verify`
Expected: 6 pass/0 fail，无 @opentelemetry 相关错误。

- [ ] **Step 2: metrics 端到端**

起 receiver，开 metrics 跑 Moss 对话：
```bash
cd /d/otel && node otel-receiver.mjs &
cd /d/moss-from-remote && MOSS_METRICS_ENABLED=1 MOSS_OTEL_ENABLED=1 node packages/moss-agent/dist/cli.js
# 跑一轮对话
curl -s 'http://localhost:3000/api/metrics?name=moss.llm.tokens' | head -c 300
```
Expected: 能查到 `moss.llm.tokens` 等指标数据点；面板概览区有数。

- [ ] **Step 3: 采样独立性**

```bash
MOSS_TRACE_SAMPLE_RATIO=0 MOSS_METRICS_ENABLED=1 MOSS_OTEL_ENABLED=1 node ...cli.js
# 跑一轮
curl -s http://localhost:3000/api/traces  # 应空（span 不发）
curl -s 'http://localhost:3000/api/metrics'  # 应有（metrics 照发）
```
Expected: trace 空、metrics 有——证明独立。

- [ ] **Step 4: 持久化**

重启 receiver，`/api/metrics` 数据仍在（复用 spec1 机制）。

- [ ] **Step 5: 验收清单核对**

- [ ] 3 个 @opentelemetry/* 包已装，verify 全绿
- [ ] metrics.ts + enable/disable + noop
- [ ] 三类指标业务点记录
- [ ] receiver /v1/metrics + metrics 表 + /api/metrics
- [ ] 面板 metrics 概览区有数
- [ ] 采样独立：ratio=0 不发 span、metrics 照发
- [ ] metrics 重启不丢
- [ ] README + observability.md 补 metrics 说明

- [ ] **Step 6: 收尾报告**

向用户报告 9 任务完成 + 验收状态。

---

## Self-Review 已完成

对照 spec 逐条：
- §5.1 metrics.ts → Task2 ✅
- §5.2 业务点记录 → Task3 ✅
- §5.3 cli-main → Task4 ✅
- §5.4 otel-bridge 采样 → Task5 ✅
- §5.5 receiver /v1/metrics+表 → Task6 ✅
- §5.6 面板 → Task7 ✅
- §5.7 index.ts 导出 → Task2 Step2 ✅
- §5.8 README → Task8 ✅
- §八 测试 → Task9 ✅
- §十一 验收 → Task9 Step5 ✅

无占位符；指标名/环境变量/字段全文一致；采样"只影响发送"逻辑一致；scope 聚焦 metrics+采样。
