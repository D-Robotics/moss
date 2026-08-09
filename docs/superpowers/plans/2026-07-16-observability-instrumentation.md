# Moss-Drobotics 可观测性（埋点）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `D:\moss-drobotics` 重新埋入 OpenTelemetry trace+metrics，纠正 from-remote fork 的 tracing/metrics 混搭债，并保留本地文件 trace。

**Architecture:** tracing 与 metrics 同走官方 OTel SDK（`@opentelemetry/sdk-node`），共享一个 Resource；业务代码通过 `withSpan` / `mossMetrics.*` 无条件调用，SDK 在未启用时返回 noop（零开销）；本地文件 trace 实现为 `FileSpanProcessor` 挂到 tracer，与 OTLP exporter 并存。

**Tech Stack:** TypeScript（ESM）、Node.js、OpenTelemetry JS SDK、moss-agent monorepo（包名 `@rdk-moss/agent`）、测试用 plain Node `*.spec.mjs` + `node:assert/strict`（经 `scripts/run-package-tests.mjs` 跑）。

## Global Constraints

- 工作目录：`D:\moss-drobotics`，仓库根。所有 git 命令用 `git -C /d/moss-drobotics` 或先 `cd /d/moss-drobotics`。
- 包：所有代码改在 `packages/moss-agent/`，npm 包名 `@rdk-moss/agent`，workspace 命令形如 `npm run build -w @rdk-moss/agent`。
- ESM：`"type": "module"`，import 路径必须带 `.js` 后缀（如 `'./tracing.js'`）。
- 构建：`npm run build -w @rdk-moss/agent`（产 `dist/`）；测试先 build 再 import `dist/`。
- 测试：`npm run test -w @rdk-moss/agent`（内部 `npm run build && node ../../scripts/run-package-tests.mjs`，遍历 `packages/moss-agent/test/*.spec.mjs`）。spec 用 `node:assert/strict`，从 `dist/` import。
- 关闭即零开销：未启用时 `withSpan` 走 noop、`mossMetrics.*` 是 noop instrument，业务代码不写 `if` 分支。
- 不改变现有控制流语义：埋点只包 span / 记 metric，不吞错误、不改返回值。
- 版本对齐：tracing experimental 包统一 `^0.200`；metrics 侧沿用 from-remote 的 `api@^1.9` / `sdk-metrics@^2.9` / `exporter-metrics-otlp-http@^0.220` / `resources@^2.9` / `semantic-conventions@^1.43`。若 install 时 peer 冲突，把 tracing experimental 包升到 `^0.220` 与 metrics exporter 对齐。

---

## File Structure

新建 / 修改（均在 `packages/moss-agent/`）：

- **Create** `src/observability/metrics.ts` — `mossMetrics` 仪器句柄（counter/histogram）。
- **Create** `src/observability/file-trace.ts` — `FileSpanProcessor`：消费 SDK `ReadableSpan`，缓冲后 flush 到 `.moss/analytics/traces.jsonl`，含 `getStats` 聚合。
- **Create** `src/observability/sdk.ts` — `initObservabilitySdk` / `shutdownObservabilitySdk`：装配 NodeSDK、Resource、spanProcessors、metricReader。
- **Rewrite** `src/observability/tracing.ts` — 从旧手写 tracer 改为 SDK-backed `withSpan` + attributes 构造器；保留 `setTracer`/`getTracer`/`TraceRegistry` 等**导出壳**（noop）以免破坏 `cli-main.ts:65,188` 与 `moss-agent.ts`、`agent-loop-llm-call.ts:22` 的 import。
- **Rewrite** `src/observability/index.ts` — 公共入口：`initObservability` / `shutdownObservability` + 重导出 withSpan/mossMetrics/attributes，保留 redact/llm-usage 导出。
- **Modify** `packages/moss-agent/package.json` — 加 8 个 `@opentelemetry/*` 依赖。
- **Modify** `src/cli-main.ts` — agent 创建前调 `initObservability`；退出调 `shutdownObservability`；保留 `setTracer('console')` 调用（noop shim）。
- **Modify** `src/core/agent/moss-agent.ts` — `chat()` 开 `moss.session` 根 span + session metrics。
- **Modify** `src/core/loop/agent-loop.ts` — 主循环每轮外包 `moss.agent.turn` span。
- **Modify** `src/core/loop/agent-loop-llm-call.ts` — span 名改 `moss.llm.request`，加 llm metrics。
- **Modify** `src/core/tools/execute-tool-call.ts` — `executeOneToolCall` 内包 `moss.tool.invoke` span + tool metrics。
- **Modify** `src/tools/web-fetch.ts` + `src/tools/web-search.ts` — 出站 fetch headers 用 `propagation.inject` 注入 traceparent。
- **Test** `test/observability-tracing.spec.mjs`、`test/observability-file-trace.spec.mjs`、`test/observability-metrics.spec.mjs`、`test/observability-noop.spec.mjs`、`test/observability-integration.spec.mjs`。

---

## Task 1: 加 OTel 依赖并安装

**Files:**

- Modify: `packages/moss-agent/package.json`（dependencies 块）

**Interfaces:**

- Consumes: 无
- Produces: 可 import 的 `@opentelemetry/*` 模块（后续 task 依赖）

- [ ] **Step 1: 在 `dependencies` 块加入 8 个包**

打开 `packages/moss-agent/package.json`，在 `"dependencies"` 对象内（按字母序插入）加入：

```json
"@opentelemetry/api": "^1.9.0",
"@opentelemetry/exporter-metrics-otlp-http": "^0.220.0",
"@opentelemetry/exporter-trace-otlp-http": "^0.200.0",
"@opentelemetry/resources": "^2.9.0",
"@opentelemetry/sdk-metrics": "^2.9.0",
"@opentelemetry/sdk-node": "^0.200.0",
"@opentelemetry/sdk-trace-base": "^0.200.0",
"@opentelemetry/semantic-conventions": "^1.43.0",
```

- [ ] **Step 2: 安装**

Run: `cd /d/moss-drobotics && npm install -w @rdk-moss/agent`
Expected: 安装成功。若出现 `ERESOLVE` peer 冲突，把 4 个 tracing experimental 包（`sdk-node` / `sdk-trace-base` / `exporter-trace-otlp-http`，以及视情况 `exporter-metrics-otlp-http`）统一升到 `^0.220.0` 后重试。

- [ ] **Step 3: 验证可 import 且 build 不破**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent`
Expected: build 成功（此步尚未引用新包，仅确认依赖到位、不破坏现有构建）。

- [ ] **Step 4: 跑现有测试确认无回归**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过（应与改动前一致）。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/package.json package-lock.json
git commit -m "chore(agent): add @opentelemetry/* dependencies for instrumentation"
```

---

## Task 2: metrics.ts — mossMetrics 仪器句柄

**Files:**

- Create: `packages/moss-agent/src/observability/metrics.ts`
- Test: `packages/moss-agent/test/observability-metrics.spec.mjs`

**Interfaces:**

- Consumes: `@opentelemetry/api` 的 `metrics`
- Produces: `mossMetrics`（对象，含 counter/histogram；未注册 provider 时为 noop）

- [ ] **Step 1: 写 spec（验证导出 + noop 行为）**

