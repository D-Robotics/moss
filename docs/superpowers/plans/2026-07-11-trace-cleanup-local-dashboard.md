# Trace 收尾 + 本地趋势看板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补完 Moss 已写好但未接通的 trace 采集能力（提交接线、OTLP 批量导出、本地 JSONL 接电、测试进 CI、env 文档化），并新增一个读 `.moss/analytics/` 的本地 HTML 趋势看板（`moss stats --serve`），让监控在不依赖 docker/Jaeger 时也能本地用并出历史趋势图。

**Architecture:** 三层：(1) 采集层 `packages/moss-agent/src/observability/` + agent 循环，补 session span 的 outcome 属性、改 OTLP bridge 为批量导出、接 `MOSS_TRACE=file` 到 `enableLocalTracing`；(2) 落盘层 `trace-exporter.ts`，加 `sessions.jsonl` 写入；(3) 展示层新包 `packages/moss-analytics-dashboard/`，一个 node http server 读 JSONL serve 内嵌 HTML 看板，由新 `moss stats` 顶层命令调起。数据流单向：agent 采集 → JSONL 落盘 → 看板读盘。

**Tech Stack:** TypeScript (ESM, `.js` 扩展名 import), Node.js >= 22.16 `node:http` + `fs/promises`, Vitest, 内联 SVG（零图表库依赖）。

## Global Constraints

- Node.js >= 22.16
- 默认不启用任何监控，零开销（noop tracer）；所有出口 best-effort，**永不抛异常到 agent 主循环**（静默 catch）
- ESM 模块，所有 import 使用 `.js` 扩展名（即使源文件是 `.ts`）
- 采集层代码沿用现有静默 catch 纪律
- 数据目录固定 `<workspace>/.moss/analytics/`，文件 `traces.jsonl` + `sessions.jsonl`
- 端口约定：otel 实时看板 `:3000`（已有不动），新趋势看板 `:3100`
- 监控 env 变量：`MOSS_TRACE`（`console`/`file`，互斥，冲突按 `file`>`console`>noop 优先级取一个）、`MOSS_OTEL_ENABLED`、`MOSS_OTEL_URL`（默认 `http://localhost:4318/v1/traces`）、`MOSS_OTEL_SERVICE_NAME`（默认 `moss`）。`MOSS_TRACE` 与 OTLP 三变量独立可同开
- 中文注释保留（仓库既有风格）

---

## File Structure

**采集层（修改 `packages/moss-agent/src/`）：**
- `observability/tracing.ts` — 改 `enableLocalTracing` 内 local tracer 的 `setAttribute` 为真写入（当前空实现，第 203 行）
- `observability/otel-bridge.ts` — 改 `sendSpan` 为缓冲 + 批量 flush（当前逐个 fetch）
- `observability/session-exporter.ts` — **新建**，`SessionExporter` 写 `sessions.jsonl`（镜像 `TraceFileExporter` 结构）
- `observability/index.ts` — 导出 `SessionExporter` + `globalSessionExporter`
- `core/agent/moss-agent.ts` — 在 `notifyRunObserver` 写回 session span outcome 属性 + 调 `globalSessionExporter`；接线本就在工作区脏状态，本 plan 一并提交
- `cli-main.ts` — 加 `MOSS_TRACE=file` 分支调 `enableLocalTracing`
- `cli/args.ts` — `CliCommand` 联合类型加 `'stats'`
- `cli/command-dispatcher.ts` — 注册 `stats` 命令（`WorkspaceReady` 相，handler 调 dashboard）
- `cli/stats-command.ts` — **新建**，`moss stats` 命令实现（终端聚合 + `--serve` 起看板）

**展示层（新建包 `packages/moss-analytics-dashboard/`）：**
- `packages/moss-analytics-dashboard/package.json` — 包定义
- `packages/moss-analytics-dashboard/src/server.ts` — node http server，读 JSONL，serve HTML
- `packages/moss-analytics-dashboard/src/dashboard-html.ts` — 内嵌 HTML + 内联 SVG 图表

**测试（修改 `packages/moss-agent/__tests__/observability/`）：**
- `otel-bridge.test.ts` — **新建**，批量导出测试
- `session-exporter.test.ts` — **新建**
- `tracing.test.ts` / `trace-exporter.test.ts` — 已存在，本 plan 解除 gitignore 接入 CI

**配置/文档：**
- `.gitignore` — 删除 `__tests__/` 行（或改为只忽略非 observability 的临时产物）
- `scripts/run-package-tests.mjs` — 加跑 vitest observability 套件
- `docs/env-vars.md` — 补全监控 env 变量说明

---

### Task 1: 提交现有未提交的 trace 接线

**Files:**
- Modify: `packages/moss-agent/src/core/agent/moss-agent.ts` (session span 创建 + parentSpan 透传，已在工作区)
- Modify: `packages/moss-agent/src/core/loop/agent-loop-*.ts`, `execute-tool-call.ts` (parentSpan 透传，已在工作区)
- Modify: `packages/moss-agent/src/observability/otel-bridge.ts` (已在工作区)

**Interfaces:**
- Consumes: 无（这是把现有脏改动落定）
- Produces: 已接通的 `session`/`agent.llm_turn`/`tool.execute` span + `parentSpan` 透传链，后续 Task 基于此

**Why first:** 当前工作区有未提交的 session span 接线（`moss-agent.ts:1560` 创建 session span、`moss-agent.ts:1567` 赋 `run.params.parentSpan`、loop 各处透传 `parentSpan`）。先把它落定成一个干净基线，避免后续 Task 跟脏改动混在一起难审。

- [ ] **Step 1: 确认脏改动范围**

Run: `cd D:/moss-from-remote && git status --short`
Expected: 列出 `moss-agent.ts`、`agent-loop-*.ts`、`execute-tool-call.ts`、`otel-bridge.ts` 等 `M` 状态

Run: `git diff --stat`
Expected: 看到 session span / parentSpan 相关改动行数

- [ ] **Step 2: 人工核对关键接线点确实在**

Run: `grep -n "sessionSpan\|parentSpan = sessionSpan" packages/moss-agent/src/core/agent/moss-agent.ts`
Expected: 看到 `moss-agent.ts:1560` `getTracer().startSpan('session', ...)` 和 `:1567` `run.params.parentSpan = sessionSpan`

Run: `grep -rn "parentSpan" packages/moss-agent/src/core/loop/ | head`
Expected: `agent-loop-types.ts`、`agent-loop.ts`、`agent-loop-tool-execution.ts`、`execute-tool-call.ts` 都有 `parentSpan` 透传

- [ ] **Step 3: 确认编译通过**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
cd D:/moss-from-remote
git add packages/moss-agent/src/core/agent/moss-agent.ts \
        packages/moss-agent/src/core/loop/agent-loop-types.ts \
        packages/moss-agent/src/core/loop/agent-loop.ts \
        packages/moss-agent/src/core/loop/agent-loop-llm-call.ts \
        packages/moss-agent/src/core/loop/agent-loop-response.ts \
        packages/moss-agent/src/core/loop/agent-loop-tool-execution.ts \
        packages/moss-agent/src/core/tools/execute-tool-call.ts \
        packages/moss-agent/src/observability/otel-bridge.ts
git commit -m "feat: wire session span + parentSpan propagation through agent loop

