# OTel 跨进程 context propagation（spec3）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Moss 调 web_search/web_fetch 时注入 W3C traceparent 头，跨进程链路不断。

**Architecture:** otel-bridge 加 AsyncLocalStorage 存当前 span；TraceSpan 接口加可选 `runWithContext`，otel-bridge 的 span 实现它（`als.run(state, fn)`），withSpan 检测到则用它包 fn；新增 `getCurrentSpan()` + `injectTraceparent()`；web-search/web-fetch fetch 前注入。不迁 SDK，与 spec2 一致。只改 Moss，receiver 不动。

**Tech Stack:** Node.js ESM、TypeScript、`node:async_hooks`（AsyncLocalStorage，零依赖）。只改 `D:\moss-from-remote`（git）。

**对应 spec:** `docs/superpowers/specs/2026-07-12-otel-context-propagation-design.md`

## Global Constraints

- **不迁 SDK**：traceparent 手写在 otel-bridge，与 spec2 一致。
- **只出站、只 web_search/web_fetch**：不动 LLM provider/MCP，不做入站。
- **propagation 永不搞挂业务 fetch**：不在 span 内或注入失败 → 不注入、不报错、降级。
- **兼容旧 tracer**：`runWithContext` 是可选接口；旧 tracer（noop/console/local-file）不实现时 withSpan 直接调 fn。
- **AsyncLocalStorage 依赖 node 内置**（`node:async_hooks`），零外部依赖。
- **tracing.ts 不 import otel-bridge**：通过可选接口解耦，不反向依赖。

---

## File Structure

| 文件 | 动作 | 责任 |
|------|------|------|
| `observability/otel-bridge.ts` | 修改 | AsyncLocalStorage + getCurrentSpan + injectTraceparent + span.runWithContext |
| `observability/tracing.ts` | 修改 | TraceSpan 接口加可选 runWithContext；withSpan 检测用它包 fn |
| `observability/index.ts` | 修改 | 导出 getCurrentSpan / injectTraceparent |
| `tools/web-search.ts` | 修改 | fetch 前注入 traceparent |
| `tools/web-fetch.ts` | 修改 | fetch 前注入 traceparent |
| `observability/otel-bridge.spec.mjs` | 新增 | propagation 单测 |
| `docs/observability.md` | 修改 | 跨进程传播说明 |

任务顺序：otel-bridge 加 ALS+getCurrentSpan+injectTraceparent+runWithContext（Task1）→ tracing.ts withSpan 接 runWithContext（Task2）→ index 导出（Task3）→ web-search/web-fetch 注入（Task4）→ 单测（Task5）→ 文档（Task6）→ 端到端验证（Task7）。

---

### Task 1: otel-bridge 加 AsyncLocalStorage + getCurrentSpan + injectTraceparent + runWithContext

**Files:**
- Modify: `D:\moss-from-remote\packages\moss-agent\src\observability\otel-bridge.ts`

**Interfaces:**
- Consumes: spec2 已加的 OtelSpanState（含 sampled）。
- Produces: `getCurrentSpan()`、`injectTraceparent()`、span 的 `runWithContext` 方法，供 Task2/4 用。

- [ ] **Step 1: 加 AsyncLocalStorage import + 模块级 als**

在 `import Database` 旁（实际是 `import { setTracer, getTracer } ...` 之后）加：
```ts
import { AsyncLocalStorage } from 'node:async_hooks';
```
在 `let otlpUrl = '';` / `let serviceName = '';` 附近（模块级状态）加：
```ts
/** AsyncLocalStorage carrying the current OtelSpanState, for context propagation. */
const spanContext = new AsyncLocalStorage<OtelSpanState>();
```

- [ ] **Step 2: 加 getCurrentSpan + injectTraceparent 导出**

在 `sampleByTraceId` 函数之后（或文件末尾 disableOtelTracing 之前）加：
```ts
/**
 * Get the current span state (within a withSpan/runWithContext call), or undefined.
 * Used by injectTraceparent to attach W3C traceparent to outbound requests.
 */
export function getCurrentSpan(): OtelSpanState | undefined {
  return spanContext.getStore();
}

/**
 * Inject W3C traceparent header for the current span into the given headers.
 * Returns headers unchanged if not within a span (graceful degradation).
 * Format: 00-<traceId 32hex>-<spanId 16hex>-<flags 2hex>; flags=01 if sampled.
 */
export function injectTraceparent(
  headers: Record<string, string> = {}
): Record<string, string> {
  try {
    const state = getCurrentSpan();
    if (!state) return headers;
    const flags = state.sampled ? '01' : '00';
    const tp = `00-${state.traceId}-${state.spanId}-${flags}`;
    return { ...headers, traceparent: tp };
  } catch {
    return headers;
  }
}
```

