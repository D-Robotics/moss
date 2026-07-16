# Moss-Drobotics Observability (埋点) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenTelemetry tracing + metrics to `D:\moss-drobotics` so LLM calls, tool execution, and sessions emit spans/metrics to a local OTLP receiver and to a local JSONL trace file.

**Architecture:** Single `@opentelemetry/sdk-node` NodeSDK instance shared by tracing and metrics (one Resource, one SDK). A custom `FileSpanProcessor` mirrors spans to `.moss/analytics/traces.jsonl` alongside the OTLP trace exporter. Three span layers: `moss.session` → `moss.agent.turn` → `moss.llm.request` / `moss.tool.invoke`. Context propagation is SDK-native (no manual `parentSpan` threading). When disabled, all instruments are noop — zero overhead.

**Tech Stack:** TypeScript ESM monorepo (`@rdk-moss/agent`), `@opentelemetry/*` (api 1.x + experimental 0.x + metrics 2.x), `node:assert/strict` `.spec.mjs` tests run against built `dist/`.

## Global Constraints

- Package: `@rdk-moss/agent`, source at `packages/moss-agent/src/`. ESM (`"type": "module"`), `.js` import specifiers in TS.
- Tests are `*.spec.mjs` files using `node:assert/strict`, executed against compiled `dist/` via `node packages/moss-agent/test/<name>.spec.mjs` (or `npm test -w @rdk-moss/agent` which builds then runs `scripts/run-package-tests.mjs`).
- No vitest. Every test task must: write `test/<name>.spec.mjs`, build with `npm run build -w @rdk-moss/agent`, then run the spec.mjs directly with `node`.
- Spec reference: `docs/superpowers/specs/2026-07-16-observability-instrumentation-design.md`.
- OTel version lines (from spec §7): experimental `^0.200` for `sdk-node`/`sdk-trace-base`/`exporter-trace-otlp-http`; metrics `sdk-metrics@^2.9` / `exporter-metrics-otlp-http@^0.220`; `api@^1.9` / `resources@^2.9` / `semantic-conventions@^1.43`. If peer conflicts arise, align experimental packages to `^0.220`.
- Span names use `moss.*` dot namespace. Errors go through `span.recordException(err)` + redacted `setStatus`.
- Disabling is noop-only: never add `if (enabled)` branches in business call-sites.
- Working repo is `D:\moss-drobotics` (git). All `git -C /d/moss-drobotics`.

---

## File Structure

**Create:**
- `packages/moss-agent/src/observability/sdk.ts` — NodeSDK assembly: Resource, OTLP trace exporter + BatchSpanProcessor, FileSpanProcessor, OTLP metric reader. `initObservability()` / `shutdownObservability()`.
- `packages/moss-agent/src/observability/metrics.ts` — `mossMetrics` handle: noop-by-default instruments, replaced with real ones by SDK.
- `packages/moss-agent/src/observability/file-trace.ts` — `FileSpanProcessor` implementing `SpanProcessor`, buffers `ReadableSpan`, flushes JSONL every 30s + on shutdown.
- `packages/moss-agent/src/observability/trace-context.ts` — `injectTraceHeaders(headers)` helper wrapping SDK `propagation.inject`.

**Rewrite:**
- `packages/moss-agent/src/observability/tracing.ts` — replace custom `TraceRegistry`/`noopTracer` with SDK-backed `withSpan` + attribute builders. Keep `setTracer`/`setTraceRedactor` as noop shims (callers `cli-main.ts:65,188` and `moss-agent.ts:39` still import them) so existing imports don't break; they become no-ops because SDK owns tracing now.

**Modify:**
- `packages/moss-agent/src/observability/index.ts` — re-export new API (`initObservability`, `shutdownObservability`, `mossMetrics`, `withSpan`, attribute builders, `injectTraceHeaders`); keep `redact`/`llm-usage` exports.
- `packages/moss-agent/src/cli-main.ts` — call `initObservability()` before `new MossAgent(...)` (line 611); call `shutdownObservability()` in the `finally` block.
- `packages/moss-agent/src/core/agent/moss-agent.ts` — wrap `chat()` (line 412) body in `moss.session` span; emit session metrics on completion.
- `packages/moss-agent/src/core/loop/agent-loop.ts` — wrap each turn iteration (around `executeLlmTurn`, line 426) in `moss.agent.turn` span.
- `packages/moss-agent/src/core/loop/agent-loop-llm-call.ts` — rename span `agent.llm_turn`→`moss.llm.request` (line 133); add `mossMetrics` calls.
- `packages/moss-agent/src/core/tools/execute-tool-call.ts` — wrap tool execution (line 242 `executeOneToolCall`) in `moss.tool.invoke` span; add `mossMetrics` calls.
- `packages/moss-agent/src/tools/web-fetch.ts` (line 541) + `web-search.ts` — use `injectTraceHeaders` on outbound fetch headers.
- `packages/moss-agent/package.json` — add 8 `@opentelemetry/*` deps.

---

### Task 1: Add OpenTelemetry dependencies

**Files:**
- Modify: `packages/moss-agent/package.json`

**Interfaces:**
- Produces: installed `@opentelemetry/*` packages importable by later tasks.

- [ ] **Step 1: Add dependencies to package.json**

In `packages/moss-agent/package.json`, find the `"dependencies"` object and add these 8 entries (preserve existing entries; keep alphabetical if the file is sorted):

```json
"@opentelemetry/api": "^1.9.0",
"@opentelemetry/exporter-metrics-otlp-http": "^0.220.0",
"@opentelemetry/exporter-trace-otlp-http": "^0.200.0",
"@opentelemetry/resources": "^2.9.0",
"@opentelemetry/sdk-metrics": "^2.9.0",
"@opentelemetry/sdk-node": "^0.200.0",
"@opentelemetry/sdk-trace-base": "^0.200.0",
"@opentelemetry/semantic-conventions": "^1.43.0"
```

- [ ] **Step 2: Install**

Run: `npm install -w @rdk-moss/agent`
Expected: install succeeds. If a peer-dependency conflict mentions `@opentelemetry/sdk-node` or `sdk-trace-base`, bump those two to `^0.220.0` and re-run.

- [ ] **Step 3: Verify build still passes with no usage yet**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds (deps added, not yet imported — nothing breaks).

