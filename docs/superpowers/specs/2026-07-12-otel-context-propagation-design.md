# OTel 跨进程 context propagation（spec3）

> 2026-07-12 · 分支 2026_07_08 · Moss 调 web_search/web_fetch 时注入 W3C traceparent 头，跨进程链路不断。这是"补齐监控四个短板"系列的第 3 个 spec（spec1 持久化、spec2 metrics+采样已完成）。

## 一、背景

spec2 做完后，metrics 与 trace 采样齐备，但 trace 跨进程链路断在 Moss 边界——Moss 调外部服务（web_search/web_fetch）时，出站 HTTP 不注入 trace context，下游若识别 traceparent 也加入不了同一 trace。本地单进程调工具暂不致命，但一旦调真外部服务，链路就断。本 spec 补出站 propagation。

不迁 SDK（与 spec2 一致）：traceparent 在手写 otel-bridge 生成、AsyncLocalStorage 传当前 span、web fetch 注入。

## 二、目标与范围

**目标：** 让 Moss 调 web_search/web_fetch 时，把当前 span 的 W3C traceparent 注入出站 HTTP 头，使跨进程链路不断。

**纳入范围：**
- otel-bridge 加 AsyncLocalStorage 存当前 span，`withSpan` 用 `als.run` 包 fn（进 push/出 pop）
- 新增 `getCurrentSpan()`（返回当前 OtelSpanState 或 undefined）
- 新增 `injectTraceparent(headers)`：从当前 span 拼 W3C `traceparent` 头
- `web-search.ts`、`web-fetch.ts` fetch 前注入 traceparent
- propagation 单测（getCurrentSpan + injectTraceparent）
- `docs/observability.md` 补跨进程传播说明

**排除范围：** 入站提取（只出站）、LLM provider/MCP 调用注入、trace 迁 SDK、web_search/web_fetch 之外的出站点。

## 三、架构

```
tool.execute span（withSpan 包 fn）
  └─ als.run(state, fn)          ← context 自动随异步链路传播
       └─ web_search/web_fetch
            └─ fetch(url, { headers: injectTraceparent(init.headers) })
                 └─ traceparent: 00-<traceId>-<spanId>-<flags>  注入出站 HTTP
                      └─ 下游（若识别）加入同一 trace
```

核心：AsyncLocalStorage 在 `withSpan` 的 fn 执行期间保持当前 span，web fetch 从它取 traceId/spanId/sampled 拼 traceparent。不在 span 内 → 不注入（降级）。

## 四、组件改动

### 4.1 otel-bridge.ts（修改）

- 模块级 `const spanContext = new AsyncLocalStorage<OtelSpanState>()`（`node:async_hooks`，零依赖）。
- 暴露 `getCurrentSpan(): OtelSpanState | undefined` —— 返回 `spanContext.getStore()`。
- 暴露 `injectTraceparent(headers): Record<string,string>` —— 从 getCurrentSpan 拼 W3C traceparent，不在 span 内返回原 headers。
- span 的 `end()` 不变（sendSpan 已有）；context 的 push/pop 由 `withSpan` 经由 tracer 接口接管（见 4.2）。

### 4.2 tracing.ts 的 withSpan（修改）

`withSpan` 现状：`const span = tracer.startSpan(...); try { result = await fn(span); } finally { span.end(); }`。
改：让 otel-bridge 注入的 span 对象支持 context 包装——通过在 span 对象上加一个符号方法 `__runWithContext<T>(fn)`（otel-bridge 实现：`als.run(state, fn)`），`withSpan` 检测到该方法则用它包 fn，否则直接调 fn（保持兼容，旧 tracer 不受影响）。

### 4.3 web-search.ts（修改，:233）

```ts
import { injectTraceparent } from '../../observability/otel-bridge.js';
// ...
const res = await fetch(url, {
  ...init,
  headers: injectTraceparent(init.headers ?? {}),
  signal: controller.signal,
});
```