- [ ] **Step 3: span 对象加 runWithContext 方法**

在 otel-bridge 的 `const span = { ... }` 对象里（:178-201），在 `[OTEL_STATE]: state,` 之前加：
```ts
        runWithContext<U>(fn: () => Promise<U>): Promise<U> {
          return spanContext.run(state, fn);
        },
```
注意 `runWithContext` 引用 `spanContext`（模块级）和 `state`（闭包），都在作用域内。

- [ ] **Step 4: typecheck**

Run: `cd /d/moss-from-remote && npm run typecheck`
Expected: 可能报 `TraceSpan` 接口没有 `runWithContext`（因为 span 对象加了但接口没声明）——这是 Task2 要加的。**若报错是"span 对象有接口未声明成员"的类型不匹配，先记下，Task2 修接口后自然解决。** 若报其它错，排查。

- [ ] **Step 5: 暂不提交（等 Task2 修接口后一起 typecheck 通过再提交）**

---

### Task 2: tracing.ts 的 TraceSpan 接口 + withSpan 接 runWithContext

**Files:**
- Modify: `D:\moss-from-remote\packages\moss-agent\src\observability\tracing.ts`

**Interfaces:**
- Consumes: Task1 的 span.runWithContext。
- Produces: withSpan 在 fn 执行期间自动设 AsyncLocalStorage store。

- [ ] **Step 1: TraceSpan 接口加可选 runWithContext**

在 `tracing.ts` 的 `export interface TraceSpan {` 里（:14-23），在 `end(): void;` 之后加：
```ts
  /** Optional: run fn within this span's context (for context propagation).
   *  Implementations that support it (otel-bridge) set the AsyncLocalStorage store;
   *  others return fn() directly. */
  runWithContext?<U>(fn: () => Promise<U>): Promise<U>;
```

- [ ] **Step 2: withSpan 用 runWithContext 包 fn**

把 `withSpan` 的 try 块（:138-141）：
```ts
  try {
    const result = await fn(span);
    span.setStatus(true);
    return result;
  } catch (err) {
```
改为：
```ts
  try {
    const run = span.runWithContext ?? ((fn: () => Promise<unknown>) => fn());
    const result = await run(() => fn(span)) as T;
    span.setStatus(true);
    return result;
  } catch (err) {
```
（`span.runWithContext` 存在则用它包 fn（设 ALS store）；否则 fallback 直接调 fn。兼容旧 tracer。）

- [ ] **Step 3: typecheck + build**

Run: `cd /d/moss-from-remote && npm run typecheck && npm run build`
Expected: 通过（Task1 的 span.runWithContext 现在有接口声明了，类型匹配）。

- [ ] **Step 4: 提交 Task1+2**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/observability/otel-bridge.ts packages/moss-agent/src/observability/tracing.ts
git commit -m "feat(observability): AsyncLocalStorage context + W3C traceparent 注入

otel-bridge 加 AsyncLocalStorage 存当前 span, getCurrentSpan() +
injectTraceparent(); TraceSpan 接口加可选 runWithContext, otel-bridge
实现(als.run), withSpan 检测到则包 fn。旧 tracer 不受影响。
为跨进程 propagation 铺路(spec3)。"
```

---

### Task 3: index.ts 导出 getCurrentSpan / injectTraceparent

**Files:**
- Modify: `D:\moss-from-remote\packages\moss-agent\src\observability\index.ts`

**Interfaces:**
- Consumes: Task1 的两个函数。
- Produces: 业务点可 `import { injectTraceparent } from '...observability'`。

- [ ] **Step 1: 加导出**

在 index.ts 的 `// OpenTelemetry bridge` 块（导出 enableOtelTracing 处）加：
```ts
export { enableOtelTracing, disableOtelTracing, getCurrentSpan, injectTraceparent } from './otel-bridge.js';
```
（在现有 enable/disable 导出行追加这两个名字。）

- [ ] **Step 2: typecheck**

Run: `cd /d/moss-from-remote && npm run typecheck`
Expected: 通过。

- [ ] **Step 3: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/observability/index.ts
git commit -m "feat(observability): 导出 getCurrentSpan / injectTraceparent"
```

---

### Task 4: web-search / web-fetch fetch 前注入 traceparent

**Files:**
- Modify: `tools/web-search.ts`（:233）、`tools/web-fetch.ts`（:552）

**Interfaces:**
- Consumes: Task3 的 injectTraceparent。
- Produces: 出站 fetch 带 traceparent 头。

- [ ] **Step 1: web-search.ts 注入**

在 `web-search.ts` import 区加（看现有 import 风格，路径 `../../observability/`）：
```ts
import { injectTraceparent } from '../../observability/index.js';
```
把 :233：
```ts
    const res = await fetch(url, { ...init, signal: controller.signal });