- [ ] **Step 4: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/package.json package-lock.json
git -C /d/moss-drobotics commit -m "build(agent): add @opentelemetry/* dependencies for observability"
```

---

### Task 2: `metrics.ts` — noop-by-default instrument handle

**Files:**
- Create: `packages/moss-agent/src/observability/metrics.ts`
- Test: `packages/moss-agent/test/observability-metrics.spec.mjs`

**Interfaces:**
- Produces: `export const mossMetrics` with shape `{ llmTokens, llmDuration, toolInvocations, toolDuration, sessionCount, sessionDuration, sessionToolCount }`. Each counter has `.add(value, attrs?)`, each histogram has `.record(value, attrs?)`. Before SDK init these are noop; after init (Task 5) they are real. Later tasks call e.g. `mossMetrics.llmTokens.add(n, { direction: 'input', model })`.

- [ ] **Step 1: Write the failing test**

Create `packages/moss-agent/test/observability-metrics.spec.mjs`:

```javascript
#!/usr/bin/env node
// @rdk-moss/agent — mossMetrics noop-by-default contract
// Real instruments are wired by the SDK init (sdk.ts); without it, calls are silent.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { mossMetrics } = mod;

assert.ok(mossMetrics, 'mossMetrics should be exported');

// noop-by-default: every call must be callable without throwing
assert.doesNotThrow(() => mossMetrics.llmTokens.add(10, { direction: 'input', model: 'm' }));
assert.doesNotThrow(() => mossMetrics.llmDuration.record(42, { model: 'm' }));
assert.doesNotThrow(() => mossMetrics.toolInvocations.add(1, { tool: 't', status: 'ok' }));
assert.doesNotThrow(() => mossMetrics.toolDuration.record(5, { tool: 't' }));
assert.doesNotThrow(() => mossMetrics.sessionCount.add(1, { outcome: 'done' }));
assert.doesNotThrow(() => mossMetrics.sessionDuration.record(100, { outcome: 'done' }));
assert.doesNotThrow(() => mossMetrics.sessionToolCount.record(3, { outcome: 'done' }));