Create `packages/moss-agent/test/observability-metrics.spec.mjs`:

```javascript
#!/usr/bin/env node
// mossMetrics instruments export + noop behavior (no provider registered).
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'metrics.js')).href
);
const { mossMetrics } = mod;

// 未 setGlobalMeterProvider 时返回 noop meter，instruments 仍可调用不抛错。
assert.ok(mossMetrics, 'mossMetrics should be exported');
assert.equal(typeof mossMetrics.llmTokens.add, 'function', 'llmTokens.add is a function');
assert.equal(typeof mossMetrics.llmDuration.record, 'function', 'llmDuration.record is a function');
assert.equal(
  typeof mossMetrics.toolInvocations.add,
  'function',
  'toolInvocations.add is a function'
);
assert.equal(
  typeof mossMetrics.toolDuration.record,
  'function',
  'toolDuration.record is a function'
);
assert.equal(typeof mossMetrics.sessionCount.add, 'function', 'sessionCount.add is a function');
assert.equal(
  typeof mossMetrics.sessionDuration.record,
  'function',
  'sessionDuration.record is a function'
);
assert.equal(
  typeof mossMetrics.sessionToolCount.record,
  'function',
  'sessionToolCount.record is a function'
);

// noop 调用零成本、不抛
assert.doesNotThrow(() => {
  mossMetrics.llmTokens.add(10, { direction: 'input', model: 'm' });
  mossMetrics.llmDuration.record(123, { model: 'm' });
  mossMetrics.toolInvocations.add(1, { tool: 't', status: 'ok' });
  mossMetrics.sessionCount.add(1, { outcome: 'ok' });
  mossMetrics.sessionToolCount.record(3, { outcome: 'ok' });
});

console.error('[spec] observability-metrics OK');
```

- [ ] **Step 2: 运行确认失败（模块不存在）**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-metrics.spec.mjs`
Expected: FAIL（`dist/observability/metrics.js` 不存在，import 报 `ERR_MODULE_NOT_FOUND`）。

- [ ] **Step 3: 实现 metrics.ts**

Create `packages/moss-agent/src/observability/metrics.ts`:

```typescript
/**
 * OpenTelemetry metrics for Moss — instrument handles.
 *
 * Uses the global MeterProvider. When none is registered (observability
 * disabled), metrics.getMeter() returns a noop meter whose instruments are
 * no-ops, so business code calls .add()/.record() unconditionally at zero cost.
 *
 * Usage:
 *   import { mossMetrics } from './observability/index.js';
 *   mossMetrics.llmTokens.add(inputTokens, { direction: 'input', model });
 */
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
  // 每轮工具数（纠正 from-remote 把它误命名为 session.turns 的错位）
  sessionToolCount: meter.createHistogram('moss.session.tool_count'),
};
```

- [ ] **Step 4: build + 跑 spec 确认通过**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-metrics.spec.mjs`
Expected: PASS，输出 `[spec] observability-metrics OK`。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/observability/metrics.ts packages/moss-agent/test/observability-metrics.spec.mjs
git commit -m "feat(agent): add mossMetrics OTel instrument handles"
```

---

## Task 3: file-trace.ts — FileSpanProcessor 本地落盘

**Files:**

- Create: `packages/moss-agent/src/observability/file-trace.ts`
- Test: `packages/moss-agent/test/observability-file-trace.spec.mjs`

**Interfaces:**

- Consumes: `@opentelemetry/sdk-trace-base` 的 `SpanProcessor`、`ReadableSpan`
- Produces: `FileSpanProcessor`（class）、`serializeSpan`（函数，被 getStats 复用）、`readTraceStats`（从 jsonl 聚合）

- [ ] **Step 1: 写 spec（落盘 + 聚合）**

Create `packages/moss-agent/test/observability-file-trace.spec.mjs`:

```javascript
#!/usr/bin/env node
// FileSpanProcessor buffers spans, flushes to traces.jsonl, and readTraceStats aggregates.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'file-trace.js')).href
);
const { FileSpanProcessor, readTraceStats } = mod;