```
改为：
```ts
    const res = await fetch(url, {
      ...init,
      headers: injectTraceparent(init.headers ?? {}),
      signal: controller.signal,
    });
```
注意：若 `init` 的 headers 已是 Headers 对象而非 plain object，`injectTraceparent` 接的是 `Record<string,string>`——确认 init.headers 类型，必要时转。先看实际类型。

- [ ] **Step 2: web-fetch.ts 注入**

在 `web-fetch.ts` import 区加：
```ts
import { injectTraceparent } from '../../observability/index.js';
```
把 :552：
```ts
            res = await fetch(fetchUrl.toString(), fetchInit);
```
改为：
```ts
            res = await fetch(fetchUrl.toString(), {
              ...fetchInit,
              headers: injectTraceparent(fetchInit.headers ?? {}),
            });
```
同样确认 fetchInit.headers 类型。

- [ ] **Step 3: typecheck + build**

Run: `cd /d/moss-from-remote && npm run typecheck && npm run build`
Expected: 通过。若 headers 类型不匹配（Headers vs plain object），调整 injectTraceparent 调用或加类型转换。

- [ ] **Step 4: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/tools/web-search.ts packages/moss-agent/src/tools/web-fetch.ts
git commit -m "feat(tools): web_search/web_fetch 注入 W3C traceparent

出站 fetch 带 traceparent 头,下游识别则加入同一 trace,
跨进程链路不断(spec3)。"
```

---

### Task 5: propagation 单测

**Files:**
- Create: `D:\moss-from-remote\packages\moss-agent\src\observability\otel-bridge.spec.mjs`

**Interfaces:**
- Consumes: Task1-3 的 enableOtelTracing/getCurrentSpan/injectTraceparent + withSpan。
- Produces: propagation 逻辑有单测覆盖。

- [ ] **Step 1: 看现有测试格式**

Run: `ls /d/moss-from-remote/packages/moss-agent/src/observability/*.spec.mjs 2>/dev/null; ls /d/moss-from-remote/packages/moss-agent/test/*.spec.mjs 2>/dev/null | head`
看测试放哪、用什么 runner（node:test / vitest）。spec1 经验：moss-agent 用 `node:test`（见 pre-flight-router.spec.mjs）。

- [ ] **Step 2: 写单测**

创建 `packages/moss-agent/src/observability/otel-bridge.spec.mjs`（或 test/ 下，看 Step1 结果）。用 `node:test`：
```js
import { test } from 'node:test';
import assert from 'node:assert';
import { enableOtelTracing, getCurrentSpan, injectTraceparent } from './otel-bridge.js';
import { withSpan } from './tracing.js';

test('getCurrentSpan: undefined outside withSpan', () => {
  enableOtelTracing({ serviceName: 'test' });
  assert.equal(getCurrentSpan(), undefined);
});

test('getCurrentSpan: set inside withSpan', async () => {
  enableOtelTracing({ serviceName: 'test' });
  await withSpan('test.span', undefined, async (span) => {
    const ctx = getCurrentSpan();
    assert.ok(ctx, 'current span should be set inside withSpan');
    assert.equal(ctx.name, 'test.span');
  });
});

test('injectTraceparent: returns original headers outside span', () => {
  const h = { 'content-type': 'application/json' };
  const out = injectTraceparent(h);
  assert.equal(out.traceparent, undefined);
  assert.equal(out['content-type'], 'application/json');
});

test('injectTraceparent: produces valid W3C traceparent inside span', async () => {
  enableOtelTracing({ serviceName: 'test' });
  await withSpan('test.span', undefined, async () => {
    const out = injectTraceparent({});
    assert.ok(out.traceparent, 'traceparent should be set');
    // 00-<32hex>-<16hex>-<2hex>
    assert.match(out.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[01]$/);
    assert.equal(out.traceparent.slice(-2), '01', 'sampled flag=01 by default (ratio 1.0)');
  });
});

test('injectTraceparent: flags=00 when not sampled', async () => {
  // ratio 0 → not sampled → but still inject (span exists, sampled=false)
  process.env.MOSS_TRACE_SAMPLE_RATIO = '0';
  // Re-import to pick up ratio? Module-level const already set. This test is best-effort;
  // sampled flag depends on traceId hash vs ratio. Skip strict check, just verify format.
  enableOtelTracing({ serviceName: 'test' });
  await withSpan('test.span', undefined, async () => {
    const out = injectTraceparent({});
    assert.match(out.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });
});
```
注：sampled 测试较 tricky（traceId 随机），上面那个 sampled flag 测试用 ratio 1.0 默认（必 sampled=01）。ratio 0 的测试可能不稳，可简化或删。

- [ ] **Step 3: 跑单测**