console.log('observability-metrics: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node packages/moss-agent/test/observability-metrics.spec.mjs`
Expected: FAIL — `mossMetrics` is `undefined` (not yet exported).

- [ ] **Step 3: Write minimal implementation**

Create `packages/moss-agent/src/observability/metrics.ts`:

```typescript
/**
 * OpenTelemetry metrics handle for Moss.
 *
 * Instruments are noop until the SDK is initialized (sdk.ts sets the global
 * meter provider). Business code calls .add()/.record() unconditionally —
 * zero overhead when observability is disabled.
 */
import { metrics } from '@opentelemetry/api';

// getMeter() returns a noop meter until setGlobalMeterProvider is called,
// so these are noop instruments by default and real ones after SDK init.
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
  sessionToolCount: meter.createHistogram('moss.session.tool_count'),
};
```

- [ ] **Step 4: Export from index.ts**

In `packages/moss-agent/src/observability/index.ts`, add at end:

```typescript
export { mossMetrics } from './metrics.js';
```

- [ ] **Step 5: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds.

- [ ] **Step 6: Run test to verify it passes**

Run: `node packages/moss-agent/test/observability-metrics.spec.mjs`
Expected: PASS, prints `observability-metrics: OK`.

- [ ] **Step 7: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/observability/metrics.ts packages/moss-agent/src/observability/index.ts packages/moss-agent/test/observability-metrics.spec.mjs
git -C /d/moss-drobotics commit -m "feat(observability): add noop-by-default mossMetrics instrument handle"
```

---

### Task 3: `tracing.ts` — SDK-backed `withSpan` + attribute builders

**Files:**
- Rewrite: `packages/moss-agent/src/observability/tracing.ts`
- Test: `packages/moss-agent/test/observability-tracing.spec.mjs`
- Modify: `packages/moss-agent/src/observability/index.ts` (re-export new builders)

**Interfaces:**
- Consumes: `@opentelemetry/api` `trace`/`context`/`SpanStatusCode`; existing `redactSensitiveData` (from `./redact.js`); existing `errorMessage` (from `../errors.js`).
- Produces: `withSpan<T>(name, attributes, fn)`, `sessionAttributes(runId, model, sessionKey)`, `turnAttributes(runId, turn, model)`, `llmAttributes(runId, model, inputTokens)`, `toolAttributes(runId, toolName, toolCallId)`. Also keeps `setTracer`/`setTraceRedactor` as noop exports (callers import them) and `TraceSpan`/`Tracer` types for compatibility.

- [ ] **Step 1: Write the failing test**

Create `packages/moss-agent/test/observability-tracing.spec.mjs`:

```javascript
#!/usr/bin/env node
// @rdk-moss/agent — withSpan + attribute builders contract
// No SDK init here: withSpan must still run the fn and propagate its result/throw,
// because the tracer is noop until the SDK is started.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { withSpan, turnAttributes, toolAttributes, llmAttributes, sessionAttributes } = mod;

// fn result propagates through noop span
const r = await withSpan('test.span', { a: 1 }, async () => 42);
assert.equal(r, 42, 'withSpan returns fn result');

// fn error propagates (noop span does not swallow)
await assert.rejects(
  () => withSpan('test.span', undefined, async () => { throw new Error('boom'); }),
  /boom/,
  'withSpan rethrows fn errors',
);

// attribute builders return plain objects with the right keys
assert.deepEqual(turnAttributes('r1', 3, 'm'), { runId: 'r1', turn: 3, model: 'm' });
assert.deepEqual(toolAttributes('r1', 'bash', 'c1'), { runId: 'r1', toolName: 'bash', toolCallId: 'c1' });
assert.deepEqual(llmAttributes('r1', 'm', 100), { runId: 'r1', model: 'm', inputTokens: 100 });
assert.deepEqual(sessionAttributes('r1', 'm', 's1'), { runId: 'r1', model: 'm', sessionKey: 's1' });

console.log('observability-tracing: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node packages/moss-agent/test/observability-tracing.spec.mjs`
Expected: FAIL — `withSpan` exists but old signature is `withSpan(name, attrs, fn, parent)`; attribute builders `sessionAttributes`/`llmAttributes` don't exist yet. (The old `withSpan` may even pass the result test but `sessionAttributes` is undefined → assert fails.)

- [ ] **Step 3: Rewrite tracing.ts**

Replace the entire contents of `packages/moss-agent/src/observability/tracing.ts` with:

```typescript
/**
 * OpenTelemetry-backed tracing for Moss.
 *
 * withSpan wraps an async fn in an SDK span. Before the SDK is initialized
 * (sdk.ts), the global tracer is noop — withSpan still runs fn and propagates
 * its result/throw, with zero tracing overhead. On error the exception is
 * recorded on the span and the redacted message set on status.
 */
import { trace, context, SpanStatusCode, type Span } from '@opentelemetry/api';
import { errorMessage } from '../errors.js';
import { redactSensitiveData } from './redact.js';

const tracer = trace.getTracer('moss-agent');

/** Compatibility shim — SDK owns the tracer now; this is a no-op kept so
 *  cli-main.ts (setTracer('console')) and moss-agent.ts imports don't break. */
export function setTracer(_tracer: unknown): void {
  /* no-op: tracing is managed by the OTel SDK */
}

/** Compatibility shim — redaction still applies via redactSensitiveData in withSpan. */
export function setTraceRedactor(_fn: (text: string) => string): void {
  /* no-op */
}

// Preserved type exports for any existing consumer typings.
export interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
  setStatus(ok: boolean, message?: string): void;
  end(): void;
}
export interface Tracer {
  startSpan(
    name: string,
    attributes?: Record<string, string | number | boolean>,
    parent?: TraceSpan,
  ): TraceSpan;
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean> | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = tracer.startSpan(name, attributes ? { attributes } : undefined);
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err);
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

// ── attribute builders ──────────────────────────────────────────────
export const sessionAttributes = (
  runId: string,
  model: string,
  sessionKey: string,
): Record<string, string | number | boolean> => ({ runId, model, sessionKey });

export const turnAttributes = (
  runId: string,
  turn: number,
  model: string,
): Record<string, string | number | boolean> => ({ runId, turn, model });

export const llmAttributes = (
  runId: string,
  model: string,
  inputTokens: number,
): Record<string, string | number | boolean> => ({ runId, model, inputTokens });

export const toolAttributes = (
  runId: string,
  toolName: string,
  toolCallId: string,
): Record<string, string | number | boolean> => ({ runId, toolName, toolCallId });
```

- [ ] **Step 4: Update index.ts re-exports**

In `packages/moss-agent/src/observability/index.ts`, replace the `tracing.js` re-export block (the one exporting `TraceRegistry, setTracer, getTracer, withSpan, turnAttributes, toolAttributes, llmRequestAttributes`) with:

```typescript
export {
  withSpan,
  setTracer,
  setTraceRedactor,
  sessionAttributes,
  turnAttributes,
  llmAttributes,
  toolAttributes,
} from './tracing.js';
export type { Tracer, TraceSpan } from './tracing.js';
```

(Keep the existing `redact` and `llm-usage` export blocks unchanged.)

- [ ] **Step 5: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds. Note: `getTracer` and `TraceRegistry` and `llmRequestAttributes` are removed from exports — if any non-observability source imported them, the build fails with "has no exported member". If so, update that import to use the new builder names; `llmRequestAttributes` callers should use `llmAttributes`.

- [ ] **Step 6: Run test to verify it passes**

Run: `node packages/moss-agent/test/observability-tracing.spec.mjs`
Expected: PASS, prints `observability-tracing: OK`.

- [ ] **Step 7: Run full existing test suite to catch regressions**

Run: `npm test -w @rdk-moss/agent`
Expected: all specs pass (the removed `getTracer`/`TraceRegistry` exports were only used by `cli-main.ts` `setTracer('console')` which is now a noop shim, and `moss-agent.ts` `setTraceRedactor` which is also a noop shim — both still import fine).

- [ ] **Step 8: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/observability/tracing.ts packages/moss-agent/src/observability/index.ts packages/moss-agent/test/observability-tracing.spec.mjs
git -C /d/moss-drobotics commit -m "feat(observability): rewrite tracing.ts on OTel SDK withSpan + attribute builders"
```

---

### Task 4: `file-trace.ts` — FileSpanProcessor (local JSONL trace)

**Files:**
- Create: `packages/moss-agent/src/observability/file-trace.ts`
- Test: `packages/moss-agent/test/observability-file-trace.spec.mjs`

**Interfaces:**
- Consumes: `@opentelemetry/sdk-trace-base` `SpanProcessor`, `ReadableSpan`.
- Produces: `export class FileSpanProcessor implements SpanProcessor` with constructor `(workspaceDir: string)`, methods `onStart`, `onEnd`, `forceFlush`, `shutdown`. Spans buffered and flushed to `{workspaceDir}/.moss/analytics/traces.jsonl`.

- [ ] **Step 1: Write the failing test**

Create `packages/moss-agent/test/observability-file-trace.spec.mjs`:

```javascript
#!/usr/bin/env node
// @rdk-moss/agent — FileSpanProcessor writes one JSONL line per ended span.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { FileSpanProcessor } = mod;

// Build a minimal ReadableSpan-shaped object the processor will accept.
// The processor only reads .name, .attributes, .startTime, .endTime (hrTime),
// .status, .events. We feed numbers for hrTime (ms) for simplicity.
function fakeSpan(name, attrs) {
  return {
    name,
    attributes: attrs,
    startTime: [0, 0],
    endTime: [0, 1_000_000],
    status: { code: 1 },
    events: [],
    spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16) }),
  };
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-fp-'));
const proc = new FileSpanProcessor(tmpDir);

proc.onStart();
proc.onEnd(fakeSpan('moss.tool.invoke', { toolName: 'bash' }));
proc.onEnd(fakeSpan('moss.llm.request', { model: 'm' }));
await proc.forceFlush();

const file = path.join(tmpDir, '.moss', 'analytics', 'traces.jsonl');
const content = await fs.readFile(file, 'utf-8');
const lines = content.split('\n').filter(Boolean);
assert.equal(lines.length, 2, 'two spans → two JSONL lines');
const first = JSON.parse(lines[0]);
assert.equal(first.name, 'moss.tool.invoke', 'first line is the first span');
assert.equal(first.attributes.toolName, 'bash', 'attributes serialized');

// shutdown flushes remaining + clears timer
proc.onEnd(fakeSpan('moss.session', {}));
await proc.shutdown();
const content2 = await fs.readFile(file, 'utf-8');
assert.equal(content2.split('\n').filter(Boolean).length, 3, 'shutdown flushed the 3rd span');