### 4.4 web-fetch.ts（修改，:552）

```ts
import { injectTraceparent } from '../../observability/otel-bridge.js';
// ...
res = await fetch(fetchUrl.toString(), {
  ...fetchInit,
  headers: injectTraceparent(fetchInit.headers ?? {}),
});
```

### 4.5 propagation 单测（新增）

`packages/moss-agent/src/observability/otel-bridge.spec.mjs`（或在现有测试目录）：
- `withSpan` 内调 `getCurrentSpan()` 拿到 state；外调 undefined。
- `injectTraceparent` 在 span 内拼出 `00-<traceId>-<spanId>-01`（sampled）；未采样 flags=00。
- span 外 `injectTraceparent` 返回原 headers（无 traceparent）。

### 4.6 docs/observability.md（修改）

加"跨进程传播"节：Moss 调 web_search/web_fetch 注入 W3C traceparent，下游可加入同一 trace；依赖 fetch 在 span 异步链路内发起。

## 五、W3C traceparent 格式

`00-<traceId 32hex>-<spanId 16hex>-<flags 2hex>`

- 版本：`00`
- traceId：32 hex（otel-bridge 的 generateTraceId 已是 32 hex）
- spanId：16 hex（generateSpanId 已是 16 hex）
- flags：sampled 则 `01`，未采样 `00`

例：`00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01`

## 六、错误处理

- `getCurrentSpan()` 不在 span 内 → undefined → `injectTraceparent` 不注入（降级，不报错）。
- traceparent 拼接失败/traceId 格式异常 → try/catch，不注入。
- AsyncLocalStorage 零依赖（node 内置），不初始化失败。
- 原则：propagation 永不搞挂业务 fetch——注入失败就当没装 propagation。

## 七、设计限制：context 跨度

AsyncLocalStorage 只在同一异步链路保持 store。web_search/web_fetch 的 fetch 在 `tool.execute` span 的 withSpan fn 体内（同一链路），context 能传到。若 fetch 在 setTimeout/setInterval 回调或脱离 span 链路的新 Promise 外发起，context 可能断——文档点明，业务侧避免。

## 八、测试与验证

1. **单测**（4.5）：getCurrentSpan/injectTraceparent 逻辑。
2. **端到端冒烟**：起 receiver，trace 开启，在 span 内 fetch 一个回显请求头的端点（httpbin.org/headers 或本地 echo），确认收到 `traceparent` 头。
3. `npm run verify` 全绿（含新单测）。
4. receiver 侧不改（spec3 只动 Moss）。

## 九、改动清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `observability/otel-bridge.ts` | 修改 | AsyncLocalStorage + getCurrentSpan + injectTraceparent |
| `observability/tracing.ts` | 修改 | withSpan 经 span 的符号方法包 als.run |
| `tools/web-search.ts` | 修改 | fetch 前注入 traceparent |
| `tools/web-fetch.ts` | 修改 | fetch 前注入 traceparent |
| `observability/otel-bridge.spec.mjs` | 新增 | propagation 单测 |
| `docs/observability.md` | 修改 | 跨进程传播说明 |

## 十、验收清单

- [ ] otel-bridge 加 AsyncLocalStorage + getCurrentSpan
- [ ] withSpan 用 als.run 包 fn，context 自动传播
- [ ] injectTraceparent，span 外降级不注入
- [ ] web-search / web-fetch fetch 前注入 traceparent
- [ ] propagation 单测通过
- [ ] 端到端冒烟：span 内 fetch 带 traceparent 头
- [ ] `npm run verify` 全绿
- [ ] docs/observability.md 补跨进程传播

## 十一、后续

- spec3 是四个短板的最后一个。完成后监控链路：trace 父子串联 + 采样 + 持久化 + metrics + 跨进程传播，端到端齐备。
- 未来可选：trace 迁 SDK（统一两套、白得标准 propagator）、入站 propagation、LLM provider 注入、运行时进程指标。