// 构造一个最小 ReadableSpan 形状
function fakeSpan(name, attrs, isError) {
  const now = Date.now();
  return {
    name,
    kind: 0,
    spanContext: () => ({ traceId: 't'.repeat(32), spanId: 's'.repeat(16) }),
    startTime: [[now - 50, 0]],
    endTime: [[now, 0]],
    attributes: attrs ?? {},
    status: isError ? { code: 2, message: 'boom' } : { code: 1 },
    events: [],
    resource: { attributes: [] },
    instrumentationScope: { name: 'moss-agent' },
  };
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-trace-'));
const proc = new FileSpanProcessor(tmp);
proc.onStart({}, fakeSpan('noop'));
proc.onEnd(fakeSpan('moss.tool.invoke', { toolName: 'read_file' }, false));
proc.onEnd(fakeSpan('moss.tool.invoke', { toolName: 'read_file' }, true));
proc.onEnd(fakeSpan('moss.llm.request', { model: 'm' }, false));
await proc.forceFlush();

const file = path.join(tmp, '.moss', 'analytics', 'traces.jsonl');
const content = await fs.readFile(file, 'utf8');
const lines = content.split('\n').filter(Boolean);
assert.equal(lines.length, 3, 'should write 3 span lines');

const stats = await readTraceStats(file);
assert.equal(stats.totalSpans, 3, 'totalSpans');
assert.equal(stats.totalErrors, 1, 'totalErrors');
assert.ok(stats.byName['moss.tool.invoke'], 'tool span aggregated by name');
assert.equal(stats.byName['moss.tool.invoke'].count, 2, '2 tool spans');
assert.equal(stats.byName['moss.tool.invoke'].errors, 1, '1 tool error');
assert.equal(stats.toolSpans[0].toolName, 'read_file', 'tool breakdown by toolName');

await proc.shutdown();
await fs.rm(tmp, { recursive: true, force: true });
console.error('[spec] observability-file-trace OK');
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-file-trace.spec.mjs`
Expected: FAIL（`dist/observability/file-trace.js` 不存在）。

- [ ] **Step 3: 实现 file-trace.ts**

Create `packages/moss-agent/src/observability/file-trace.ts`:

```typescript
/**
 * FileSpanProcessor — serializes SDK ReadableSpans to a local JSONL file.
 *
 * Attached to the TracerProvider alongside the OTLP exporter, so the same
 * spans ship to the receiver AND land on disk. Best-effort: flush failures
 * never block the agent.
 *
 * Path: {workspaceDir}/.moss/analytics/traces.jsonl
 */
import type { SpanProcessor, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import fs from 'node:fs/promises';
import path from 'node:path';

const FLUSH_INTERVAL_MS = 30_000;

export interface SerializedSpan {
  name: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; time: number; attrs?: Record<string, unknown> }>;
  status: 'ok' | 'error';
  statusMessage?: string;
}

export interface TraceStats {
  totalSpans: number;
  totalErrors: number;
  errorRate: number;
  byName: Record<string, { count: number; errors: number; avgDurationMs: number }>;
  toolSpans: Array<{ toolName: string; count: number; errors: number; avgDurationMs: number }>;
}

/** Convert an SDK ReadableSpan into the JSONL-friendly SerializedSpan shape. */
export function serializeSpan(span: ReadableSpan): SerializedSpan {
  const attrs: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(span.attributes ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attrs[k] = v;
  }
  return {
    name: span.name,
    startTime: Number(span.startTime[0]),
    endTime: Number(span.endTime[0]),
    attributes: attrs,
    events: (span.events ?? []).map((e) => ({
      name: e.name,
      time: Number(e.time[0]),
      ...(e.attributes ? { attrs: e.attributes as Record<string, unknown> } : {}),
    })),
    status: span.status.code === SpanStatusCode.ERROR ? 'error' : 'ok',
    ...(span.status.code === SpanStatusCode.ERROR && span.status.message
      ? { statusMessage: span.status.message }
      : {}),
  };
}

export class FileSpanProcessor implements SpanProcessor {
  private buffer: ReadableSpan[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;

  constructor(workspaceDir: string) {
    this.file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
    this.timer = setInterval(() => {
      void this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  onStart(_span: ReadableSpan, _parentContext: unknown): void {}

  onEnd(span: ReadableSpan): void {
    this.buffer.push(span);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const snapshot = this.buffer.splice(0);
    const lines =
      snapshot
        .map(serializeSpan)
        .map((s) => JSON.stringify(s))
        .join('\n') + '\n';
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, lines, 'utf-8');
    } catch {
      // Silently ignore — never block the agent.
    }
  }

  async forceFlush(): Promise<void> {
    await this.flush();
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}

function emptyStats(): TraceStats {
  return { totalSpans: 0, totalErrors: 0, errorRate: 0, byName: {}, toolSpans: [] };
}

/** Read aggregated stats from a traces.jsonl file (for CLI reporting). */
export async function readTraceStats(file: string): Promise<TraceStats> {
  let lines: string[];
  try {
    lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean);
  } catch {
    return emptyStats();
  }
  const stats = emptyStats();
  for (const line of lines) {
    let span: SerializedSpan;
    try {
      span = JSON.parse(line);
    } catch {
      continue;
    }
    stats.totalSpans++;
    if (span.status === 'error') stats.totalErrors++;
    const entry = (stats.byName[span.name] ??= { count: 0, errors: 0, avgDurationMs: 0 });
    entry.count++;
    if (span.status === 'error') entry.errors++;
    const duration = span.endTime - span.startTime;
    entry.avgDurationMs = (entry.avgDurationMs * (entry.count - 1) + duration) / entry.count;
    if (span.name === 'moss.tool.invoke') {
      const toolName = String(span.attributes.toolName ?? 'unknown');
      let tool = stats.toolSpans.find((t) => t.toolName === toolName);
      if (!tool) {
        tool = { toolName, count: 0, errors: 0, avgDurationMs: 0 };
        stats.toolSpans.push(tool);
      }
      tool.count++;
      if (span.status === 'error') tool.errors++;
      tool.avgDurationMs = (tool.avgDurationMs * (tool.count - 1) + duration) / tool.count;
    }
  }
  stats.errorRate = stats.totalSpans > 0 ? stats.totalErrors / stats.totalSpans : 0;
  stats.toolSpans.sort((a, b) => b.count - a.count);
  return stats;
}
```

- [ ] **Step 4: build + 跑 spec 确认通过**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-file-trace.spec.mjs`
Expected: PASS，输出 `[spec] observability-file-trace OK`。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/observability/file-trace.ts packages/moss-agent/test/observability-file-trace.spec.mjs
git commit -m "feat(agent): add FileSpanProcessor for local JSONL trace export"
```

---

## Task 4: 重写 tracing.ts（SDK-backed withSpan + 保留导出壳）

**Files:**

- Rewrite: `packages/moss-agent/src/observability/tracing.ts`
- Test: `packages/moss-agent/test/observability-tracing.spec.mjs`

**Interfaces:**

- Consumes: `@opentelemetry/api`（`trace`、`context`、`SpanStatusCode`）
- Produces: `withSpan(name, attrs, fn)`；attributes 构造器 `turnAttributes` / `toolAttributes` / `llmRequestAttributes` / `sessionAttributes`；**保留** `setTracer` / `getTracer` / `TraceRegistry` / `Tracer` / `TraceSpan` 导出（noop shim，供现有 import 不破）。

**注意：** 现有 `cli-main.ts:65` `import { setTracer } from './observability/tracing.js'` 与 `:188` `setTracer('console')`；`moss-agent.ts` 与 `agent-loop-llm-call.ts:22` 也从 tracing.js import。本 task 把 withSpan 改 SDK 实现，同时保留 `setTracer`/`TraceRegistry` 等为 noop shim，使现有 import 不需在本 task 内改动（cli-main 的真正初始化在 Task 7）。

- [ ] **Step 1: 写 spec（withSpan 成功/异常路径 + attributes 形状 + noop shim 存在）**

Create `packages/moss-agent/test/observability-tracing.spec.mjs`:

```javascript
#!/usr/bin/env node
// withSpan: success path sets OK, error path records exception + rethrows.
// attributes constructors produce expected shape. setTracer shim is a noop.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'tracing.js')).href
);
const {
  withSpan,
  turnAttributes,
  toolAttributes,
  llmRequestAttributes,
  sessionAttributes,
  setTracer,
  getTracer,
  TraceRegistry,
} = mod;

// 未注册 tracer provider 时为 noop tracer，withSpan 仍正常执行 fn 并返回结果。
const result = await withSpan('test.span', { a: 1 }, async (span) => {
  assert.equal(typeof span.setAttribute, 'function');
  assert.equal(typeof span.addEvent, 'function');
  assert.equal(typeof span.setStatus, 'function');
  assert.equal(typeof span.end, 'function');
  span.setAttribute('k', 'v');
  span.addEvent('ev', { x: 1 });
  return 42;
});
assert.equal(result, 42, 'withSpan returns fn result');

// 异常路径：rethrow（不吞错）
await assert.rejects(
  withSpan('test.err', {}, async () => {
    throw new Error('boom');
  }),
  /boom/
);

// attributes 构造器形状
assert.deepEqual(turnAttributes('r1', 3, 'm'), { runId: 'r1', turn: 3, model: 'm' });
assert.deepEqual(toolAttributes('r1', 'read_file', 'tc1'), {
  runId: 'r1',
  toolName: 'read_file',
  toolCallId: 'tc1',
});
assert.deepEqual(llmRequestAttributes('r1', 'm', 100), {
  runId: 'r1',
  model: 'm',
  inputTokens: 100,
});
assert.deepEqual(sessionAttributes('r1', 'm', 'sk'), { runId: 'r1', model: 'm', sessionKey: 'sk' });

// 旧 API 保留为 noop shim，不抛
assert.doesNotThrow(() => setTracer('console'));
assert.ok(getTracer());
assert.ok(new TraceRegistry());
console.error('[spec] observability-tracing OK');
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-tracing.spec.mjs`
Expected: FAIL（旧 tracing.ts 的 `withSpan` 第三参是 `(span: TraceSpan) => Promise<T>` 但签名带 `parent?`，且 attributes 构造器缺 `sessionAttributes`；旧实现 `withSpan` 在异常时虽 rethrow 但不 `recordException`——本 spec 主要因缺 `sessionAttributes` 导出而失败）。

- [ ] **Step 3: 重写 tracing.ts**

Replace **entire** `packages/moss-agent/src/observability/tracing.ts` with:

```typescript
/**
 * Tracing — SDK-backed withSpan + attributes.
 *
 * Uses the global TracerProvider. When none is registered (observability
 * disabled), trace.getTracer() returns a noop tracer and withSpan runs fn
 * directly with zero overhead.
 *
 * Legacy setTracer/TraceRegistry/Tracer/TraceSpan are kept as noop shims so
 * existing imports (cli-main.ts, moss-agent.ts, agent-loop-llm-call.ts) do
 * not break until callers are migrated to initObservability.
 */
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { errorMessage } from '../errors.js';
import { redactSensitiveData } from './redact.js';

const tracer = trace.getTracer('moss-agent');

/** Public span handle passed to withSpan's fn. */
export interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  setStatus(ok: boolean, message?: string): void;
  end(): void;
}

/** Legacy Tracer interface — kept as noop shim. */
export interface Tracer {
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
    parent?: TraceSpan
  ): TraceSpan;
}