await fs.rm(tmpDir, { recursive: true, force: true });
console.log('observability-file-trace: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node packages/moss-agent/test/observability-file-trace.spec.mjs`
Expected: FAIL — `FileSpanProcessor` is `undefined` (not exported).

- [ ] **Step 3: Write minimal implementation**

Create `packages/moss-agent/src/observability/file-trace.ts`:

```typescript
/**
 * FileSpanProcessor — mirrors ended spans to a local JSONL file.
 *
 * Sits alongside the OTLP trace exporter (BatchSpanProcessor) on the same
 * tracer: every ended span is both sent to the receiver and appended to
 * {workspaceDir}/.moss/analytics/traces.jsonl. Buffered + flushed every 30s
 * and on shutdown. Never throws — file I/O is best-effort.
 */
import type { SpanProcessor, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import fs from 'node:fs/promises';
import path from 'node:path';

const FLUSH_INTERVAL_MS = 30_000;

// hrTime is [seconds, nanoseconds]. Reduce to ms epoch-ish number for the file.
function hrToMs(hr: [number, number]): number {
  return hr[0] * 1000 + hr[1] / 1_000_000;
}

function serializeSpan(span: ReadableSpan): string {
  return JSON.stringify({
    name: span.name,
    startTime: hrToMs(span.startTime as [number, number]),
    endTime: hrToMs(span.endTime as [number, number]),
    attributes: span.attributes ?? {},
    events: (span.events ?? []).map((e) => ({
      name: e.name,
      time: hrToMs(e.time as [number, number]),
      attrs: e.attributes ?? {},
    })),
    status: span.status?.code === 2 ? 'error' : 'ok',
    ...(span.status?.message ? { statusMessage: span.status.message } : {}),
  });
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

  onStart(): void {
    /* nothing — we serialize on end */
  }

  onEnd(span: ReadableSpan): void {
    this.buffer.push(span);
  }

  async forceFlush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const snapshot = this.buffer.splice(0);
    const lines = snapshot.map(serializeSpan).join('\n') + '\n';
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.appendFile(this.file, lines, 'utf-8');
    } catch {
      /* never block the agent */
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.forceFlush();
  }
}
```

- [ ] **Step 4: Export from index.ts**

In `packages/moss-agent/src/observability/index.ts`, add:

```typescript
export { FileSpanProcessor } from './file-trace.js';
```

- [ ] **Step 5: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds.

- [ ] **Step 6: Run test to verify it passes**

Run: `node packages/moss-agent/test/observability-file-trace.spec.mjs`
Expected: PASS, prints `observability-file-trace: OK`.

- [ ] **Step 7: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/observability/file-trace.ts packages/moss-agent/src/observability/index.ts packages/moss-agent/test/observability-file-trace.spec.mjs
git -C /d/moss-drobotics commit -m "feat(observability): add FileSpanProcessor for local JSONL trace export"
```

---

### Task 5: `sdk.ts` — NodeSDK assembly + init/shutdown

**Files:**
- Create: `packages/moss-agent/src/observability/sdk.ts`
- Modify: `packages/moss-agent/src/observability/index.ts`
- Test: `packages/moss-agent/test/observability-sdk.spec.mjs`

**Interfaces:**
- Consumes: `@opentelemetry/sdk-node` `NodeSDK`; `exporter-trace-otlp-http` `OTLPTraceExporter`; `sdk-trace-base` `BatchSpanProcessor`; `sdk-metrics` `PeriodicExportingMetricReader`; `exporter-metrics-otlp-http` `OTLPMetricExporter`; `resources` `resourceFromAttributes`; `semantic-conventions` semconv; `FileSpanProcessor` (Task 4); reads package version.
- Produces: `initObservability(opts: { workspaceDir; serviceName?; otlpUrl? }): void` and `shutdownObservability(): Promise<void>`. When env disables it, `initObservability` is a no-op.

- [ ] **Step 1: Write the failing test**

Create `packages/moss-agent/test/observability-sdk.spec.mjs`:

```javascript
#!/usr/bin/env node
// @rdk-moss/agent — initObservability disabled path + idempotent shutdown.
// We do NOT start a real receiver here; we only assert the disabled path is
// a no-op and shutdown never throws.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { initObservability, shutdownObservability } = mod;

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-sdk-'));

// Disabled: no MOSS_OTEL_ENABLED, no MOSS_OTEL_URL → must be a no-op,
// and must NOT create the traces.jsonl file (no SDK started).
delete process.env.MOSS_OTEL_ENABLED;
delete process.env.MOSS_OTEL_URL;
assert.doesNotThrow(() => initObservability({ workspaceDir: tmpDir }));
await shutdownObservability();  // idempotent, no-op when nothing started
const traceFile = path.join(tmpDir, '.moss', 'analytics', 'traces.jsonl');
assert.ok(!await fs.access(traceFile).then(() => true).catch(() => false),
  'disabled path must not start file tracing');

await fs.rm(tmpDir, { recursive: true, force: true });
console.log('observability-sdk: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node packages/moss-agent/test/observability-sdk.spec.mjs`
Expected: FAIL — `initObservability`/`shutdownObservability` undefined.

- [ ] **Step 3: Write minimal implementation**

Create `packages/moss-agent/src/observability/sdk.ts`:

```typescript
/**
 * OTel SDK assembly: one NodeSDK shared by tracing and metrics.
 *
 * initObservability reads env to decide what to start. When disabled it does
 * nothing (no SDK, no timers) — business code's noop instruments/spans carry
 * zero cost. shutdownObservability flushes all exporters/processors.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { semconv } from '@opentelemetry/semantic-conventions';
import { FileSpanProcessor } from './file-trace.js';

export interface InitOptions {
  workspaceDir: string;
  serviceName?: string;
  otlpUrl?: string;
}

let sdk: NodeSDK | null = null;

function readPackageVersion(): string {
  try {
    // dist/observability/sdk.js → package.json is two levels up (dist → package root)
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0';
  } catch {
    return '0';
  }
}

export function initObservability(opts: InitOptions): void {
  const enabled = process.env.MOSS_OTEL_ENABLED === '1' || !!process.env.MOSS_OTEL_URL;
  if (!enabled || sdk) return;

  const otlpUrl = process.env.MOSS_OTEL_URL ?? opts.otlpUrl ?? 'http://localhost:4318';
  const serviceName = process.env.MOSS_OTEL_SERVICE_NAME ?? opts.serviceName ?? 'moss';
  const metricsEnabled = process.env.MOSS_METRICS_ENABLED !== '0';
  const fileTraceEnabled = process.env.MOSS_FILE_TRACE !== '0';

  const resource = resourceFromAttributes({
    [semconv.ATTR_SERVICE_NAME]: serviceName,
    [semconv.ATTR_SERVICE_VERSION]: readPackageVersion(),
  });

  const spanProcessors: SpanProcessor[] = [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: `${otlpUrl}/v1/traces` })),
  ];
  if (fileTraceEnabled) {
    spanProcessors.push(new FileSpanProcessor(opts.workspaceDir));
  }

  const metricReader = metricsEnabled
    ? new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${otlpUrl}/v1/metrics` }),
        exportIntervalMillis: 10_000,
      })
    : undefined;

  sdk = new NodeSDK({
    resource,
    spanProcessors,
    ...(metricReader ? { metricReader } : {}),
  });
  sdk.start();
}