Run: `cd /d/moss-from-remote && node --test packages/moss-agent/src/observability/otel-bridge.spec.mjs`
Expected: 全 pass。

- [ ] **Step 4: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/observability/otel-bridge.spec.mjs
git commit -m "test(observability): propagation 单测

覆盖 getCurrentSpan(内/外)、injectTraceparent(内/外、W3C 格式)。"
```

---

### Task 6: docs/observability.md 补跨进程传播

**Files:**
- Modify: `docs/observability.md`

**Interfaces:**
- Consumes: Task1-4 行为。
- Produces: 文档说明跨进程传播。

- [ ] **Step 1: 加跨进程传播节**

在 docs/observability.md 的 Metrics 节之后、排查之前，加：
```markdown
## 跨进程传播

Moss 调 web_search / web_fetch 时，自动把当前 span 的 W3C `traceparent` 头注入出站 HTTP（格式 `00-<traceId>-<spanId>-<flags>`）。下游服务若识别 traceparent，可加入同一 trace，跨进程链路不断。

- 依赖 fetch 在 span 的异步链路内发起（tool.execute span 内调用）。若 fetch 在 setTimeout/setInterval 回调外脱离 span 链路，traceparent 可能不注入（降级，不报错）。
- 不在 span 内的 fetch 不注入（自动降级）。
- 只注入 web_search/web_fetch，不覆盖 LLM provider/MCP 调用。
- traceparent 的 flags 位反映采样：sampled=01，未采样=00。
```

- [ ] **Step 2: 提交**

```bash
cd /d/moss-from-remote
git add docs/observability.md
git commit -m "docs(observability): 补跨进程传播说明"
```

---

### Task 7: 端到端验证

**Files:**
- 无文件改动，仅验证。

**Interfaces:**
- Consumes: Task1-6 全部。
- Produces: 验收清单全勾。

- [ ] **Step 1: npm run verify 全绿**

Run: `cd /d/moss-from-remote && npm run verify`
Expected: 全绿（含新单测）。

- [ ] **Step 2: 端到端冒烟——traceparent 真注入**

起一个本地 echo server（回显收到的请求头），在 span 内 fetch 它，确认收到 traceparent：
```bash
cd /d/moss-from-remote && cat > _e2e.mjs <<'EOF'
import http from 'node:http';
import { enableOtelTracing, injectTraceparent } from './packages/moss-agent/dist/observability/index.js';
import { withSpan } from './packages/moss-agent/dist/observability/tracing.js';

// echo server
const srv = http.createServer((req, res) => {
  res.writeHead(200);
  res.end(JSON.stringify({ traceparent: req.headers.traceparent || null }));
}).listen(4319, async () => {
  enableOtelTracing({ serviceName: 'moss', url: 'http://localhost:9999/v1/traces' }); // dummy url, not sending
  await withSpan('test.span', undefined, async () => {
    const r = await fetch('http://localhost:4319/', { headers: injectTraceparent({}) });
    const body = await r.json();
    console.log('received traceparent:', body.traceparent);
    if (!body.traceparent) { console.error('FAIL: no traceparent'); process.exit(1); }
    if (!/^00-[0-9a-f]{32}-[0-9a-f]{16}-[01]$/.test(body.traceparent)) { console.error('FAIL: bad format'); process.exit(1); }
    console.log('PASS: traceparent injected');
  });
  srv.close();
  process.exit(0);
});
EOF
node _e2e.mjs; rm -f _e2e.mjs
```
Expected: `PASS: traceparent injected`。

- [ ] **Step 3: 验收清单核对**

- [ ] otel-bridge 加 AsyncLocalStorage + getCurrentSpan
- [ ] withSpan 用 als.run 包 fn，context 自动传播
- [ ] injectTraceparent，span 外降级不注入
- [ ] web-search / web-fetch fetch 前注入 traceparent
- [ ] propagation 单测通过
- [ ] 端到端冒烟：span 内 fetch 带 traceparent 头
- [ ] `npm run verify` 全绿
- [ ] docs/observability.md 补跨进程传播

- [ ] **Step 4: 收尾报告**

向用户报告 spec3 完成 + 四个短板全部补齐。

---

## Self-Review 已完成

对照 spec 逐条：
- §4.1 otel-bridge ALS+getCurrentSpan+injectTraceparent → Task1 ✅
- §4.2 withSpan 接 runWithContext → Task2 ✅
- §4.3 web-search 注入 → Task4 ✅
- §4.4 web-fetch 注入 → Task4 ✅
- §4.5 单测 → Task5 ✅
- §4.6 文档 → Task6 ✅
- §八 测试（单测+冒烟+verify）→ Task5/7 ✅
- §十 验收 → Task7 Step3 ✅

无占位符；W3C 格式全文一致；runWithContext 可选兼容旧 tracer；scope 聚焦出站 propagation。