const noopSpan: TraceSpan = {
  setAttribute() {},
  addEvent() {},
  setStatus() {},
  end() {},
};

const noopTracer: Tracer = {
  startSpan() {
    return noopSpan;
  },
};

/**
 * Run fn inside a span. On success sets OK; on throw records the exception
 * (type/message/stack as a span event), sets ERROR with a redacted message,
 * and rethrows. Never swallows errors.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: (span: Span & TraceSpan) => Promise<T>
): Promise<T> {
  const span = tracer.startSpan(name, { attributes }) as Span & TraceSpan;
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: redactSensitiveData(errorMessage(err)),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

// ── Attributes constructors (span dimensions, centralized) ──────────────

export function turnAttributes(
  runId: string,
  turn: number,
  model: string
): Record<string, string | number | boolean> {
  return { runId, turn, model };
}

export function toolAttributes(
  runId: string,
  toolName: string,
  toolCallId: string
): Record<string, string | number | boolean> {
  return { runId, toolName, toolCallId };
}

export function llmRequestAttributes(
  runId: string,
  model: string,
  inputTokens: number
): Record<string, string | number | boolean> {
  return { runId, model, inputTokens };
}

export function sessionAttributes(
  runId: string,
  model: string,
  sessionKey: string
): Record<string, string | number | boolean> {
  return { runId, model, sessionKey };
}

// ── Legacy noop shims (do not remove — existing imports depend on them) ──

export class TraceRegistry {
  setTracer(_tracer: Tracer | 'console'): void {}
  setTraceRedactor(_fn: (text: string) => string): void {}
  getTracer(): Tracer {
    return noopTracer;
  }
  redactMessage(text: string): string {
    return text;
  }
}

export function setTracer(_tracer: Tracer | 'console'): void {
  // No-op under the SDK model. Tracer/MeterProvider is configured via
  // initObservability() in observability/index.ts.
}

export function getTracer(): Tracer {
  return noopTracer;
}
```

- [ ] **Step 4: build + 跑 spec 确认通过**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-tracing.spec.mjs`
Expected: PASS，输出 `[spec] observability-tracing OK`。

- [ ] **Step 5: 确认现有 import 未破（build + 全量测试）**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过（cli-main/moss-agent/llm-call 的 `setTracer`/`withSpan` import 仍有效，因 shim 保留）。

- [ ] **Step 6: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/observability/tracing.ts packages/moss-agent/test/observability-tracing.spec.mjs
git commit -m "feat(agent): rewrite tracing.ts onto OTel SDK withSpan (legacy shims retained)"
```

---

## Task 5: sdk.ts + index.ts — SDK 装配与公共入口

**Files:**

- Create: `packages/moss-agent/src/observability/sdk.ts`
- Rewrite: `packages/moss-agent/src/observability/index.ts`
- Test: `packages/moss-agent/test/observability-noop.spec.mjs`

**Interfaces:**

- Consumes: Task 2 `mossMetrics`、Task 3 `FileSpanProcessor`、`@opentelemetry/sdk-node` 等
- Produces: `initObservability(opts)`、`shutdownObservability()`、`propagateHeaders(headers)`（web 工具用）

- [ ] **Step 1: 写 spec（默认 noop：不启用时 initObservability 是 noop，且出站 headers 注入是 passthrough）**

Create `packages/moss-agent/test/observability-noop.spec.mjs`:

```javascript
#!/usr/bin/env node
// initObservability is a noop when disabled; propagateHeaders passes through when no active span.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'index.js')).href
);
const { initObservability, shutdownObservability, propagateHeaders } = mod;

// 不设任何 env，initObservability 应 noop（不创建文件、不抛）
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-noop-'));
delete process.env.MOSS_OTEL_ENABLED;
delete process.env.MOSS_OTEL_URL;
assert.doesNotThrow(() => initObservability({ workspaceDir: tmp }));
await shutdownObservability();

// propagateHeaders 无 active span 时原样返回（补一个已存在的 header）
const out = propagateHeaders({ 'x-custom': '1' });
assert.equal(out['x-custom'], '1', 'passes existing headers through');
assert.ok(out, 'returns a headers object');

await fs.rm(tmp, { recursive: true, force: true });
console.error('[spec] observability-noop OK');
```

- [ ] **Step 2: 运行确认失败**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-noop.spec.mjs`
Expected: FAIL（`index.js` 未导出 `initObservability` / `shutdownObservability` / `propagateHeaders`）。

- [ ] **Step 3: 实现 sdk.ts**

Create `packages/moss-agent/src/observability/sdk.ts`:

```typescript
/**
 * OpenTelemetry SDK assembly — single NodeSDK for trace + metric, shared Resource.
 * Local file trace attaches as a FileSpanProcessor alongside the OTLP exporter.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { semconv } from '@opentelemetry/semantic-conventions';
import fs from 'node:fs';
import path from 'node:path';
import { FileSpanProcessor } from './file-trace.js';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

export interface ObservabilityConfig {
  serviceName: string;
  otlpUrl: string;
  enabled: boolean;
  metricsEnabled: boolean;
  fileTraceEnabled: boolean;
  workspaceDir: string;
}

let sdk: NodeSDK | null = null;

/** Read package version from packages/moss-agent/package.json (not hardcoded). */
function readPackageVersion(): string {
  try {
    const pkgPath = path.join(import.meta.dirname, '..', '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function initObservabilitySdk(cfg: ObservabilityConfig): void {
  if (!cfg.enabled || sdk) return;
  try {
    const resource = resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: cfg.serviceName,
      [semconv.ATTR_SERVICE_VERSION]: readPackageVersion(),
    });

    const spanProcessors: SpanProcessor[] = [
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${cfg.otlpUrl}/v1/traces` })),
    ];
    if (cfg.fileTraceEnabled) {
      spanProcessors.push(new FileSpanProcessor(cfg.workspaceDir));
    }

    const metricReader = cfg.metricsEnabled
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${cfg.otlpUrl}/v1/metrics` }),
          exportIntervalMillis: 10_000,
        })
      : undefined;

    sdk = new NodeSDK({
      resource,
      spanProcessors,
      ...(metricReader ? { metricReader } : {}),
    });
    sdk.start();
  } catch {
    // Best-effort — never block the agent. Failure means no telemetry, not a crash.
  }
}