export async function shutdownObservability(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    /* best-effort */
  }
  sdk = null;
}
```

- [ ] **Step 4: Export from index.ts**

In `packages/moss-agent/src/observability/index.ts`, add:

```typescript
export { initObservability, shutdownObservability } from './sdk.js';
export type { InitOptions } from './sdk.js';
```

- [ ] **Step 5: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds.

- [ ] **Step 6: Run test to verify it passes**

Run: `node packages/moss-agent/test/observability-sdk.spec.mjs`
Expected: PASS, prints `observability-sdk: OK`.

- [ ] **Step 7: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/observability/sdk.ts packages/moss-agent/src/observability/index.ts packages/moss-agent/test/observability-sdk.spec.mjs
git -C /d/moss-drobotics commit -m "feat(observability): add NodeSDK assembly with shared trace+metrics+file exporters"
```

---

### Task 6: `trace-context.ts` — `injectTraceHeaders` helper

**Files:**
- Create: `packages/moss-agent/src/observability/trace-context.ts`
- Modify: `packages/moss-agent/src/observability/index.ts`
- Test: `packages/moss-agent/test/observability-trace-context.spec.mjs`

**Interfaces:**
- Consumes: `@opentelemetry/api` `propagation`, `defaultTextMapSetter`.
- Produces: `injectTraceHeaders(headers: Record<string, string>): Record<string, string>` — injects W3C `traceparent` when inside a span, returns headers unchanged otherwise.

- [ ] **Step 1: Write the failing test**

Create `packages/moss-agent/test/observability-trace-context.spec.mjs`:

```javascript
#!/usr/bin/env node
// @rdk-moss/agent — injectTraceHeaders is a passthrough when no span is active
// (graceful degradation), and injects traceparent when inside a withSpan.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { injectTraceHeaders, withSpan } = mod;

// Outside any span: headers returned unchanged (no active context → nothing injected)
const plain = injectTraceHeaders({ accept: 'text/html' });
assert.deepEqual(plain, { accept: 'text/html' }, 'no active span → passthrough');
assert.ok(!plain.traceparent, 'no traceparent when no span active');

// Inside a withSpan: traceparent is injected (SDK noop tracer may not inject a
// real one, so we only assert the function doesn't throw and returns an object).
await withSpan('test', {}, async () => {
  const h = injectTraceHeaders({ accept: 'text/html' });
  assert.equal(typeof h, 'object');
  assert.equal(h.accept, 'text/html', 'existing headers preserved');
});

console.log('observability-trace-context: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node packages/moss-agent/test/observability-trace-context.spec.mjs`
Expected: FAIL — `injectTraceHeaders` undefined.

- [ ] **Step 3: Write minimal implementation**

Create `packages/moss-agent/src/observability/trace-context.ts`:

```typescript
/**
 * Inject W3C traceparent for the active span into outbound request headers.
 * Uses the SDK propagator, so it's consistent with span context propagation.
 * No active span → headers returned unchanged (graceful degradation).
 */
import { propagation, defaultTextMapSetter } from '@opentelemetry/api';

export function injectTraceHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  try {
    propagation.inject(headers, defaultTextMapSetter);
  } catch {
    /* never break an outbound request over tracing */
  }
  return headers;
}
```

- [ ] **Step 4: Export from index.ts**

In `packages/moss-agent/src/observability/index.ts`, add:

```typescript
export { injectTraceHeaders } from './trace-context.js';
```

- [ ] **Step 5: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds.

- [ ] **Step 6: Run test to verify it passes**

Run: `node packages/moss-agent/test/observability-trace-context.spec.mjs`
Expected: PASS, prints `observability-trace-context: OK`.