Adds the 'session' root span in streamChatViaAgentLoop and threads
parentSpan down to agent.llm_turn and tool.execute spans so OTLP
backends show the full session → llm_turn → tool.execute trace tree."
```

---

### Task 2: local tracer 的 setAttribute 改为真写入

**Files:**
- Modify: `packages/moss-agent/src/observability/tracing.ts:193-226` (`enableLocalTracing` 内的 local tracer)

**Interfaces:**
- Consumes: `globalTraceExporter`, `SerializedSpan` from `./trace-exporter.js`
- Produces: local tracer 的 `setAttribute(key, value)` 真正写入 span 的 `attributes`，使会话 outcome 等运行时属性能落进 `traces.jsonl`。签名不变（仍 `setAttribute(key: string, value: string|number|boolean): void`）

**Why:** 当前 `tracing.ts:203` 的 `setAttribute() {}` 是空实现，导致后续 Task 在 session span 上 `setAttribute('outcome', ...)` 写不进数据，趋势看板画不出会话质量维度。

- [ ] **Step 1: 写失败测试**

在 `packages/moss-agent/__tests__/observability/tracing.test.ts` 的 `describe('enableLocalTracing', ...)` 块内末尾追加：

```ts
  it('setAttribute 写入的属性出现在 traces.jsonl', async () => {
    enableLocalTracing(workspaceDir);

    await withSpan('test.attr_span', { initial: 'a' }, async (span) => {
      span.setAttribute('outcome', 'completed');
      span.setAttribute('turns', 5);
    });

    await globalTraceExporter.flush();
    const file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
    const content = await fs.readFile(file, 'utf-8');
    const span = JSON.parse(content.trim());
    expect(span.attributes.initial).toBe('a');
    expect(span.attributes.outcome).toBe('completed');
    expect(span.attributes.turns).toBe(5);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx vitest run __tests__/observability/tracing.test.ts --config __tests__/vitest.config.ts --root __tests__`
Expected: FAIL — `span.attributes.outcome` 为 `undefined`（当前 `setAttribute` 是空实现）

- [ ] **Step 3: 改实现**

把 `packages/moss-agent/src/observability/tracing.ts:193-226` 的 `enableLocalTracing` 整体替换为：

```ts
export function enableLocalTracing(workspaceDir: string): void {
  globalTraceExporter.init(workspaceDir);
  defaultTraceRegistry.setTracer({
    startSpan(name, attributes, _parent) {
      const startTime = Date.now();
      const events: SerializedSpan['events'] = [];
      // Merge initial attributes (startSpan) with mutable ones (setAttribute).
      const attrs: Record<string, string | number | boolean> = { ...(attributes ?? {}) };
      let status: SerializedSpan['status'] = 'ok';
      let statusMessage: string | undefined;

      return {
        setAttribute(key, value) {
          attrs[key] = value;
        },
        addEvent(eventName, eventAttrs) {
          events.push({ name: eventName, time: Date.now(), attrs: eventAttrs });
        },
        setStatus(ok, message) {
          status = ok ? 'ok' : 'error';
          statusMessage = message;
        },
        end() {
          const span: SerializedSpan = {
            name,
            startTime,
            endTime: Date.now(),
            attributes: attrs,
            events,
            status,
            ...(statusMessage ? { statusMessage } : {}),
          };
          globalTraceExporter.exportSpan(span);
        },
      };
    },
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx vitest run __tests__/observability/tracing.test.ts --config __tests__/vitest.config.ts --root __tests__`
Expected: PASS（全部，含新测试）

- [ ] **Step 5: 提交**

```bash
cd D:/moss-from-remote
git add packages/moss-agent/src/observability/tracing.ts \
        packages/moss-agent/__tests__/observability/tracing.test.ts
git commit -m "fix: local tracer setAttribute now persists attributes to traces.jsonl"
```

---

### Task 3: OTLP bridge 改批量导出

**Files:**
- Modify: `packages/moss-agent/src/observability/otel-bridge.ts` (`sendSpan` + 新增 flush 机制)
- Test: `packages/moss-agent/__tests__/observability/otel-bridge.test.ts` (create)

**Interfaces:**
- Consumes: `OtelTracingOptions`（`serviceName?`, `url?`），`Tracer`/`TraceSpan` from `./tracing.js`
- Produces: `enableOtelTracing(options)` 行为改为缓冲——span `end()` 时入内存缓冲，30 秒定时或满 64 个 flush 一次批量 POST 到 OTLP；fetch 失败静默丢弃不重试。对外签名不变

**Why:** 当前 `otel-bridge.ts:93` 每个 `span.end()` 一个 `fetch`，一次会话几十个 span 就是几十个 HTTP 请求，无批量无背压。模式照抄 `TraceFileExporter`（30s 定时 + 满量）。

- [ ] **Step 1: 写失败测试**

创建 `packages/moss-agent/__tests__/observability/otel-bridge.test.ts`：

```ts
/**
 * Tests for otel-bridge batch export behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enableOtelTracing, disableOtelTracing } from '../../src/observability/otel-bridge.js';
import { withSpan, setTracer } from '../../src/observability/tracing.js';

// Capture fetch calls so we can assert batch behavior without a real server.
let fetchCalls: Array<{ url: string; body: any }>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  // Stub global fetch. Resolve with a 200 so the bridge's .catch path isn't hit.
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  disableOtelTracing();
  globalThis.fetch = originalFetch;
  // Reset to noop tracer
  setTracer({
    startSpan: () => ({ setAttribute() {}, addEvent() {}, setStatus() {}, end() {} }),
  });
});

describe('otel-bridge batch export', () => {
  it('span.end() 不立即发送，缓冲到 flush', async () => {
    enableOtelTracing({ serviceName: 'moss-test', url: 'http://localhost:4318/v1/traces' });

    await withSpan('a.span', { k: 'v' }, async () => {});
    await withSpan('b.span', { k: 'v' }, async () => {});

    // Immediately after spans end: no fetch yet (buffered).
    expect(fetchCalls.length).toBe(0);

    // Trigger a flush via the exported flushOtlpBuffer.
    const { flushOtlpBuffer } = await import('../../src/observability/otel-bridge.js');
    await flushOtlpBuffer();

    expect(fetchCalls.length).toBe(1);
    const spans = fetchCalls[0].body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.length).toBe(2);
    expect(spans[0].name).toBe('a.span');
    expect(spans[1].name).toBe('b.span');
  });

  it('满 64 个 span 自动 flush', async () => {
    enableOtelTracing({ serviceName: 'moss-test', url: 'http://localhost:4318/v1/traces' });

    for (let i = 0; i < 64; i++) {
      await withSpan(`span.${i}`, {}, async () => {});
    }
    // 64 spans should trigger the fullness flush.
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('fetch 失败静默不抛', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    enableOtelTracing({ serviceName: 'moss-test', url: 'http://localhost:4318/v1/traces' });

    await withSpan('x.span', {}, async () => {});
    const { flushOtlpBuffer } = await import('../../src/observability/otel-bridge.js');
    await expect(flushOtlpBuffer()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx vitest run __tests__/observability/otel-bridge.test.ts --config __tests__/vitest.config.ts --root __tests__`
Expected: FAIL — `flushOtlpBuffer` 不存在（未导出）；且当前 `sendSpan` 是逐个发，`fetchCalls.length` 会是 2 而非 0

- [ ] **Step 3: 改实现**

把 `packages/moss-agent/src/observability/otel-bridge.ts` 的 `sendSpan` 函数（当前第 43-100 行）及模块级状态（第 21-23 行 `enabled`/`otlpUrl`/`serviceName`）整体重构。替换 `sendSpan` 及其上方状态区为：

```ts
let enabled = false;
let otlpUrl = '';
let serviceName = '';
let buffer: OtelSpanState[] = [];
const FLUSH_THRESHOLD = 64;
const FLUSH_INTERVAL_MS = 30_000;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function sendSpan(state: OtelSpanState): void {
  if (!enabled) return;
  buffer.push(state);
  if (buffer.length >= FLUSH_THRESHOLD) {
    void flushOtlpBuffer();
  }
}

/** Flush all buffered spans to the OTLP endpoint. Fire-and-forget on errors. */
export async function flushOtlpBuffer(): Promise<void> {
  if (!enabled || buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  const payload = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
      scopeSpans: [{
        scope: { name: 'moss-agent' },
        spans: batch.map((state) => buildOtlpSpan(state)),
      }],
    }],
  };
  try {
    await fetch(otlpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Silently ignore — monitoring is best-effort; do not retry to avoid unbounded memory growth.
  }
}

function buildOtlpSpan(state: OtelSpanState): Record<string, unknown> {
  const mergedAttributes = { ...state.initialAttributes, ...state.mutableAttributes };
  const otlpSpan: Record<string, unknown> = {
    traceId: state.traceId,
    spanId: state.spanId,
    name: state.name,
    kind: 1, // INTERNAL
    startTimeUnixNano: String(BigInt(state.startTime) * 1_000_000n),
    endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    attributes: Object.entries(mergedAttributes).map(([key, value]) => ({
      key,
      value: typeof value === 'number' ? { intValue: value }
           : typeof value === 'boolean' ? { boolValue: value }
           : { stringValue: String(value) },
    })),
    status: state.status === 'error'
      ? { code: 2, message: state.statusMessage ?? '' }
      : { code: 1 },
    events: state.events.map((e) => ({
      name: e.name,
      timeUnixNano: String(BigInt(e.time) * 1_000_000n),
    })),
  };
  if (state.parentSpanId) otlpSpan.parentSpanId = state.parentSpanId;
  return otlpSpan;
}
```

然后在 `enableOtelTracing`（当前第 121 行）函数体内，`setTracer(otelTracer)` 之前加启动定时器、`enabled = true` 之后：

```ts
  enabled = true;
  serviceName = options.serviceName ?? 'moss';
  otlpUrl = options.url ?? 'http://localhost:4318/v1/traces';
  buffer = [];
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = setInterval(() => { void flushOtlpBuffer(); }, FLUSH_INTERVAL_MS);
```

在 `disableOtelTracing`（当前第 188 行）函数体内加清理：

```ts
export function disableOtelTracing(): void {
  enabled = false;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  void flushOtlpBuffer(); // best-effort final flush
  setTracer(getTracer());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx vitest run __tests__/observability/otel-bridge.test.ts --config __tests__/vitest.config.ts --root __tests__`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: 类型检查**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
cd D:/moss-from-remote
git add packages/moss-agent/src/observability/otel-bridge.ts \
        packages/moss-agent/__tests__/observability/otel-bridge.test.ts
git commit -m "perf: batch OTLP span export (buffer + 30s/64-span flush)"
```

---

### Task 4: SessionExporter — sessions.jsonl 落盘

**Files:**
- Create: `packages/moss-agent/src/observability/session-exporter.ts`
- Modify: `packages/moss-agent/src/observability/index.ts` (export)
- Test: `packages/moss-agent/__tests__/observability/session-exporter.test.ts` (create)

**Interfaces:**
- Consumes: 无外部依赖（仅 `node:fs/promises`, `node:path`）
- Produces: `SessionExporter` 类（`init(workspaceDir)`, `exportSession(summary)`, `flush()`, `cleanup()`）、`globalSessionExporter` 单例、`SessionSummary` 类型。落盘到 `<workspace>/.moss/analytics/sessions.jsonl`，每行一个 JSON

**Why:** `notifyRunObserver` 现在只 POST 会话摘要给 otel receiver（内存，重启丢）。本地模式下需要落盘，给趋势看板画会话 outcome 分布饼图 + 会话卡片列表。镜像 `TraceFileExporter` 的缓冲+flush 结构。

- [ ] **Step 1: 写失败测试**

创建 `packages/moss-agent/__tests__/observability/session-exporter.test.ts`：

```ts
/**
 * Tests for session-exporter.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SessionExporter, type SessionSummary } from '../../src/observability/session-exporter.js';

let workspaceDir: string;
let exporter: SessionExporter;

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionKey: 's1', runId: 'r1', userMessage: 'hi', assistantSummary: 'ok',
    toolsUsed: ['read_file'], outcome: 'completed', turns: 1, toolCalls: 1,
    durationMs: 100, tokensIn: 10, tokensOut: 5, time: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-session-exp-test-'));
  exporter = new SessionExporter();
});
afterEach(async () => {
  await exporter.cleanup();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('SessionExporter', () => {
  it('未 init 时 exportSession 不写文件', async () => {
    exporter.exportSession(makeSummary());
    await exporter.flush();
    const file = path.join(workspaceDir, '.moss', 'analytics', 'sessions.jsonl');
    await expect(fs.access(file)).rejects.toThrow();
  });

  it('flush 后 sessions.jsonl 每行一个摘要', async () => {
    exporter.init(workspaceDir);
    exporter.exportSession(makeSummary({ outcome: 'completed' }));
    exporter.exportSession(makeSummary({ outcome: 'error', runId: 'r2' }));
    await exporter.flush();

    const file = path.join(workspaceDir, '.moss', 'analytics', 'sessions.jsonl');
    const lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean);
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).outcome).toBe('completed');
    expect(JSON.parse(lines[1]).runId).toBe('r2');
  });

  it('写失败静默不抛', async () => {
    // Point at a path whose parent can't be created (reserved name on win / no perm).
    exporter.init('Z:\\nonexistent-root-xyz\\sub');
    exporter.exportSession(makeSummary());
    await expect(exporter.flush()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx vitest run __tests__/observability/session-exporter.test.ts --config __tests__/vitest.config.ts --root __tests__`
Expected: FAIL — `session-exporter.js` 不存在，import 报错

- [ ] **Step 3: 写实现**

创建 `packages/moss-agent/src/observability/session-exporter.ts`：

```ts
/**
 * SessionExporter — persists session summaries to a local JSONL file.
 *
 * Default: no-op until init() is called. When enabled, summaries are buffered
 * in memory and flushed to .moss/analytics/sessions.jsonl every 30 seconds.
 * Mirrors TraceFileExporter's structure.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface SessionSummary {
  sessionKey: string;
  runId: string;
  userMessage: string;
  assistantSummary: string;
  toolsUsed: string[];
  outcome: 'completed' | 'error' | 'cancelled' | 'completed_partial' | 'unknown';
  turns: number;
  toolCalls: number;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  errorDetail?: string;
  time: number;
}

export class SessionExporter {
  private enabled = false;
  private buffer: SessionSummary[] = [];
  private analyticsDir: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  init(workspaceDir: string): void {
    this.enabled = true;
    this.analyticsDir = path.join(workspaceDir, '.moss', 'analytics');
    this.flushTimer = setInterval(() => { void this.flush(); }, 30_000);
  }

  exportSession(summary: SessionSummary): void {
    if (!this.enabled) return;
    this.buffer.push(summary);
  }

  async flush(): Promise<void> {
    if (!this.enabled || !this.analyticsDir || this.buffer.length === 0) return;
    try {
      await fs.mkdir(this.analyticsDir, { recursive: true });
      const file = path.join(this.analyticsDir, 'sessions.jsonl');
      const lines = this.buffer.map((s) => JSON.stringify(s)).join('\n') + '\n';
      await fs.appendFile(file, lines, 'utf-8');
    } catch {
      // Silently ignore — never block the agent
    }
    this.buffer = [];
  }

  async cleanup(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    await this.flush();
    this.enabled = false;
    this.analyticsDir = null;
  }
}

/** Global singleton */
export const globalSessionExporter = new SessionExporter();
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx vitest run __tests__/observability/session-exporter.test.ts --config __tests__/vitest.config.ts --root __tests__`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: 加导出**

在 `packages/moss-agent/src/observability/index.ts` 末尾（现有 `otel-bridge` 导出块之后）追加：

```ts
// Session summary exporter (local file-based session persistence)
export {
  SessionExporter,
  globalSessionExporter,
} from './session-exporter.js';
export type { SessionSummary } from './session-exporter.js';
```

- [ ] **Step 6: 类型检查 + 全量 observability 测试**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

Run: `npx vitest run __tests__/observability/ --config __tests__/vitest.config.ts --root __tests__`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
cd D:/moss-from-remote
git add packages/moss-agent/src/observability/session-exporter.ts \
        packages/moss-agent/src/observability/index.ts \
        packages/moss-agent/__tests__/observability/session-exporter.test.ts
git commit -m "feat: add SessionExporter for sessions.jsonl persistence"
```

---

### Task 5: notifyRunObserver 写回 session span 属性 + 落 sessions.jsonl

**Files:**
- Modify: `packages/moss-agent/src/core/agent/moss-agent.ts:1373-1419` (`notifyRunObserver`)
- Test: `packages/moss-agent/__tests__/observability/session-outcome.test.ts` (create)

**Interfaces:**
- Consumes: `globalSessionExporter`, `SessionSummary` from `../../observability/session-exporter.js`；session span 引用（`run.params.parentSpan`，Task 1 已接通）
- Produces: `notifyRunObserver` 在算完 outcome 后：(a) `sessionSpan.setAttribute('outcome'|'turns'|'toolCalls'|'tokensIn'|'tokensOut', ...)` 写回；(b) 若 `MOSS_TRACE=file` 则 `globalSessionExporter.exportSession(summary)` + `flush()`

**Why:** 闭合数据流——outcome 现在只在内存/POST 给 otel，趋势看板画不出会话质量维度。写回 span 属性后 `traces.jsonl` 的 session span 带 outcome；`sessions.jsonl` 给看板会话卡片。

- [ ] **Step 1: 写失败测试**

创建 `packages/moss-agent/__tests__/observability/session-outcome.test.ts`：

```ts
/**
 * Tests that session-level outcome attributes are written back to the session
 * span (and thus traces.jsonl) and that sessions.jsonl is persisted in file mode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  enableLocalTracing,
  setTracer,
  getTracer,
} from '../../src/observability/tracing.js';
import {
  globalTraceExporter,
  globalSessionExporter,
} from '../../src/observability/index.js';

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-session-outcome-'));
  globalSessionExporter.init(workspaceDir);
  enableLocalTracing(workspaceDir);
});
afterEach(async () => {
  await globalSessionExporter.cleanup();
  await globalTraceExporter.cleanup();
  setTracer(getTracer()); // reset
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('session span outcome write-back', () => {
  it('setAttribute outcome 落入 traces.jsonl', async () => {
    // Simulate what notifyRunObserver does: start a session span, then write
    // outcome attributes back before ending it.
    const tracer = getTracer();
    const span = tracer.startSpan('session', { runId: 'r1', model: 'm' });
    span.setAttribute('outcome', 'completed');
    span.setAttribute('turns', 3);
    span.setAttribute('toolCalls', 2);
    span.setAttribute('tokensIn', 100);
    span.setAttribute('tokensOut', 50);
    span.setStatus(true);
    span.end();

    await globalTraceExporter.flush();
    const file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
    const lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean);
    const sessionSpan = JSON.parse(lines[0]);
    expect(sessionSpan.name).toBe('session');
    expect(sessionSpan.attributes.outcome).toBe('completed');
    expect(sessionSpan.attributes.turns).toBe(3);
    expect(sessionSpan.attributes.toolCalls).toBe(2);
  });

  it('exportSession + flush 落入 sessions.jsonl', async () => {
    globalSessionExporter.exportSession({
      sessionKey: 's1', runId: 'r1', userMessage: 'hi', assistantSummary: 'ok',
      toolsUsed: ['read_file'], outcome: 'completed', turns: 1, toolCalls: 1,
      durationMs: 100, tokensIn: 10, tokensOut: 5, time: 1000,
    });
    await globalSessionExporter.flush();
    const file = path.join(workspaceDir, '.moss', 'analytics', 'sessions.jsonl');
    const lines = (await fs.readFile(file, 'utf-8')).split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).outcome).toBe('completed');
  });
});
```

- [ ] **Step 2: 跑测试确认状态**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx vitest run __tests__/observability/session-outcome.test.ts --config __tests__/vitest.config.ts --root __tests__`
Expected: 第一个测试 PASS（Task 2 已让 setAttribute 真写入）；第二个测试 PASS（Task 4 已实现 exportSession）。这两个测试作为 `notifyRunObserver` 改动的"契约"——只要底层机制在，集成就是接线。若 FAIL 说明 Task 2/4 有回归，先修。

- [ ] **Step 3: 改 `notifyRunObserver` 接线**

读 `packages/moss-agent/src/core/agent/moss-agent.ts:1373-1419` 确认当前结构（`notifyRunObserver` 已算 outcome 并 POST session-summary）。在 `const summary = { ... }` 之后、`// Send to the OTEL receiver's session-summary endpoint` 之前，插入写回 session span + 本地落盘逻辑。

在 `notifyRunObserver` 内，`const summary = { ... };` 块之后插入：

```ts
      // Write session-level attributes back onto the session span so they land
      // in traces.jsonl (for trend charts) and the OTLP backend.
      const sessionSpan = run.params.parentSpan;
      if (sessionSpan) {
        try {
          sessionSpan.setAttribute('outcome', outcome);
          sessionSpan.setAttribute('turns', summary.turns);
          sessionSpan.setAttribute('toolCalls', summary.toolCalls);
          sessionSpan.setAttribute('tokensIn', summary.tokensIn);
          sessionSpan.setAttribute('tokensOut', summary.tokensOut);
        } catch {
          // Best-effort — never disrupt the agent
        }
      }

      // Persist session summary locally if file tracing is enabled.
      if (process.env.MOSS_TRACE === 'file') {
        try {
          const { globalSessionExporter } = await import('../../observability/session-exporter.js');
          globalSessionExporter.exportSession({ ...summary, time: Date.now() });
          void globalSessionExporter.flush();
        } catch {
          // Silently ignore — never block the agent
        }
      }
```

注意：`summary` 当前对象没有 `time` 字段（time 在 otel POST 路径是 receiver 端补的）。给本地落盘补 `time: Date.now()`。确认 `summary` 的字段名与 `SessionSummary` 接口一致（Task 4 定义）。若 `summary` 里 `outcome` 是 string 字面量类型不匹配 `SessionSummary['outcome']` 联合类型，用 `outcome: outcome as SessionSummary['outcome']` 断言。

- [ ] **Step 4: 类型检查**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误（注意可能的 `outcome` 类型断言）

- [ ] **Step 5: 跑全量 observability 测试**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx vitest run __tests__/observability/ --config __tests__/vitest.config.ts --root __tests__`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
cd D:/moss-from-remote
git add packages/moss-agent/src/core/agent/moss-agent.ts \
        packages/moss-agent/__tests__/observability/session-outcome.test.ts
git commit -m "feat: write session outcome attrs to span + persist sessions.jsonl"
```

---

### Task 6: 接 MOSS_TRACE=file 到 enableLocalTracing + SessionExporter init

**Files:**
- Modify: `packages/moss-agent/src/cli-main.ts:613-619` (tracing 启用区)

**Interfaces:**
- Consumes: `enableLocalTracing` from `./observability/tracing.js`，`globalSessionExporter` from `./observability/session-exporter.js`
- Produces: CLI 启动时按 `MOSS_TRACE` 装相应 tracer。`MOSS_TRACE=file` → `enableLocalTracing(workspace)` + `globalSessionExporter.init(workspace)`

**Why:** `enableLocalTracing` 定义了但无调用点（Task 前盘点确认）。`MOSS_TRACE=console` 也补上（现有 `MOSS_TRACE=console` 在 docs 提到但未确认接线，一并接）。OTLP 路已有。这是本地导出路的"接电"。

- [ ] **Step 1: 改 cli-main.ts tracing 启用区**

把 `packages/moss-agent/src/cli-main.ts:613-619` 的：

```ts
  // Enable OTel tracing if MOSS_OTEL_URL is set
  if (process.env.MOSS_OTEL_URL || process.env.MOSS_OTEL_ENABLED) {
    enableOtelTracing({
      serviceName: process.env.MOSS_OTEL_SERVICE_NAME ?? 'moss',
      url: process.env.MOSS_OTEL_URL ?? undefined,
    });
  }
```

替换为：

```ts
  // Enable tracing per env. MOSS_TRACE and OTLP are independent and can both be on.
  const traceMode = process.env.MOSS_TRACE; // 'console' | 'file' | undefined
  if (traceMode === 'console') {
    const { setTracer } = await import('./observability/tracing.js');
    setTracer('console');
  } else if (traceMode === 'file') {
    const { enableLocalTracing } = await import('./observability/tracing.js');
    const { globalSessionExporter } = await import('./observability/session-exporter.js');
    enableLocalTracing(workspace);
    globalSessionExporter.init(workspace);
  }
  // 'file' takes precedence over 'console' if both somehow set (see spec config rules).

  if (process.env.MOSS_OTEL_URL || process.env.MOSS_OTEL_ENABLED) {
    enableOtelTracing({
      serviceName: process.env.MOSS_OTEL_SERVICE_NAME ?? 'moss',
      url: process.env.MOSS_OTEL_URL ?? undefined,
    });
  }
```

确认 `workspace` 变量在此作用域可用（上方 `fallbackStartDir`/`workspace` 已在第 343 行附近解析）。若 `workspace` 尚未在此行之前定义，用 `process.env.MOSS_WORKSPACE || safeProcessCwd()` 对应值——读上下文确认变量名后填实际名。

- [ ] **Step 2: 类型检查**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 3: 手动烟测（若环境允许）**

Run: `cd D:/moss-from-remote && MOSS_TRACE=file node packages/moss-agent/dist/cli.js chat "say hi" --max-turns 1 2>&1 | tail -5`
（若 dist 未构建，先 `npm run build -w packages/moss-agent`）
Expected: 不报错；会话结束后检查 `<workspace>/.moss/analytics/traces.jsonl` 与 `sessions.jsonl` 存在且有内容

Run: `cat .moss/analytics/traces.jsonl | head -1 | python -m json.tool 2>/dev/null || head -1 .moss/analytics/traces.jsonl`
Expected: 看到 session span 含 `outcome` 属性

- [ ] **Step 4: 提交**

```bash
cd D:/moss-from-remote
git add packages/moss-agent/src/cli-main.ts
git commit -m "feat: wire MOSS_TRACE=file to enableLocalTracing + SessionExporter"
```

---

### Task 7: 新建 moss-analytics-dashboard 包（看板 server + HTML）

**Files:**
- Create: `packages/moss-analytics-dashboard/package.json`
- Create: `packages/moss-analytics-dashboard/src/server.ts`
- Create: `packages/moss-analytics-dashboard/src/dashboard-html.ts`
- Create: `packages/moss-analytics-dashboard/tsconfig.json`

**Interfaces:**
- Consumes: `node:http`, `node:fs/promises`；读 `<workspace>/.moss/analytics/traces.jsonl` + `sessions.jsonl`
- Produces: `startDashboardServer({ workspaceDir, port })` 函数，起 http server：`GET /` 返回 HTML，`GET /api/traces` 返回 span 数组，`GET /api/sessions` 返回会话摘要数组，`GET /api/stats` 返回聚合。HTML 内嵌内联 SVG 图表

**Why:** 展示层。零后端依赖、零图表库，结构照搬 `D:\otel\otel-receiver.mjs`。独立包保持采集/展示分离（spec 方案 A）。

- [ ] **Step 1: 建包骨架**

创建 `packages/moss-analytics-dashboard/package.json`：

```json
{
  "name": "@rdk-moss/analytics-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/server.js",
  "exports": {
    ".": "./dist/server.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "echo no tests"
  },
  "engines": { "node": ">=22.16" }
}
```

创建 `packages/moss-analytics-dashboard/tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 写 dashboard-html.ts（HTML + 内联 SVG 图表）**

创建 `packages/moss-analytics-dashboard/src/dashboard-html.ts`。导出一个返回完整 HTML 字符串的函数。图表用内联 SVG 手写（折线/柱状/饼图），数据由前端 fetch `/api/*` 后 JS 渲染。结构参考 `D:\otel\otel-receiver.mjs:121-401`（同构：dark 主题、2s 轮询、stat 卡片 + 图表区）。

```ts
/**
 * Embedded HTML for the Moss analytics trend dashboard.
 * Zero dependencies — inline SVG charts, vanilla JS, 2s polling.
 * Structure mirrors D:\otel\otel-receiver.mjs.
 */
export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moss 趋势看板</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; }
h1 { font-size: 22px; color: #58a6ff; margin-bottom: 4px; }
.subtitle { font-size: 12px; color: #484f58; margin-bottom: 20px; }
.stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
.stat { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 14px 20px; min-width: 120px; }
.stat .label { font-size: 12px; color: #8b949e; margin-bottom: 4px; }
.stat .value { font-size: 28px; font-weight: 700; }
.section-title { font-size: 14px; color: #8b949e; margin: 20px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #21262d; }
.chart-box { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.chart-box svg { width: 100%; height: 200px; }
.empty { text-align: center; padding: 60px; color: #484f58; }
.window-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
.window-tabs button { background: #161b22; border: 1px solid #21262d; color: #c9d1d9; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.window-tabs button.active { background: #1f3a5f; color: #58a6ff; border-color: #58a6ff; }
</style>
</head>
<body>
<h1>Moss 趋势看板</h1>
<div class="subtitle">数据源: .moss/analytics/ | 自动刷新 2s</div>
<div class="stats">
  <div class="stat"><div class="label">会话数</div><div class="value" id="sessionCount">0</div></div>
  <div class="stat"><div class="label">Span 总数</div><div class="value" id="spanCount">0</div></div>
  <div class="stat"><div class="label">错误</div><div class="value" style="color:#f85149" id="errorCount">0</div></div>
  <div class="stat"><div class="label">平均耗时</div><div class="value" id="avgMs">0<span style="font-size:14px;color:#8b949e">ms</span></div></div>
</div>
<div class="window-tabs">
  <button data-window="3600000" class="active">近 1h</button>
  <button data-window="86400000">近 24h</button>
  <button data-window="0">全部</button>
</div>
<div class="section-title">会话 Outcome 分布</div>
<div class="chart-box"><svg id="pieChart"></svg></div>
<div class="section-title">工具调用次数 (按时间)</div>
<div class="chart-box"><svg id="toolLineChart"></svg></div>
<div class="section-title">各工具平均耗时</div>
<div class="chart-box"><svg id="toolBarChart"></svg></div>
<div class="section-title">Token 趋势</div>
<div class="chart-box"><svg id="tokenLineChart"></svg></div>
<div class="empty" id="empty" style="display:none">暂无数据，等待 Moss 产生 traces...</div>

<script>
let windowMs = 3600000;
document.querySelectorAll('.window-tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('.window-tabs button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    windowMs = parseInt(b.dataset.window, 10);
    render();
  };
});

let cached = { traces: [], sessions: [], stats: { totalSpans:0, totalErrors:0, errorRate:0, byName:{}, toolSpans:[] } };

async function refresh() {
  try {
    const [tr, se, st] = await Promise.all([
      fetch('/api/traces').then(r => r.json()),
      fetch('/api/sessions').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
    ]);
    cached.traces = tr.traces || [];
    cached.sessions = se.sessions || [];
    cached.stats = st;
  } catch (e) {}
  render();
}

function fmt(ms) { return ms < 1000 ? ms+'ms' : ms < 60000 ? (ms/1000).toFixed(1)+'s' : (ms/60000).toFixed(1)+'min'; }

function filterByWindow(items, timeField) {
  if (windowMs === 0) return items;
  const cutoff = Date.now() - windowMs;
  return items.filter(i => (i[timeField] || 0) >= cutoff);
}

function render() {
  const s = cached.stats;
  document.getElementById('sessionCount').textContent = cached.sessions.length;
  document.getElementById('spanCount').textContent = s.totalSpans;
  document.getElementById('errorCount').textContent = s.totalErrors;
  document.getElementById('avgMs').innerHTML = Math.round(
    s.totalSpans ? (cached.traces.reduce((a,t)=>a+(t.duration||0),0)/cached.traces.length) : 0
  ) + '<span style="font-size:14px;color:#8b949e">ms</span>';

  const hasData = cached.traces.length > 0 || cached.sessions.length > 0;
  document.getElementById('empty').style.display = hasData ? 'none' : 'block';

  renderPie(filterByWindow(cached.sessions, 'time'));
  renderToolLine(filterByWindow(cached.traces.filter(t=>t.name==='tool.execute'), 'startTime'));
  renderToolBar(s.toolSpans || []);
  renderTokenLine(filterByWindow(cached.traces.filter(t=>t.name==='agent.llm_turn'), 'startTime'));
}

// ---- Pie chart: session outcome distribution ----
function renderPie(sessions) {
  const counts = {};
  for (const s of sessions) counts[s.outcome] = (counts[s.outcome]||0)+1;
  const colors = { completed:'#3fb950', error:'#f85149', cancelled:'#d29922', completed_partial:'#d29922', unknown:'#8b949e' };
  const total = sessions.length || 1;
  const cx=100, cy=100, r=80, R=50;
  let angle = -Math.PI/2;
  let paths = '';
  for (const [k,v] of Object.entries(counts)) {
    const slice = (v/total) * Math.PI*2;
    const a2 = angle + slice;
    const x1=cx+R*Math.cos(angle), y1=cy+R*Math.sin(angle);
    const x2=cx+R*Math.cos(a2), y2=cy+R*Math.sin(a2);
    const large = slice > Math.PI ? 1 : 0;
    paths += '<path d="M'+cx+','+cy+' L'+x1+','+y1+' A'+R+','+R+' 0 '+large+' 1 '+x2+','+y2+' Z" fill="'+(colors[k]||'#8b949e')+'" />';
    angle = a2;
  }
  let legend = '';
  let lx = 220;
  for (const [k,v] of Object.entries(counts)) {
    legend += '<rect x="'+lx+'" y="40" width="12" height="12" fill="'+(colors[k]||'#8b949e')+'" /><text x="'+(lx+18)+'" y="50" fill="#c9d1d9" font-size="13">'+k+': '+v+'</text>';
    lx += 110;
  }
  document.getElementById('pieChart').innerHTML = (paths || '<text x="100" y="100" text-anchor="middle" fill="#484f58">无数据</text>') + legend;
}

// ---- Line chart: tool calls over time (bucketed) ----
function renderToolLine(toolSpans) {
  const buckets = bucketByTime(toolSpans, 'startTime', 12);
  const max = Math.max(1, ...buckets.map(b=>b.length));
  const w=600, h=180, pad=20;
  let path = '';
  buckets.forEach((b,i) => {
    const x = pad + (i/(buckets.length-1||1))*(w-2*pad);
    const y = h-pad - (b.length/max)*(h-2*pad);
    path += (i===0?'M':'L')+x+','+y+' ';
    path += '<circle cx="'+x+'" cy="'+y+'" r="3" fill="#3fb950" />';
  });
  document.getElementById('toolLineChart').innerHTML = '<line x1="20" y1="160" x2="580" y2="160" stroke="#21262d" />'+path;
}

// ---- Bar chart: avg duration per tool ----
function renderToolBar(toolSpans) {
  const items = toolSpans.slice(0,8);
  const max = Math.max(1, ...items.map(t=>t.avgDurationMs));
  const w=600, h=180, pad=20, bw = Math.floor((w-2*pad)/Math.max(items.length,1));
  let bars = '';
  items.forEach((t,i) => {
    const x = pad + i*bw;
    const bh = (t.avgDurationMs/max)*(h-2*pad);
    bars += '<rect x="'+x+'" y="'+(h-pad-bh)+'" width="'+(bw-4)+'" height="'+bh+'" fill="#58a6ff" />';
    bars += '<text x="'+(x+bw/2)+'" y="'+(h-pad+14)+'" fill="#8b949e" font-size="10" text-anchor="middle">'+t.toolName.slice(0,8)+'</text>';
  });
  document.getElementById('toolBarChart').innerHTML = bars || '<text x="300" y="90" text-anchor="middle" fill="#484f58">无数据</text>';
}

// ---- Line chart: tokens over time ----
function renderTokenLine(llmSpans) {
  const buckets = bucketByTime(llmSpans, 'startTime', 12);
  const max = Math.max(1, ...buckets.map(b => b.reduce((a,s)=>a+((s.attrs&&s.attrs.outputTokens)||0),0)));
  const w=600, h=180, pad=20;
  let path = '';
  buckets.forEach((b,i) => {
    const sum = b.reduce((a,s)=>a+((s.attrs&&s.attrs.outputTokens)||0),0);
    const x = pad + (i/(buckets.length-1||1))*(w-2*pad);
    const y = h-pad - (sum/max)*(h-2*pad);
    path += (i===0?'M':'L')+x+','+y+' ';
  });
  document.getElementById('tokenLineChart').innerHTML = '<line x1="20" y1="160" x2="580" y2="160" stroke="#21262d" />'+path;
}

function bucketByTime(items, timeField, n) {
  if (items.length === 0) return Array.from({length:n}, ()=>[]);
  const times = items.map(i=>i[timeField]||0);
  const min = Math.min(...times), max = Math.max(...times, min+1);
  const span = (max-min)/n || 1;
  const buckets = Array.from({length:n}, ()=>[]);
  for (const it of items) {
    const idx = Math.min(n-1, Math.floor(((it[timeField]||0)-min)/span));
    buckets[idx].push(it);
  }
  return buckets;
}

setInterval(refresh, 2000);
refresh();
</script>
</body>
</html>`;
}
```

- [ ] **Step 3: 写 server.ts**

创建 `packages/moss-analytics-dashboard/src/server.ts`：

```ts
/**
 * Moss analytics trend dashboard server.
 * Reads .moss/analytics/traces.jsonl + sessions.jsonl, serves an HTML dashboard.
 * Zero backend deps — just node:http + fs/promises.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderDashboardHtml } from './dashboard-html.js';

export interface DashboardOptions {
  workspaceDir: string;
  port?: number;
}

function analyticsDir(workspaceDir: string): string {
  return path.join(workspaceDir, '.moss', 'analytics');
}

async function readJsonl(file: string): Promise<any[]> {
  try {
    const content = await fs.readFile(file, 'utf-8');
    return content.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return []; // file missing or unreadable → empty dataset
  }
}

export async function startDashboardServer(opts: DashboardOptions): Promise<http.Server> {
  const port = opts.port ?? 3100;
  const dir = analyticsDir(opts.workspaceDir);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderDashboardHtml());
        return;
      }
      if (url.pathname === '/api/traces') {
        const traces = (await readJsonl(path.join(dir, 'traces.jsonl')))
          .map((s: any) => ({
            name: s.name, startTime: s.startTime, endTime: s.endTime,
            duration: (s.endTime ?? 0) - (s.startTime ?? 0),
            status: s.status, attrs: s.attributes ?? {},
          }))
          .reverse()
          .slice(0, 500);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ traces }));
        return;
      }
      if (url.pathname === '/api/sessions') {
        const sessions = (await readJsonl(path.join(dir, 'sessions.jsonl'))).reverse();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions }));
        return;
      }
      if (url.pathname === '/api/stats') {
        const traces = await readJsonl(path.join(dir, 'traces.jsonl'));
        const totalSpans = traces.length;
        const totalErrors = traces.filter((t: any) => t.status === 'error').length;
        const byName: Record<string, { count: number; errors: number; avgDurationMs: number }> = {};
        const toolMap: Record<string, { toolName: string; count: number; errors: number; avgDurationMs: number }> = {};
        for (const t of traces) {
          const name = t.name;
          if (!byName[name]) byName[name] = { count: 0, errors: 0, avgDurationMs: 0 };
          const e = byName[name];
          e.count++;
          if (t.status === 'error') e.errors++;
          const d = (t.endTime ?? 0) - (t.startTime ?? 0);
          e.avgDurationMs = (e.avgDurationMs * (e.count - 1) + d) / e.count;
          if (name === 'tool.execute') {
            const tn = String(t.attributes?.toolName || 'unknown');
            if (!toolMap[tn]) toolMap[tn] = { toolName: tn, count: 0, errors: 0, avgDurationMs: 0 };
            const te = toolMap[tn];
            te.count++;
            if (t.status === 'error') te.errors++;
            te.avgDurationMs = (te.avgDurationMs * (te.count - 1) + d) / te.count;
          }
        }
        const stats = {
          totalSpans, totalErrors,
          errorRate: totalSpans ? totalErrors / totalSpans : 0,
          byName,
          toolSpans: Object.values(toolMap).sort((a, b) => b.count - a.count),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    } catch {
      res.writeHead(500);
      res.end('Internal error');
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} in use. Set a different port.`));
      else reject(err);
    });
    server.listen(port, () => {
      console.log(`Moss 趋势看板: http://localhost:${port}`);
      resolve(server);
    });
  });
}
```

- [ ] **Step 4: 类型检查 + 构建**

Run: `cd D:/moss-from-remote/packages/moss-analytics-dashboard && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
cd D:/moss-from-remote
git add packages/moss-analytics-dashboard/
git commit -m "feat: add moss-analytics-dashboard package (HTML trend dashboard server)"
```

---

### Task 8: moss stats 顶层命令

**Files:**
- Modify: `packages/moss-agent/src/cli/args.ts` (`CliCommand` 联合类型)
- Modify: `packages/moss-agent/src/cli/command-dispatcher.ts` (注册 `stats`)
- Create: `packages/moss-agent/src/cli/stats-command.ts`
- Modify: `packages/moss-agent/package.json` (依赖 `@rdk-moss/analytics-dashboard`)

**Interfaces:**
- Consumes: `startDashboardServer` from `@rdk-moss/analytics-dashboard`（Task 7）；`globalTraceExporter.getStats()` from `../../observability/trace-exporter.js`
- Produces: `moss stats`（终端打印聚合）和 `moss stats --serve`（起 :3100 看板）

**Why:** spec 成功标准 2。`moss stats` 是看板的唯一入口。模板照抄 `command-dispatcher.ts:220-288` 的 `sessions` 命令（`WorkspaceReady` 相，读目录，有子命令/flag）。

- [ ] **Step 1: 加 CliCommand 类型**

在 `packages/moss-agent/src/cli/args.ts` 的 `CliCommand` 联合类型（当前第 17-29 行）追加 `| 'stats'`：

```ts
export type CliCommand =
  | 'chat'
  | 'setup'
  | 'auth'
  | 'config'
  | 'doctor'
  | 'update'
  | 'resume'
  | 'fork'
  | 'mcp'
  | 'migrate'
  | 'sessions'
  | 'stats';
```

- [ ] **Step 2: 写 stats-command.ts**

创建 `packages/moss-agent/src/cli/stats-command.ts`：

```ts
/**
 * `moss stats` — print aggregated trace stats, or `moss stats --serve`
 * to launch the local HTML trend dashboard on :3100.
 */
import { globalTraceExporter } from '../observability/trace-exporter.js';

export interface StatsCommandOptions {
  workspace: string;
  serve: boolean;
  port?: number;
}

export async function runStatsCommand(opts: StatsCommandOptions): Promise<void> {
  // Initialize the exporter's analytics dir so getStats() reads from the workspace.
  // init() is idempotent-safe if already initialized (set enabled + dir + timer).
  globalTraceExporter.init(opts.workspace);

  if (opts.serve) {
    const { startDashboardServer } = await import('@rdk-moss/analytics-dashboard');
    await startDashboardServer({ workspaceDir: opts.workspace, port: opts.port ?? 3100 });
    // Keep the process alive — server.listen holds it, but be explicit.
    return;
  }

  // Terminal summary
  const stats = await globalTraceExporter.getStats();
  console.log('Moss trace stats');
  console.log('─'.repeat(50));
  console.log(`  total spans   ${stats.totalSpans}`);
  console.log(`  errors        ${stats.totalErrors} (${(stats.errorRate * 100).toFixed(1)}%)`);
  console.log('');
  console.log('By name:');
  for (const [name, e] of Object.entries(stats.byName)) {
    console.log(`  ${name.padEnd(20)} count=${e.count}  errors=${e.errors}  avg=${Math.round(e.avgDurationMs)}ms`);
  }
  if (stats.toolSpans.length > 0) {
    console.log('');
    console.log('By tool:');
    for (const t of stats.toolSpans) {
      console.log(`  ${t.toolName.padEnd(20)} count=${t.count}  errors=${t.errors}  avg=${Math.round(t.avgDurationMs)}ms`);
    }
  }
  if (stats.totalSpans === 0) {
    console.log('');
    console.log('  No traces yet. Run Moss with MOSS_TRACE=file to start collecting.');
  }
}
```

- [ ] **Step 3: 在 dispatcher 注册 stats 命令**

在 `packages/moss-agent/src/cli/command-dispatcher.ts` 的 `COMMANDS` 对象内（`sessions` 条目之后、闭合 `}` 之前）追加：

```ts
  stats: {
    name: 'stats',
    phase: CliPhase.WorkspaceReady,
    description: 'show aggregated trace stats, or launch the trend dashboard with --serve',
    handler: async (ctx) => {
      const { runStatsCommand } = await import('./stats-command.js');
      const workspace = ctx.workspace as string | undefined;
      if (!workspace) {
        console.error('[moss] stats needs a workspace.');
        process.exitCode = 1;
        return;
      }
      const serve = ctx.commandArgs.includes('--serve');
      const portArg = ctx.commandArgs.find((a) => a.startsWith('--port='));
      const port = portArg ? parseInt(portArg.slice(7), 10) : undefined;
      await runStatsCommand({ workspace, serve, port });
    },
  },
```

- [ ] **Step 4: 加包依赖**

在 `packages/moss-agent/package.json` 的 `dependencies` 内追加：

```json
    "@rdk-moss/analytics-dashboard": "0.1.0"
```

并在仓库根 `package.json` 的 `workspaces` 确认包含 `packages/*`（若已是 `packages/*` 通配则无需改）。运行 `cd D:/moss-from-remote && npm install` 让 workspace 链接生效。

- [ ] **Step 5: 类型检查 + 构建**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

Run: `cd D:/moss-from-remote/packages/moss-analytics-dashboard && npx tsc -p tsconfig.json`
Expected: dist/ 生成

Run: `cd D:/moss-from-remote/packages/moss-agent && npm run build 2>&1 | tail -3`（或对应 build 脚本）
Expected: 构建成功

- [ ] **Step 6: 烟测**

Run: `cd D:/moss-from-remote && MOSS_TRACE=file node packages/moss-agent/dist/cli.js stats 2>&1 | head -15`
Expected: 打印聚合统计（若之前 Task 6 烟测产生了数据则非空，否则显示 "No traces yet"）

Run: `node packages/moss-agent/dist/cli.js stats --serve &` 然后访问 http://localhost:3100
（Windows bash 用 `start //b` 或直接前台跑后 Ctrl-C）
Expected: 浏览器看到看板，三区图表渲染（有数据时）

- [ ] **Step 7: 提交**

```bash
cd D:/moss-from-remote
git add packages/moss-agent/src/cli/args.ts \
        packages/moss-agent/src/cli/command-dispatcher.ts \
        packages/moss-agent/src/cli/stats-command.ts \
        packages/moss-agent/package.json \
        package-lock.json
git commit -m "feat: add moss stats command (--serve launches trend dashboard)"
```

---

### Task 9: 解除测试 gitignore + 接入 CI 测试运行

**Files:**
- Modify: `D:/moss-from-remote/.gitignore` (`__tests__/` 行，当前第 63 行)
- Modify: `scripts/run-package-tests.mjs`
- Track: `packages/moss-agent/__tests__/observability/*.test.ts`（git add）

**Interfaces:**
- Consumes: 现有 vitest 套件（`__tests__/observability/`）
- Produces: observability 测试纳入版本控制 + CI 运行集

**Why:** spec 明确推翻旧约束"gitignore 排除测试"——这层代码已是核心采集层，必须有回归保护。`.gitignore:63` 的 `__tests__/` 导致所有 observability 测试被忽略、不进 CI。

- [ ] **Step 1: 改 .gitignore**

读 `D:/moss-from-remote/.gitignore` 找到 `__tests__/` 行（第 63 行）。删除该行。

若该行本意是忽略某临时产物而非整个测试目录，改为更精确的模式（如忽略 `__tests__/.cache/` 之类）——但当前是裸 `__tests__/`，会忽略所有测试，必须删。删除后确认 `git check-ignore packages/moss-agent/__tests__/observability/trace-exporter.test.ts` 无输出（即不再被忽略）。

- [ ] **Step 2: 把 observability 测试纳入版本控制**

```bash
cd D:/moss-from-remote
git add packages/moss-agent/__tests__/observability/trace-exporter.test.ts \
        packages/moss-agent/__tests__/observability/tracing.test.ts \
        packages/moss-agent/__tests__/observability/otel-bridge.test.ts \
        packages/moss-agent/__tests__/observability/session-exporter.test.ts \
        packages/moss-agent/__tests__/observability/session-outcome.test.ts \
        packages/moss-agent/__tests__/vitest.config.ts
```

- [ ] **Step 3: 在 run-package-tests.mjs 加跑 observability vitest 套件**

读 `scripts/run-package-tests.mjs`，在它现有跑 `test/*.spec.mjs` 的逻辑之后，追加一段跑 moss-agent 的 vitest observability 套件。在文件末尾（或现有测试循环之后）插入：

```js
// Also run the moss-agent vitest observability suite (TypeScript tests under __tests__/).
const vitestDir = join(repoRoot, 'packages', 'moss-agent');
const vitestConfig = join(vitestDir, '__tests__', 'vitest.config.ts');
if (existsSync(vitestConfig)) {
  console.log('[test] running moss-agent observability vitest suite…');
  const r = spawnSync('npx', ['vitest', 'run', '__tests__/observability/', '--config', '__tests__/vitest.config.ts', '--root', '__tests__'], {
    cwd: vitestDir,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('[test] moss-agent observability vitest suite FAILED');
    process.exit(r.status ?? 1);
  }
}
```

确认 `existsSync`/`join`/`spawnSync`/`repoRoot` 在该文件作用域可用（文件顶部已 import，见盘点）。

- [ ] **Step 4: 验证测试能跑**

Run: `cd D:/moss-from-remote && node scripts/run-package-tests.mjs 2>&1 | tail -15`
Expected: 看到 `[test] running moss-agent observability vitest suite…` 且该段 PASS、整体退出码 0

- [ ] **Step 5: 提交**

```bash
cd D:/moss-from-remote
git add .gitignore scripts/run-package-tests.mjs \
        packages/moss-agent/__tests__/
git commit -m "test: un-ignore observability tests and add to CI runner"
```

---

### Task 10: 补全 env 文档

**Files:**
- Modify: `D:/moss-from-remote/docs/env-vars.md`

**Interfaces:**
- Consumes: spec 的配置规则
- Produces: `MOSS_TRACE`/`MOSS_OTEL_ENABLED`/`MOSS_OTEL_URL`/`MOSS_OTEL_SERVICE_NAME` 文档化

**Why:** spec 成功标准之一。`docs/env-vars.md:94` 只有 `MOSS_TRACE=console`，其余三个 OTLP 变量未文档化，别人无法启用监控。

- [ ] **Step 1: 读 env-vars.md 找 MOSS_TRACE 行**

Run: `grep -n "MOSS_TRACE\|MOSS_OTEL\|MOSS_ANALYTICS" docs/env-vars.md`
Expected: 只有 `MOSS_TRACE` 一处（第 94 行附近）

- [ ] **Step 2: 替换 MOSS_TRACE 条目并追加 OTLP 条目**

把 `docs/env-vars.md` 中现有 `MOSS_TRACE` 那一行（`| `MOSS_TRACE` | — | Set to `console` to emit tracing spans to stderr. |`）替换为以下多行：

```markdown
| `MOSS_TRACE` | — | Tracing mode: `console` emits spans to stderr; `file` writes spans to `.moss/analytics/traces.jsonl` + session summaries to `sessions.jsonl`. If both `console` and `file` are somehow set, `file` wins. Unset = no-op (zero overhead). |
| `MOSS_OTEL_ENABLED` | — | Set any value to enable OTLP export using the default endpoint (`http://localhost:4318/v1/traces`). Independent of `MOSS_TRACE` — both can be on. |
| `MOSS_OTEL_URL` | `http://localhost:4318/v1/traces` | OTLP HTTP endpoint for span export. Overrides the default; also acts as the session-summary POST target (`<url>/v1/session-summary`). |
| `MOSS_OTEL_SERVICE_NAME` | `moss` | `service.name` resource attribute sent with OTLP spans. |
```

- [ ] **Step 3: 提交**

```bash
cd D:/moss-from-remote
git add docs/env-vars.md
git commit -m "docs: document MOSS_TRACE and MOSS_OTEL_* monitoring env vars"
```

---

### Task 11: 最终验证

**Files:**
- 无（纯验证）

- [ ] **Step 1: 全量类型检查**

Run: `cd D:/moss-from-remote/packages/moss-agent && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

Run: `cd D:/moss-from-remote/packages/moss-analytics-dashboard && npx tsc --noEmit -p tsconfig.json`
Expected: 无错误

- [ ] **Step 2: 全量测试**

Run: `cd D:/moss-from-remote && node scripts/run-package-tests.mjs`
Expected: 全部 PASS（含 observability vitest 套件）

- [ ] **Step 3: 端到端烟测**

Run: `cd D:/moss-from-remote && MOSS_TRACE=file node packages/moss-agent/dist/cli.js chat "test" --max-turns 1 2>&1 | tail -3`
Expected: 会话正常结束

Run: `ls .moss/analytics/`
Expected: `sessions.jsonl` 和 `traces.jsonl` 都在

Run: `node packages/moss-agent/dist/cli.js stats 2>&1 | head -10`
Expected: 打印聚合，含 session span 的 outcome 维度

Run: `node packages/moss-agent/dist/cli.js stats --serve &` 访问 http://localhost:3100
Expected: 看板渲染三区图表，数据与 jsonl 一致

- [ ] **Step 4: 提交收尾**

```bash
cd D:/moss-from-remote
git add -A
git commit -m "chore: final verification — typecheck clean, tests pass, e2e smoke ok"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ 提交未 commit 接线 → Task 1
- ✅ OTLP 批量导出 → Task 3
- ✅ 测试进 CI（解除 gitignore） → Task 9
- ✅ env 文档化 → Task 10
- ✅ local tracer setAttribute 真写入 → Task 2
- ✅ SessionExporter / sessions.jsonl → Task 4
- ✅ session span outcome 写回 → Task 5
- ✅ MOSS_TRACE=file 接电 → Task 6
- ✅ 趋势看板（独立包） → Task 7
- ✅ moss stats 命令 → Task 8
- ✅ 最终验证 → Task 11
- 注：metrics/log 出口占位（spec 第三节"预留接口"）——本 plan 未设独立 Task，因 spec 明确"本次不实现"。在 Task 6 改 cli-main 时若顺手留注释即可，不单列 Task 避免范围蔓延。

**2. Placeholder scan:** 无 TBD/TODO/«implement later»。每个 code step 都有完整代码。Task 6 Step 1 对 `workspace` 变量名有一处"读上下文确认"——这是必要的运行时确认（变量名取决于上游），不是占位。

**3. Type consistency:**
- `SessionSummary` 接口（Task 4 定义）字段名 `outcome`/`turns`/`toolCalls`/`tokensIn`/`tokensOut`/`time` —— Task 5 写回与 exportSession 用同名字段 ✅
- `globalSessionExporter` 单例（Task 4）—— Task 5/6 用同名 ✅
- `flushOtlpBuffer`（Task 3 导出）—— Task 3 测试 import 同名 ✅
- `startDashboardServer({workspaceDir, port})`（Task 7）—— Task 8 调用同签名 ✅
- `runStatsCommand({workspace, serve, port})`（Task 8）—— dispatcher 调用同签名 ✅
- `CliCommand` 加 `'stats'`（Task 8 Step 1）—— dispatcher 用 `stats` key（Task 8 Step 3）✅
- 看板前端 fetch `/api/traces`/`/api/sessions`/`/api/stats`（Task 7 HTML）—— server 路由同三路径（Task 7 server.ts）✅；前端用 `t.attrs.outputTokens` 而 server 返回字段名是 `attrs`（traces 映射里 `attrs: s.attributes`）✅

**4. 已知风险点（实现时留意，非缺陷）：**
- Task 5 的 `summary` 对象当前可能没有 `time` 字段，落盘补 `time: Date.now()`——plan 已写明。
- Task 6 的 `workspace` 变量名需读 cli-main.ts 上下文确认——plan 已标注。
- Task 7 看板 SVG 是手写简版，交互（hover tooltip）未做——spec 第六节已接受此取舍。
- Task 8 `npm install` 后 workspace 链接 `@rdk-moss/analytics-dashboard` 才能被 import——Step 4 已含 install。