export async function shutdownObservabilitySdk(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* ignore */
  }
  sdk = null;
}
```

- [ ] **Step 4: 重写 index.ts**

Replace **entire** `packages/moss-agent/src/observability/index.ts` with:

```typescript
/**
 * Observability public entrypoint.
 *
 * initObservability() wires up OTel SDK (trace + metric + local file trace)
 * based on env vars; when disabled it is a no-op and withSpan / mossMetrics.*
 * run as no-ops. Call once at CLI startup (before agent creation), call
 * shutdownObservability() on exit to flush.
 */
import { initObservabilitySdk, shutdownObservabilitySdk } from './sdk.js';

export interface InitOptions {
  workspaceDir: string;
  serviceName?: string;
  otlpUrl?: string;
}

export function initObservability(opts: InitOptions): void {
  const enabled = process.env.MOSS_OTEL_ENABLED === '1' || !!process.env.MOSS_OTEL_URL;
  if (!enabled) return;
  initObservabilitySdk({
    serviceName: process.env.MOSS_OTEL_SERVICE_NAME ?? opts.serviceName ?? 'moss',
    otlpUrl: process.env.MOSS_OTEL_URL ?? opts.otlpUrl ?? 'http://localhost:4318',
    enabled: true,
    // tracing 开则 metrics 默认开（纠正 from-remote 两开关易漏配）
    metricsEnabled: process.env.MOSS_METRICS_ENABLED !== '0',
    // 本地文件 trace 默认开，MOSS_FILE_TRACE=0 关
    fileTraceEnabled: process.env.MOSS_FILE_TRACE !== '0',
    workspaceDir: opts.workspaceDir,
  });
}

export { shutdownObservabilitySdk as shutdownObservability } from './sdk.js';

export {
  withSpan,
  turnAttributes,
  toolAttributes,
  llmRequestAttributes,
  sessionAttributes,
} from './tracing.js';
export { mossMetrics } from './metrics.js';
export { FileSpanProcessor, readTraceStats } from './file-trace.js';
export type { SerializedSpan, TraceStats } from './file-trace.js';

// Re-export unchanged modules (drobotics already has these, identical to from-remote)
export { redactSensitiveData, parseTelemetryAllow } from './redact.js';
export type { RedactOptions } from './redact.js';
export {
  logLLMUsage,
  readUsageLog,
  summarizeUsage,
  formatUsageSummary,
  estimateLLMCost,
  registerModelPricing,
} from './llm-usage.js';
export type { LLMUsageRecord, LLMUsageSummary } from './llm-usage.js';

// Legacy re-exports kept so cli-main's `import { setTracer } from './observability/tracing.js'`
// style imports continue to resolve through index too.
export { setTracer, getTracer, TraceRegistry } from './tracing.js';
export type { Tracer, TraceSpan } from './tracing.js';

/**
 * Inject W3C traceparent into outbound fetch headers for the current span.
 * Returns headers unchanged when no active span (graceful degradation).
 */
import { propagation } from '@opentelemetry/api';
export function propagateHeaders(headers: Record<string, string> = {}): Record<string, string> {
  try {
    const injected: Record<string, string> = { ...headers };
    propagation.inject(injected, {
      set: (carrier, key, value) => {
        carrier[key] = String(value);
      },
      get: (carrier, key) => carrier[key],
    });
    return injected;
  } catch {
    return headers;
  }
}
```

- [ ] **Step 5: build + 跑 spec 确认通过**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-noop.spec.mjs`
Expected: PASS，输出 `[spec] observability-noop OK`。