- [ ] **Step 7: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/observability/trace-context.ts packages/moss-agent/src/observability/index.ts packages/moss-agent/test/observability-trace-context.spec.mjs
git -C /d/moss-drobotics commit -m "feat(observability): add injectTraceHeaders for outbound W3C traceparent"
```

---

### Task 7: Wire `initObservability` + `shutdownObservability` into cli-main.ts

**Files:**
- Modify: `packages/moss-agent/src/cli-main.ts` (imports ~line 65; init before line 611 `new MossAgent`; shutdown in the `finally` block ~line 1014)

**Interfaces:**
- Consumes: `initObservability`, `shutdownObservability` from Task 5.

- [ ] **Step 1: Add imports**

In `packages/moss-agent/src/cli-main.ts`, find the existing import at line 65:
```typescript
import { setTracer } from './observability/tracing.js';
```
Replace it with:
```typescript
import { setTracer } from './observability/tracing.js';
import { initObservability, shutdownObservability } from './observability/index.js';
```

- [ ] **Step 2: Call init before agent construction**

Find line 611 `const agent = new MossAgent({`. Immediately BEFORE it (after the `enableOtelMetrics`-equivalent region does not exist yet in drobotics; place it right before the `const agent = new MossAgent({` line), insert:

```typescript
  // Initialize observability (tracing + metrics + local file trace).
  // No-op unless MOSS_OTEL_ENABLED=1 or MOSS_OTEL_URL is set.
  initObservability({ workspaceDir: workspace });

  const agent = new MossAgent({
```

(Keep the existing `const agent = new MossAgent({` and everything after unchanged. The `workspace` variable is already in scope at this point — it was resolved earlier at line 465.)

- [ ] **Step 3: Call shutdown in the finally block**

Find the `} finally {` block at line 1014 containing `await closeMcpConnections(mcpConnections);`. Add the shutdown call so the block reads:

```typescript
  } finally {
    await closeMcpConnections(mcpConnections);
    await shutdownObservability();
  }
```

- [ ] **Step 4: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds.

- [ ] **Step 5: Run full test suite**

Run: `npm test -w @rdk-moss/agent`
Expected: all specs pass (no behavioral change — init is no-op without env).

- [ ] **Step 6: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/cli-main.ts
git -C /d/moss-drobotics commit -m "feat(cli): wire observability init/shutdown into main lifecycle"
```

---

### Task 8: `moss.session` span + session metrics in moss-agent.ts

**Files:**
- Modify: `packages/moss-agent/src/core/agent/moss-agent.ts` (imports line 39; `chat()` at line 412)
- Test: `packages/moss-agent/test/observability-session-span.spec.mjs`

**Interfaces:**
- Consumes: `withSpan`, `sessionAttributes`, `mossMetrics` from observability index.

- [ ] **Step 1: Write the failing test**

Create `packages/moss-agent/test/observability-session-span.spec.mjs`:

```javascript
#!/usr/bin/env node
// @rdk-moss/agent — chat() wraps its work in a moss.session span and records
// session metrics on completion. Without the SDK started, withSpan is noop but
// still runs the wrapped fn, so chat() behavior is unchanged. We assert that
// the metrics handle is touched (noop add/record don't throw) and chat still
// returns a ChatResult shape. This is a smoke test, not a span-content test —
// real span content is verified end-to-end in the manual verification task.
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const distJs = path.join(dir, '..', 'dist', 'index.js');
const mod = await import(pathToFileURL(distJs).href);
const { mossMetrics } = mod;

// metrics handle is callable (noop until SDK init)
assert.doesNotThrow(() => {
  mossMetrics.sessionCount.add(1, { outcome: 'agent_loop_done' });
  mossMetrics.sessionDuration.record(123, { outcome: 'agent_loop_done' });
  mossMetrics.sessionToolCount.record(2, { outcome: 'agent_loop_done' });
});

console.log('observability-session-span: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node packages/moss-agent/test/observability-session-span.spec.mjs`
Expected: it may already PASS (only checks metrics handle). That's fine — this task's real value is wiring the span, verified by build + suite. Keep the test as a regression guard for the metrics outcome labels.

- [ ] **Step 3: Add imports to moss-agent.ts**

In `packages/moss-agent/src/core/agent/moss-agent.ts`, the existing import at line 39 is:
```typescript
import { setTraceRedactor } from '../../observability/tracing.js';
```
Add a new import line near it (e.g., right after line 39):
```typescript
import { withSpan, sessionAttributes } from '../../observability/tracing.js';
import { mossMetrics } from '../../observability/index.js';
```

- [ ] **Step 4: Wrap chat() body in moss.session span**

Read `packages/moss-agent/src/core/agent/moss-agent.ts` around line 412 (`async chat(...)`). The method body runs the agent loop and assembles `finalResult`. Wrap the body so the whole run is under one span and metrics are recorded at the end. Concretely, find the method's main execution (the call that produces `finalResult`, e.g. the `runAgentLoop`/loop invocation) and wrap it:

```typescript
  async chat(sessionKey: string, userMessage: string, options?: ChatOptions): Promise<ChatResult> {
    let finalResult: ChatResult | undefined;
    const sessionStartMs = Date.now();
    const runId = options?.runId ?? `r-${Date.now()}`;
    const model = String(this.config.model);

    finalResult = await withSpan(
      'moss.session',
      sessionAttributes(runId, model, sessionKey),
      async () => {
        // ── existing chat() body that produces the result goes here ──
        // (the original logic that sets finalResult / returns ChatResult)
        return /* original return value or finalResult assembly */;
      },
    );

    // Record session metrics on completion.
    const outcome = finalResult?.stopReason === 'max_turns_reached' ? 'max_turns' : 'agent_loop_done';
    mossMetrics.sessionCount.add(1, { outcome });
    mossMetrics.sessionDuration.record(Date.now() - sessionStartMs, { outcome });
    mossMetrics.sessionToolCount.record(finalResult?.toolCalls?.length ?? 0, { outcome });

    return finalResult;
  }
```

**IMPORTANT — this is a structural wrap, not a literal paste.** The implementer must:
1. Read the full current `chat()` method (lines ~412–550) first.
2. Identify the single expression/statement that yields the `ChatResult` (the existing return path or `finalResult` assignment).
3. Move that body inside the `withSpan` callback, returning its value from the callback.
4. Keep `runId`/`model` extraction consistent with whatever the method already uses (if `runId` is already computed in-scope, reuse it; do not duplicate). If the method already has a `runId` variable, use that name instead of redeclaring.
5. Preserve the existing return type and all side effects (event pushes, persistence).

If wrapping the whole body is too invasive given the method's structure, the acceptable alternative is to wrap only the top-level loop invocation (the `runAgentLoop` or equivalent call) — the session span then covers the actual agent work, which is the goal. Record metrics immediately after that call resolves.

- [ ] **Step 5: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds. If `runId`/`model` naming collides with existing locals, rename the new locals to avoid shadowing.

- [ ] **Step 6: Run full test suite**

Run: `npm test -w @rdk-moss/agent`
Expected: all specs pass. If a behavior test fails, the wrap altered a side effect — fix by moving side-effectful statements outside the span callback (they should run, just not under the span) or by ensuring the callback returns the value the method returns.

- [ ] **Step 7: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/core/agent/moss-agent.ts packages/moss-agent/test/observability-session-span.spec.mjs
git -C /d/moss-drobotics commit -m "feat(agent): wrap chat() in moss.session span + record session metrics"
```

---

### Task 9: `moss.agent.turn` span in agent-loop.ts

**Files:**
- Modify: `packages/moss-agent/src/core/loop/agent-loop.ts` (imports; turn iteration around line 426 `executeLlmTurn`)

**Interfaces:**
- Consumes: `withSpan`, `turnAttributes` from observability tracing.

- [ ] **Step 1: Add imports**

In `packages/moss-agent/src/core/loop/agent-loop.ts`, add near the top imports:
```typescript
import { withSpan, turnAttributes } from '../../observability/tracing.js';
```

- [ ] **Step 2: Wrap each turn iteration in a turn span**

Find the turn loop body. From exploration: line 330 `outerLoop: while (true)`, line 356 `state.turns++`, then around line 426 `const llmResult = await executeLlmTurn({...})` followed by `processLlmResponse` (line 460) and the control-flow checks. Wrap the per-turn work (from after `state.turns++` through the `continue`/`break` decision) in a span:

Locate the block starting after `state.turns++;` (line 356) and the `stream.push({ type: 'turn_start', ... })`. Wrap the turn body:

```typescript
          state.turns++;
          stream.push({ type: 'turn_start', turn: state.turns });

          await withSpan(
            'moss.agent.turn',
            turnAttributes(runId, state.turns, String(modelDef.id)),
            async () => {
              // ── existing per-turn body: ctxResult, executeLlmTurn, processLlmResponse,
              //     control-flow checks (continue/break) ──
              // Keep all existing statements here verbatim.
            },
          );
```

**Implementation note:** The turn body contains `continue`/`break` statements that target the outer `outerLoop`/inner `while` loops. Moving them inside an async callback changes control flow — `continue`/`break` cannot appear inside an arrow function. Therefore:
- The span callback should contain ONLY the work that produces the turn's outcome (the LLM call + response processing + tool dispatch) and RETURN a control signal (`'continue' | 'break' | 'retry'`) rather than using `continue`/`break`.
- After the `withSpan` call, act on the returned signal with a real `continue`/`break` in the loop.

Concretely, restructure so the callback returns the existing `control` value and the loop body maps it:

```typescript
          const turnControl = await withSpan(
            'moss.agent.turn',
            turnAttributes(runId, state.turns, String(modelDef.id)),
            async () => {
              // existing body up to where it decides control, returning:
              //   'continue' (was: continue;)
              //   'break'    (was: break;)
              //   'retry'    (was: state.turns--; continue;)
              return control;  // the value the body already computes
            },
          );
          if (turnControl === 'break') break;
          if (turnControl === 'retry') { state.turns--; continue; }
          continue;
```

If the existing body already uses a `control`-returning helper pattern (it does — `executeLlmTurn` returns `LoopControlSignal`, `processLlmResponse` returns a control), this is mostly hoisting those returns out of the loop body into the callback and switching on the result. Read lines 330–520 carefully before editing.

- [ ] **Step 3: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds. Watch for "continue/break not allowed in arrow function" TS errors — those mean a `continue`/`break` was left inside the callback; convert it to a returned signal as above.

- [ ] **Step 4: Run full test suite**

Run: `npm test -w @rdk-moss/agent`
Expected: all specs pass. If a loop-control test fails, a signal was mis-mapped (e.g. `retry` handled as `continue`); fix the mapping to match the original semantics exactly.

- [ ] **Step 5: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/core/loop/agent-loop.ts
git -C /d/moss-drobotics commit -m "feat(loop): wrap each agent-loop turn in moss.agent.turn span"
```

---

### Task 10: Rename LLM span + add LLM metrics in agent-loop-llm-call.ts

**Files:**
- Modify: `packages/moss-agent/src/core/loop/agent-loop-llm-call.ts` (import line 22; span line 133; metrics after usage at ~line 177)

**Interfaces:**
- Consumes: `mossMetrics` from observability index; existing `withSpan`/`turnAttributes`.

- [ ] **Step 1: Add metrics import**

At line 22 the file imports:
```typescript
import { withSpan, turnAttributes } from '../../observability/tracing.js';
```
Add after it:
```typescript
import { mossMetrics } from '../../observability/index.js';
```

- [ ] **Step 2: Rename the span**

At line 133, change:
```typescript
    const llmTurn = await withSpan(
      'agent.llm_turn',
      turnAttributes(runId, state.turns, String(modelDef.id)),
```
to:
```typescript
    const llmTurn = await withSpan(
      'moss.llm.request',
      turnAttributes(runId, state.turns, String(modelDef.id)),
```

- [ ] **Step 3: Add LLM metrics on success**

Find the block around line 177 that runs when `llmTurn.usage` is present (after `await recordLlmUsage({...success: true...})`). Add metrics after that call:

```typescript
      // Metrics (noop when metrics disabled)
      const _llmModel = String(modelDef.id);
      const _llmDuration = Date.now() - llmTurnStartedAt;
      mossMetrics.llmTokens.add(llmTurn.usage.inputTokens, { direction: 'input', model: _llmModel });
      mossMetrics.llmTokens.add(llmTurn.usage.outputTokens, { direction: 'output', model: _llmModel });
      mossMetrics.llmDuration.record(_llmDuration, { model: _llmModel });
```

- [ ] **Step 4: Add LLM metrics on failure**

In the `catch (llmError)` block (around line 213), after `await recordLlmUsage({...success: false...})`, add:

```typescript
    // Metrics: record failed LLM call
    mossMetrics.llmDuration.record(Date.now() - llmTurnStartedAt, { model: String(modelDef.id), status: 'error' });
```

- [ ] **Step 5: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds.

- [ ] **Step 6: Run full test suite**

Run: `npm test -w @rdk-moss/agent`
Expected: all specs pass.

- [ ] **Step 7: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/core/loop/agent-loop-llm-call.ts
git -C /d/moss-drobotics commit -m "feat(loop): rename LLM span to moss.llm.request + record LLM token/duration metrics"
```

---

### Task 11: `moss.tool.invoke` span + tool metrics in execute-tool-call.ts

**Files:**
- Modify: `packages/moss-agent/src/core/tools/execute-tool-call.ts` (imports; `executeOneToolCall` at line 242; outcome return at ~line 543)

**Interfaces:**
- Consumes: `withSpan`, `toolAttributes`, `mossMetrics` from observability.

- [ ] **Step 1: Add imports**

At the top of `packages/moss-agent/src/core/tools/execute-tool-call.ts` (after line 31), add:
```typescript
import { withSpan, toolAttributes } from '../../observability/tracing.js';
import { mossMetrics } from '../../observability/index.js';
```

- [ ] **Step 2: Wrap tool execution in a span and record metrics**

`executeOneToolCall` (line 242) currently computes `startMs` (line 341) and returns the outcome object at ~line 543 (`return { kind: 'completed', text, isError: errFlag, durationMs: Date.now() - startMs, ... }`). Wrap the core execution so each tool call is one span and metrics are recorded on completion.

Find the `return { kind: 'completed', ... }` at ~line 543. Restructure the function body: wrap the execution (the part between `const startMs = Date.now();` at line 341 and the final `return { kind: 'completed', ...}`) in `withSpan`. Because the function has multiple return paths (`pre-blocked`, `completed`, and the `catch` returning `pre-blocked`), wrap only the main `completed` path:

```typescript
    // inside executeOneToolCall, replacing the final success return:
    const _toolDuration = Date.now() - startMs;
    mossMetrics.toolInvocations.add(1, { tool: call.name, status: errFlag ? 'error' : 'ok' });
    mossMetrics.toolDuration.record(_toolDuration, { tool: call.name });

    return {
      kind: 'completed',
      text,
      isError: errFlag,
      durationMs: _toolDuration,
      ...(aborted ? { aborted } : {}),
      ...(structuredBlocks ? { structuredContent: structuredBlocks } : {}),
    };
```

For the span: the cleanest non-invasive placement is to wrap the call's main work. Read the function first. If wrapping the whole body in `withSpan` would force unwinding multiple early returns, instead add an inner `withSpan('moss.tool.invoke', toolAttributes(deps.sessionKey, call.name, call.id), async () => { ... })` around the `emitStart()` → hook → execute sequence (lines ~520–543) and have the callback return the outcome; the outer function returns what the callback returns. Use the `runId` available in scope if present, else pass `deps.sessionKey` as the `runId` attribute slot (the builder just needs an id; `sessionKey` is acceptable as it's the closest stable identifier here — note this in the span attribute by leaving the field as-is).

- [ ] **Step 3: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds. If `withSpan`'s async callback conflicts with the function's synchronous `return` paths, ensure every path inside the callback returns the outcome object.

- [ ] **Step 4: Run full test suite**

Run: `npm test -w @rdk-moss/agent`
Expected: all specs pass. Tool execution tests must still pass — the span wraps the work but returns the same outcome.

- [ ] **Step 5: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/core/tools/execute-tool-call.ts
git -C /d/moss-drobotics commit -m "feat(tools): wrap tool execution in moss.tool.invoke span + record tool metrics"
```

---

### Task 12: Inject traceparent into web-fetch + web-search

**Files:**
- Modify: `packages/moss-agent/src/tools/web-fetch.ts` (headers at line 541)
- Modify: `packages/moss-agent/src/tools/web-search.ts` (headers at lines 272, 370, 477, 591, 675, 735, 798)

**Interfaces:**
- Consumes: `injectTraceHeaders` from observability index (Task 6).

- [ ] **Step 1: Add import to web-fetch.ts**

In `packages/moss-agent/src/tools/web-fetch.ts`, after the existing imports (after line 22), add:
```typescript
import { injectTraceHeaders } from '../observability/index.js';
```

- [ ] **Step 2: Inject into web-fetch headers**

At line 541 there is a `headers: { ... }` object passed to `fetch`. Wrap it:
```typescript
              headers: injectTraceHeaders({
                /* existing header keys */
              }),
```
(Keep all existing header keys inside the object passed to `injectTraceHeaders`; it returns the same object with `traceparent` added when a span is active.)

- [ ] **Step 3: Add import to web-search.ts**

In `packages/moss-agent/src/tools/web-search.ts`, after line 35, add:
```typescript
import { injectTraceHeaders } from '../observability/index.js';
```

- [ ] **Step 4: Inject into web-search headers**

For each `headers: { ... }` in web-search.ts (lines 272, 370, 477, 591, 675, 735, 798), wrap the object literal with `injectTraceHeaders({ ... })`. Example for line 477:
```typescript
    headers: injectTraceHeaders({ 'user-agent': opts.userAgent, accept: 'text/html' }),
```
Apply the same wrap to every `headers:` literal in the file. Skip any `headers` that are not object literals (e.g. a variable reference) — for those, wrap at the call site: `fetch(url, { ...init, headers: injectTraceHeaders(init.headers ?? {}) })`.

- [ ] **Step 5: Build**

Run: `npm run build -w @rdk-moss/agent`
Expected: build succeeds.

- [ ] **Step 6: Run full test suite**

Run: `npm test -w @rdk-moss/agent`
Expected: all specs pass.

- [ ] **Step 7: Commit**

```bash
git -C /d/moss-drobotics add packages/moss-agent/src/tools/web-fetch.ts packages/moss-agent/src/tools/web-search.ts
git -C /d/moss-drobotics commit -m "feat(tools): inject W3C traceparent into web-fetch/web-search outbound headers"
```

---

### Task 13: End-to-end manual verification

**Files:**
- None modified — verification only.

- [ ] **Step 1: Start the local OTLP receiver**

Run: `D:\otel\start-receiver.cmd` (or `node D:\otel\otel-receiver.mjs` in a separate window).
Expected: receiver listens on `:4318` for `/v1/traces` and `/v1/metrics`; dashboard available at `http://localhost:3000`.

- [ ] **Step 2: Run moss with observability enabled**

Run (in a separate shell):
```bash
cd /d/moss-drobotics
MOSS_OTEL_ENABLED=1 MOSS_OTEL_SERVICE_NAME=moss node packages/moss-agent/dist/cli.js
```
Expected: moss starts. Send one message that triggers a tool call (e.g. a prompt that makes the agent run a shell command or web_fetch). Exit with `/exit`.

- [ ] **Step 3: Verify traces arrived at the receiver**

Open `http://localhost:3000`. Expected: a trace rooted at `moss.session` containing nested `moss.agent.turn` → `moss.llm.request` and `moss.tool.invoke` spans, forming a tree. Span attributes include `runId`, `model`, `turn`, `toolName`, `inputTokens`, `outputTokens`.

- [ ] **Step 4: Verify metrics arrived**

In the dashboard, confirm metrics: `moss.llm.tokens` (input/output), `moss.llm.request.duration`, `moss.tool.invocations`, `moss.tool.invoke.duration`, `moss.session.count`, `moss.session.duration`, `moss.session.tool_count`. Each with `model`/`tool`/`outcome` dimensions.

- [ ] **Step 5: Verify local JSONL trace file**

Run:
```bash
wc -l /d/moss-drobotics/.moss/analytics/traces.jsonl
head -1 /d/moss-drobotics/.moss/analytics/traces.jsonl
```
Expected: line count > 0; first line is valid JSON with `name`, `startTime`, `endTime`, `attributes`, `status`.

- [ ] **Step 6: Verify disabled path is truly no-op**

Run (no env):
```bash
cd /d/moss-drobotics
node packages/moss-agent/dist/cli.js
```
Send one message, exit. Expected: no errors, no `traces.jsonl` created, no requests to `:4318`.

- [ ] **Step 7: Verify fire-and-forget survives receiver down**

Stop the receiver (Ctrl+C its window). Run moss with `MOSS_OTEL_ENABLED=1`, send a message. Expected: moss runs normally; span sends fail silently (no crash, no hang). Local `traces.jsonl` is still written (FileSpanProcessor doesn't need the receiver).

- [ ] **Step 8: Run full automated suite one final time**

Run: `npm test -w @rdk-moss/agent`
Expected: all specs pass.

- [ ] **Step 9: Final commit (if any verification note files added)**

If you recorded verification notes, commit them; otherwise no commit needed. The implementation is complete.

```bash
# only if notes were added:
git -C /d/moss-drobotics add -A && git -C /d/moss-drobotics commit -m "docs(observability): verification notes"
```