- [ ] **Step 6: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/observability/sdk.ts packages/moss-agent/src/observability/index.ts packages/moss-agent/test/observability-noop.spec.mjs
git commit -m "feat(agent): add sdk.ts assembly + observability public entrypoint"
```

---

## Task 6: web-fetch / web-search 注入 traceparent

**Files:**

- Modify: `packages/moss-agent/src/tools/web-fetch.ts`（line 541 附近 fetch headers）
- Modify: `packages/moss-agent/src/tools/web-search.ts`（line 233 附近 fetch headers）

**Interfaces:**

- Consumes: Task 5 `propagateHeaders`
- Produces: 出站 HTTP 请求带 W3C traceparent（无 active span 时 passthrough）

- [ ] **Step 1: web-fetch.ts — import propagateHeaders**

在 `packages/moss-agent/src/tools/web-fetch.ts` 现有 import 区（line 16-22 之后）加：

```typescript
import { propagateHeaders } from '../observability/index.js';
```

- [ ] **Step 2: web-fetch.ts — 包裹 fetch headers**

定位 line 541 附近的 `headers: {` 块（`fetchInit` 内）。改为在发起 fetch 前注入。找到 `res = await fetch(fetchUrl.toString(), fetchInit);`（line 552 附近），在其前面加：

```typescript
if (
  fetchInit.headers &&
  typeof fetchInit.headers === 'object' &&
  !Array.isArray(fetchInit.headers)
) {
  fetchInit.headers = propagateHeaders(fetchInit.headers as Record<string, string>);
}
```

（放在 `fetchInit` 已构造完成、`await fetch` 之前。若 `fetchInit.headers` 不存在则跳过，不影响原逻辑。）

- [ ] **Step 3: web-search.ts — import propagateHeaders**

在 `packages/moss-agent/src/tools/web-search.ts` 现有 import 区（line 32-35 之后）加：

```typescript
import { propagateHeaders } from '../observability/index.js';
```

- [ ] **Step 4: web-search.ts — 包裹主 fetch headers**

定位 line 233 附近 `const res = await fetch(url, { ...init, signal: controller.signal });`。在它前面加：

```typescript
const headersWithTrace = propagateHeaders((init?.headers ?? {}) as Record<string, string>);
const res = await fetch(url, { ...init, headers: headersWithTrace, signal: controller.signal });
```

（替换原 line 233 那一行。其余 line 272/370/477/591/675/735/798 的 `headers:` 块是 RSS/feed 子请求，本 task 不动——主搜索请求注入即可，避免过度改动。）

- [ ] **Step 5: build 确认无类型错误**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent`
Expected: build 成功。

- [ ] **Step 6: 跑全量测试确认 web 工具无回归**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过。

- [ ] **Step 7: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/tools/web-fetch.ts packages/moss-agent/src/tools/web-search.ts
git commit -m "feat(agent): inject W3C traceparent into web-fetch / web-search outbound requests"
```

---

## Task 7: cli-main.ts — initObservability 初始化 + 退出 flush

**Files:**

- Modify: `packages/moss-agent/src/cli-main.ts`（line 65 附近 import；line 611 `new MossAgent` 之前；main finally / 退出）

**Interfaces:**

- Consumes: Task 5 `initObservability` / `shutdownObservability`
- Produces: CLI 启动时按 env 装配 SDK；退出时 flush 残留 span/metric

- [ ] **Step 1: 加 import**

在 `cli-main.ts` line 65 `import { setTracer } from './observability/tracing.js';` 之后加：

```typescript
import { initObservability, shutdownObservability } from './observability/index.js';
```

- [ ] **Step 2: agent 创建前调 initObservability**

定位 line 611 附近 `const agent = new MossAgent({`。在它**之前**（line 608-610 区域，`// Enable OTel ...` 注释块如有也一并替换）插入：

```typescript
// Enable observability (OTel tracing + metrics + local file trace) based on env.
// No-op when MOSS_OTEL_ENABLED is unset and MOSS_OTEL_URL absent.
initObservability({ workspaceDir: workspace });
```

（`workspace` 变量在 line 465 已定义，此处可见。）

- [ ] **Step 3: 注册退出 flush**

`main()` 已有 `try { ... } finally { await closeMcpConnections(mcpConnections); }`（line 759-1016 区域）。在 finally 块内 `closeMcpConnections` 之后加 shutdown：

定位 `} finally {` 接 `await closeMcpConnections(mcpConnections);`（line 1014-1015 附近），改为：

```typescript
  } finally {
    await closeMcpConnections(mcpConnections);
    await shutdownObservability();
  }
```

- [ ] **Step 4: 兜底 beforeExit flush（异常退出路径）**

在 `cli-main.ts` 末尾 `main().catch(...)`（line 1019）**之前**加：

```typescript
process.on('beforeExit', () => {
  void shutdownObservability();
});
```

- [ ] **Step 5: build 确认无类型错误**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent`
Expected: build 成功。

- [ ] **Step 6: 跑全量测试确认无回归**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过。

- [ ] **Step 7: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/cli-main.ts
git commit -m "feat(agent): wire initObservability at CLI startup + flush on exit"
```

---

## Task 8: agent-loop-llm-call.ts — span 改名 + llm metrics

**Files:**

- Modify: `packages/moss-agent/src/core/loop/agent-loop-llm-call.ts`（line 22 import；line 133 withSpan；success/catch 处加 metrics）

**Interfaces:**

- Consumes: Task 4 `withSpan`/`turnAttributes`、Task 2 `mossMetrics`
- Produces: `moss.llm.request` span + `moss.llm.tokens` / `moss.llm.request.duration` metric

- [ ] **Step 1: import mossMetrics**

在 line 22 `import { withSpan, turnAttributes } from '../../observability/tracing.js';` 之后加：

```typescript
import { mossMetrics } from '../../observability/index.js';
```

- [ ] **Step 2: span 名改 moss.llm.request**

定位 line 133-135：

```typescript
    const llmTurn = await withSpan(
      'agent.llm_turn',
      turnAttributes(runId, state.turns, String(modelDef.id)),
```

把 `'agent.llm_turn'` 改为 `'moss.llm.request'`：

```typescript
    const llmTurn = await withSpan(
      'moss.llm.request',
      turnAttributes(runId, state.turns, String(modelDef.id)),
```

- [ ] **Step 3: success 路径记 metrics**

定位 line 177-191 区域 `if (llmTurn.usage) {` 块末尾、`return { control: 'continue', ...` 之前（line 191 `});` 之后），在 `recordLlmUsage(...)` 调用之后插入 metrics 记录：

```typescript
// Metrics (noop when metrics disabled)
const llmModel = String(modelDef.id);
const llmDuration = Date.now() - llmTurnStartedAt;
mossMetrics.llmDuration.record(llmDuration, { model: llmModel });
mossMetrics.llmTokens.add(llmTurn.usage.inputTokens, { direction: 'input', model: llmModel });
mossMetrics.llmTokens.add(llmTurn.usage.outputTokens, { direction: 'output', model: llmModel });
```

- [ ] **Step 4: catch 路径记 metrics**

定位 line 213-223 区域 `} catch (llmError) {` 内的 `await recordLlmUsage({... success: false ...});` 之后（line 223 `});` 之后），插入：

```typescript
// Metrics: record failed LLM call
mossMetrics.llmDuration.record(Date.now() - llmTurnStartedAt, { model: String(modelDef.id) });
```

- [ ] **Step 5: build 确认无类型错误**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent`
Expected: build 成功。

- [ ] **Step 6: 跑全量测试**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过。

- [ ] **Step 7: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/core/loop/agent-loop-llm-call.ts
git commit -m "feat(agent): rename llm span to moss.llm.request + emit llm metrics"
```

---

## Task 9: execute-tool-call.ts — tool span + tool metrics

**Files:**

- Modify: `packages/moss-agent/src/core/tools/execute-tool-call.ts`（line 30 附近 import；line 341 `startMs` 之后包 span；outcome 处记 metrics）

**Interfaces:**

- Consumes: Task 4 `withSpan`/`toolAttributes`、Task 2 `mossMetrics`
- Produces: `moss.tool.invoke` span + `moss.tool.invocations` / `moss.tool.invoke.duration` metric

- [ ] **Step 1: import**

在 line 30 `import { runPreToolHookChain, validateToolInputObject } from './tool-pipeline.js';` 之后加：

```typescript
import { withSpan, toolAttributes } from '../../observability/tracing.js';
import { mossMetrics } from '../../observability/index.js';
```

- [ ] **Step 2: 在 executeOneToolCall 内包 span + 记 metrics**

定位 line 341 `const startMs = Date.now();`。它位于 `executeOneToolCall`（line 242 起）函数体内、`return { kind: 'completed', ... }`（line 540 附近）之前。

把 line 341 到函数 return 之间的主执行体用 `withSpan` 包裹。由于该函数体较长，采用**最小侵入**改法：在 `const startMs = Date.now();` 之后、原执行体最外层逻辑之外，用 withSpan 包住整个 try/catch。

实际改法——在 line 341 `const startMs = Date.now();` 之后插入：

```typescript
return withSpan(
  'moss.tool.invoke',
  toolAttributes(deps.sessionKey, call.name, call.id),
  async (span) => {
    try {
      const outcome = await executeOneToolCallInner(call, deps);
      const isErr = outcome.kind === 'completed' ? Boolean(outcome.isError) : true;
      const dur = outcome.kind === 'completed' ? outcome.durationMs : Date.now() - startMs;
      span.setAttribute('is_error', isErr);
      if (outcome.kind === 'completed' && outcome.outcome)
        span.setAttribute('outcome', outcome.outcome);
      mossMetrics.toolInvocations.add(1, { tool: call.name, status: isErr ? 'error' : 'ok' });
      mossMetrics.toolDuration.record(dur, { tool: call.name });
      return outcome;
    } catch (err) {
      mossMetrics.toolInvocations.add(1, { tool: call.name, status: 'error' });
      mossMetrics.toolDuration.record(Date.now() - startMs, { tool: call.name });
      throw err;
    }
  }
);
```

然后把**原** line 342 到 return 的函数体重命名为内部函数 `executeOneToolCallInner`：

- 在 `export async function executeOneToolCall(...)` 签名之后、`const startMs = Date.now();` **之前**，原函数体不变；
- 将原顶层 `export async function executeOneToolCall` 改为 `async function executeOneToolCallInner`（去掉 export）；
- 在其**之后**新增对外导出的 `executeOneToolCall`，它只做「调 inner + 包 span/metrics」：

```typescript
export async function executeOneToolCall(
  call: ExecuteToolCallRef,
  deps: ExecuteToolCallDeps
): Promise<ExecuteToolCallOutcome> {
  const startMs = Date.now();
  return withSpan(
    'moss.tool.invoke',
    toolAttributes(deps.sessionKey, call.name, call.id),
    async (span) => {
      try {
        const outcome = await executeOneToolCallInner(call, deps);
        const isErr = outcome.kind === 'completed' ? Boolean(outcome.isError) : true;
        const dur = outcome.kind === 'completed' ? outcome.durationMs : Date.now() - startMs;
        span.setAttribute('is_error', isErr);
        if (outcome.kind === 'completed' && outcome.outcome)
          span.setAttribute('outcome', outcome.outcome);
        mossMetrics.toolInvocations.add(1, { tool: call.name, status: isErr ? 'error' : 'ok' });
        mossMetrics.toolDuration.record(dur, { tool: call.name });
        return outcome;
      } catch (err) {
        mossMetrics.toolInvocations.add(1, { tool: call.name, status: 'error' });
        mossMetrics.toolDuration.record(Date.now() - startMs, { tool: call.name });
        throw err;
      }
    }
  );
}
```

> 实现者注意：`ExecuteToolCallRef` / `ExecuteToolCallDeps` / `ExecuteToolCallOutcome` 是原函数已有的类型名（见文件内 `import type` 与函数签名），原样沿用；`outcome.outcome` 是 `ToolResultOutcome` 字符串字段（见 line 219-221）。若 TS 报 outcome 类型不匹配，按文件内实际类型调整 attribute 取值，不改控制流。

- [ ] **Step 3: build 确认无类型错误**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent`
Expected: build 成功（如有类型错误，按文件内实际类型修正 attribute 取值，不改 span 包裹与 metrics 逻辑）。

- [ ] **Step 4: 跑全量测试**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过（tool 执行相关 spec 不受影响——内层逻辑未变）。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/core/tools/execute-tool-call.ts
git commit -m "feat(agent): wrap tool execution in moss.tool.invoke span + emit tool metrics"
```

---

## Task 10: agent-loop.ts — moss.agent.turn span

**Files:**

- Modify: `packages/moss-agent/src/core/loop/agent-loop.ts`（line 36 附近 import；主循环 line 330 `outerLoop: while (true)` 内每轮迭代外包 span）

**Interfaces:**

- Consumes: Task 4 `withSpan`/`turnAttributes`、`runId`（循环内已有变量）
- Produces: `moss.agent.turn` span（每轮一个）

- [ ] **Step 1: import**

定位 line 36 `import { executeLlmTurn } from './agent-loop-llm-call.js';` 附近，在循环文件 import 区加：

```typescript
import { withSpan, turnAttributes } from '../../observability/tracing.js';
```

- [ ] **Step 2: 每轮迭代外包 span**

定位 line 330 `outerLoop: while (true) {` 与 line 337 内层 `while (state.hasMoreToolCalls || state.pendingMessages.length > 0) {`。

在 line 356 `state.turns++;` 之后、该轮迭代主体（`executeLlmTurn` 等，line 426）之前，用 `withSpan` 包住单轮的 LLM+工具处理。由于 `outerLoop` / 内层 while 含 `break`/`continue`/`state.turns--` 等控制流，**最小侵入**做法是：在内层 while 循环体的开头（line 337 `while (...) {` 之后第一行）开 span，但要避免 break/continue 跳过 span.end。

**采用安全包裹法**——把 line 356 `state.turns++;` 之后到该轮结束的语句提取到 `await withSpan('moss.agent.turn', ..., async (span) => { ... })` 内，并让内层 while 改为：

在 line 356 `state.turns++;` 之后插入（替换其后到内层 while 结束的整段为 span 包体）：

```typescript
await withSpan(
  'moss.agent.turn',
  turnAttributes(runId, state.turns, String(modelDef.id)),
  async () => {
    // ... 原 line 358 起到内层 while 结束的全部语句（processLlmResponse / continue / break 等）原样搬入 ...
  }
);
```

> 实现者注意：`runId`、`modelDef` 在该作用域已定义（见 line 147 `runId`、循环参数）。内层 while 里的 `continue`/`break` 在 async 闭包内会作用于该闭包——若 `break` 需跳出 `outerLoop`，改用标志位（`let breakOuter = false;` 在闭包内设、闭包外判断）以替代原 `break outerLoop`。逐一核对 line 337-540 区域每个 `break`/`continue` 的跳转目标，确保 span 总能 end（withSpan 的 finally 保证）。不改任何条件判断与状态赋值的值。

- [ ] **Step 3: build 确认无类型错误**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent`
Expected: build 成功。若 TS 报闭包内 break/continue 作用域问题，按 Step 2 的标志位法修正，不改控制流语义。

- [ ] **Step 4: 跑全量测试（含 agent-loop 相关 spec）**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过。重点关注 `agent-loop-push-guard-isolation.spec.mjs`、`autonomous-loop.spec.mjs`。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/core/loop/agent-loop.ts
git commit -m "feat(agent): wrap each loop turn in moss.agent.turn span"
```

---

## Task 11: moss-agent.ts — moss.session 根 span + session metrics

**Files:**

- Modify: `packages/moss-agent/src/core/agent/moss-agent.ts`（import 区；line 412 `chat()` 内）

**Interfaces:**

- Consumes: Task 4 `withSpan`/`sessionAttributes`、Task 2 `mossMetrics`
- Produces: `moss.session` 根 span + `moss.session.count` / `moss.session.duration` / `moss.session.tool_count` metric

- [ ] **Step 1: import**

在 `moss-agent.ts` import 区（文件头部，`from '../loop/agent-loop.js'` 等附近）加：

```typescript
import { withSpan, sessionAttributes } from '../../observability/tracing.js';
import { mossMetrics } from '../../observability/index.js';
```

- [ ] **Step 2: chat() 内包 session span + 记 metrics**

定位 line 412 `async chat(sessionKey: string, userMessage: string, options?: ChatOptions): Promise<ChatResult> {` 与 line 413 `let finalResult: ChatResult | undefined;`。

在 `chat()` 函数体最外层用 `withSpan('moss.session', sessionAttributes(runId, model, sessionKey), ...)` 包裹主体，并在结束记 metrics。最小侵入：在 line 412 函数体开头加 `const sessionStart = Date.now();`，把原返回路径包进 withSpan。

具体——找到 `chat()` 的最终 `return`（返回 `ChatResult`，通常在函数末尾，`finalResult` 被赋值处）。在 line 412 `let finalResult: ChatResult | undefined;` 之后插入：

```typescript
const sessionStart = Date.now();
return withSpan(
  'moss.session',
  sessionAttributes(/* runId */ thisRunId, /* model */ String(model), sessionKey),
  async () => {
    // ... 原 chat() 主体（line 413 起到原 return）原样搬入，return 改为 return 到闭包 ...
  }
).finally(() => {
  const outcome =
    finalResult?.stopReason === 'end_turn' ? 'ok' : finalResult ? 'incomplete' : 'error';
  mossMetrics.sessionCount.add(1, { outcome });
  mossMetrics.sessionDuration.record(Date.now() - sessionStart, { outcome });
  mossMetrics.sessionToolCount.record(finalResult?.toolCalls?.length ?? 0, { outcome });
});
```

> 实现者注意：
>
> - `runId` / `model` 在 `chat()` 作用域内的实际变量名按文件内为准（chat 可能在内部调用 `this.run(...)` 产生 runId；若 runId 在 withSpan 之前不可用，改用 `sessionKey` + `model` 作 attributes，`runId` 在闭包内拿到后 `span.setAttribute('runId', runId)`）。先读 line 412-570 区段确认变量可见性再填 attributes。
> - `finalResult.toolCalls` 字段名按 `ChatResult` 类型（见 line 141 `SharedChatResult`）确认；若为 `toolsUsed` 或其他名，按实际字段。
> - `.finally` 在 `finalResult` 赋值后执行（withSpan 的 fn return 时 finalResult 已被赋值），故 metric 能读到结果。

- [ ] **Step 3: build 确认无类型错误**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent`
Expected: build 成功。若 attributes 字段名/变量名不符，按文件实际修正，不改 span/metrics 逻辑与返回值。

- [ ] **Step 4: 跑全量测试**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/core/agent/moss-agent.ts
git commit -m "feat(agent): wrap chat() in moss.session root span + emit session metrics"
```

---

## Task 12: 端到端集成验证

**Files:**

- Test: `packages/moss-agent/test/observability-integration.spec.mjs`

**Interfaces:**

- Consumes: Task 5 `initObservability` / `shutdownObservability`、`withSpan`、`mossMetrics`、`readTraceStats`
- Produces: 验证三层 span + metrics + 本地文件 trace 在启用后真正产生数据

- [ ] **Step 1: 写集成 spec（启用 → 跑 withSpan → 文件落盘 → shutdown flush）**

Create `packages/moss-agent/test/observability-integration.spec.mjs`:

```javascript
#!/usr/bin/env node
// Integration: enable SDK, run nested withSpan (session→turn→llm), verify file trace lands.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const dir = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'index.js')).href
);
const { initObservability, shutdownObservability, withSpan, mossMetrics } = mod;
const traceMod = await import(
  pathToFileURL(path.join(dir, '..', 'dist', 'observability', 'file-trace.js')).href
);
const { readTraceStats } = traceMod;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-int-'));
process.env.MOSS_OTEL_ENABLED = '1';
process.env.MOSS_OTEL_URL = 'http://localhost:4318'; // receiver 可能没起，fire-and-forget 不抛
process.env.MOSS_FILE_TRACE = '1';

initObservability({ workspaceDir: tmp });

// 三层 span：session → turn → llm（模拟 agent 调用栈）
await withSpan('moss.session', { runId: 'r1', model: 'm', sessionKey: 'sk' }, async () => {
  return withSpan('moss.agent.turn', { runId: 'r1', turn: 1, model: 'm' }, async () => {
    return withSpan(
      'moss.llm.request',
      { runId: 'r1', model: 'm', inputTokens: 100 },
      async (span) => {
        span.setAttribute('outputTokens', 50);
        mossMetrics.llmTokens.add(100, { direction: 'input', model: 'm' });
        mossMetrics.llmTokens.add(50, { direction: 'output', model: 'm' });
        mossMetrics.llmDuration.record(42, { model: 'm' });
        return 'done';
      }
    );
  });
});

await shutdownObservability();

const file = path.join(tmp, '.moss', 'analytics', 'traces.jsonl');
const stats = await readTraceStats(file);
assert.equal(stats.totalSpans, 3, 'three nested spans landed in file');
assert.ok(stats.byName['moss.session'], 'session span present');
assert.ok(stats.byName['moss.agent.turn'], 'turn span present');
assert.ok(stats.byName['moss.llm.request'], 'llm span present');

await fs.rm(tmp, { recursive: true, force: true });
delete process.env.MOSS_OTEL_ENABLED;
delete process.env.MOSS_OTEL_URL;
delete process.env.MOSS_FILE_TRACE;
console.error('[spec] observability-integration OK');
```

- [ ] **Step 2: 运行确认（receiver 未起也应 PASS——文件 trace 不依赖网络）**

Run: `cd /d/moss-drobotics && npm run build -w @rdk-moss/agent && node packages/moss-agent/test/observability-integration.spec.mjs`
Expected: PASS，输出 `[spec] observability-integration OK`。若因 OTLP 发送超时拖慢但不抛错属正常；若卡住，确认 OTLP exporter 是 fire-and-forget（`BatchSpanProcessor` 异步发送，shutdown 时 flush 有超时上限）。

- [ ] **Step 3: 跑全量测试确认整体无回归**

Run: `cd /d/moss-drobotics && npm run test -w @rdk-moss/agent`
Expected: 全部 spec 通过。

- [ ] **Step 4: 手动 smoke（可选，需 receiver）**

若本地 `D:\otel` receiver 可起：

Run（在新窗口）：`D:\otel\start-receiver.cmd`
Run：`cd /d/moss-drobotics && MOSS_OTEL_ENABLED=1 MOSS_OTEL_SERVICE_NAME=moss node packages/moss-agent/dist/cli.js "hello"`
Expected: 面板 `http://localhost:3000` 看到 `moss.session` → `moss.agent.turn` → `moss.llm.request` span 树 + token/duration 指标；`.moss/analytics/traces.jsonl` 有内容。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/test/observability-integration.spec.mjs
git commit -m "test(agent): add observability end-to-end integration spec"
```

---

## Self-Review 结果

**1. Spec 覆盖：**

- 统一 SDK（一处 NodeSDK）→ Task 5 sdk.ts ✅
- 三层 span（session→turn→llm/tool）→ Task 11 / 10 / 8 / 9 ✅
- 共享 Resource → Task 5（resourceFromAttributes 一处）✅
- recordException → Task 4 withSpan catch ✅
- 批处理 → Task 5 BatchSpanProcessor ✅
- 本地文件 trace 保留 → Task 3 FileSpanProcessor + Task 5 挂载 ✅
- tracing 开则 metrics 默认开 → Task 5 index.ts ✅
- 优雅 flush → Task 7 shutdown + beforeExit ✅
- 关闭即零开销 → Task 4/2/5 noop + Task 5 spec 验证 ✅
- web 注入 traceparent → Task 6 ✅
- metrics 命名纠正（tool_count 非 turns）→ Task 2 ✅
- 砍 ab-testing / 不搬 trace-exporter 旧实现 → 文件结构未含二者 ✅
- 依赖 → Task 1 ✅
- 验证 → Task 12 ✅

**2. Placeholder 扫描：** Task 9/10/11 含「按文件实际类型/变量名修正」的指引——这是因 drobotics 代码具体类型（`ExecuteToolCallOutcome.outcome`、`ChatResult.toolCalls`、`chat()` 内 runId 可见性）需在实现时核对，已给出核对位置与不改控制流的约束，非空 TODO。其余步骤均有完整代码。

**3. Type consistency：** `withSpan` 签名（Task 4）`withSpan<T>(name, attrs, fn: (span: Span & TraceSpan) => Promise<T>)` 被 Task 8/9/10/11 一致使用；`mossMetrics` 字段名（Task 2：`llmTokens`/`llmDuration`/`toolInvocations`/`toolDuration`/`sessionCount`/`sessionDuration`/`sessionToolCount`）与 Task 8/9/11 调用一致；`propagateHeaders`（Task 5 导出）与 Task 6 调用一致；`readTraceStats`（Task 3 导出）与 Task 12 调用一致。
