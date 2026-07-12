# OTel 链路加固（第一轮）

> 2026-07-12 · 分支 `2026_07_08` · 让现有 trace 链路稳健、可操作、文档自洽，不改运行时行为

## 一、背景

经过对 `D:\moss-from-remote`（埋点端）与 `D:\otel`（接收/查看端）的勘察，现有监控链路已基本打通：

- 埋点端：`moss-agent` 通过自写 OTLP 桥（`observability/otel-bridge.ts`，纯 `fetch` + 手写 OTLP JSON，不依赖官方 SDK）发出 span，三级层级 `session → agent.llm_turn → tool.execute` 真实建立（`moss-agent.ts:1560` 建 root，`:1567` 传 `parentSpan`；`agent-loop-llm-call.ts:135`、`execute-tool-call.ts:433` 创建子 span）。
- 接收端：`D:\otel\otel-receiver.mjs`（自写收器 + 中文面板，监听 `:4318/v1/traces` 与 `:3000`）与 `docker-compose.yml` 里的 Jaeger all-in-one（`:16686` + `:4318`）。
- 启用：`cli-main.ts:614` 设 `MOSS_OTEL_URL` 或 `MOSS_OTEL_ENABLED` 即开启 `enableOtelTracing()`。

勘察发现本轮要处理的三个问题：

1. **端口冲突歧义**：otel-receiver 与 Jaeger 都监听 `4318`，二者不能同时跑，但 README 只讲了 Jaeger，没说明互斥关系。
2. **死依赖**：`package.json:30-33` 列了 4 个 `@opentelemetry/*` 包，但全仓库零 `import @opentelemetry/`。
3. **文档缺失**：Moss 侧"怎么启用监控"只散落在 `cli-main.ts` 源码里，两端文档对不上。

## 二、目标与范围

**目标：** 让现有 trace 链路稳健、操作上无歧义、文档自洽，且**不改运行时行为**。

**纳入范围：**
- 用文档说明 OTLP receiver 与 Jaeger 是**互斥后端**（二选一，绝不同时跑），不改任何端口或代码。
- 从 `package.json` 移除 4 个未使用的 `@opentelemetry/*` devDependency，并在 `otel-bridge.ts` 注明"故意不依赖 OTel SDK"。
- 在 `moss-from-remote` 新增启用文档，让两端文档在环境变量与端口上对得上。

**排除范围（留给后续 spec）：** metrics 指标体系、W3C context propagation、采样策略、持久化存储、本地 Collector 层。

## 三、架构

本轮无架构变更。现有数据流保持不变：

```
Moss agent 主循环
  session (root span)          ← moss-agent.ts:1560
    agent.llm_turn (子)        ← agent-loop-llm-call.ts:135
      tool.execute (孙)        ← execute-tool-call.ts:433
         ↓ enableOtelTracing() 注入的 Tracer
  otel-bridge.ts：纯 fetch POST OTLP/JSON（fire-and-forget）
         ↓ http://localhost:4318/v1/traces
  ┌───────────────┬──────────────────┐
  │ 后端 A(二选一)  │ 后端 B(二选一)    │
  │ otel-receiver │ Jaeger all-in-one│
  │ :4318/:3000   │ :4318/:16686     │
  └───────────────┴──────────────────┘
```

核心约束：**两个后端共享同一个 OTLP/HTTP 标准路径 `/v1/traces` 与端口 `4318`，因此互斥**——同一时刻只能起一个。

## 四、组件改动

### 4.1 `D:\otel\README.md`（改写为"二选一"结构）

当前标题"Jaeger 监控环境"只讲 Jaeger，改为双后端互斥结构：

1. 开头加**关键提示**：Moss 支持两个 OTLP 后端，二者互斥，同时刻只能起一个（都监听 `4318`）。
2. **后端 A：自写 OTLP 收器 + 面板**（`node otel-receiver.mjs`）
   - OTLP 接收：`http://localhost:4318/v1/traces`
   - 查看面板：`http://localhost:3000`
   - 适用：零依赖、自带中文面板与会话摘要视图，本地调试首选。
3. **后端 B：Jaeger all-in-one**（`docker compose up -d`）
   - OTLP 接收：`http://localhost:4318`
   - 查看 UI：`http://localhost:16686`
   - 适用：要看成熟 UI 或对接既有 Jaeger 体系。
4. 每个后端段落写明：**起之前确认 4318 没被另一个占用**，给出检查命令（`netstat -ano | findstr 4318`，或 `docker ps` 看是否已有 jaeger 容器）。
5. 现有"使用"（`enableOtelTracing({ serviceName: 'moss' })`）与"查看"（`:16686` 选 moss）示例分别归到对应后端下。

**不改**：`otel-receiver.mjs` 代码、`docker-compose.yml`、任何端口。

### 4.2 `D:\moss-from-remote\package.json`（删除死依赖）

从 `devDependencies` 删除：
- `@opentelemetry/exporter-trace-otlp-http`
- `@opentelemetry/resources`
- `@opentelemetry/sdk-trace-node`
- `@opentelemetry/semantic-conventions`

删除后跑 `npm install` 同步 `package-lock.json`。

### 4.3 `packages/moss-agent/src/observability/otel-bridge.ts`（补注释）

现有顶部注释已写 "No OTel SDK dependency — just standard fetch + JSON"，但易被误读为"待办"。在该注释块内补一句，明确这是**有意为之**，且未经具体需求（如 metrics、context propagation）不要引入 SDK 依赖，并指向本系列加固 spec。

### 4.4 `D:\moss-from-remote\docs\observability.md`（新增）

启用监控的入口文档，不塞进偏大的 README。内容分节：

1. **概述**：Moss 通过自写 OTLP 桥把 span 发到任意 OTLP/HTTP 后端，链路为 `session → agent.llm_turn → tool.execute`。
2. **启用方式**（对应 `cli-main.ts:614`）：
   - 设 `MOSS_OTEL_URL` 或 `MOSS_OTEL_ENABLED` 即开启；
   - `MOSS_OTEL_SERVICE_NAME` 可选，默认 `moss`；
   - `MOSS_OTEL_URL` 不设时 bridge 默认 `http://localhost:4318/v1/traces`（`otel-bridge.ts:124`）。
3. **指向哪个后端**（呼应 otel README，强调二选一）：
   - 自写 receiver：`MOSS_OTEL_URL=http://localhost:4318/v1/traces`（带 `/v1/traces`）
   - Jaeger：`MOSS_OTEL_URL=http://localhost:4318/v1/traces`（Jaeger 的 OTLP HTTP 同样收该路径）
   - 点明：两者 URL 相同，因为都遵循 OTLP/HTTP 标准路径；差异在后端进程本身——这正是"二选一"的体现。
4. **本地文件导出（可选）**：`enableLocalTracing(workspaceDir)` 写 `.moss/analytics/traces.jsonl`（`tracing.ts:193`），作为 OTLP 之外的本地兜底。
5. **排查提示**：面板/Jaeger 看不到数据时，先查 4318 是否被另一后端占用；并提醒——后端没起时 Moss 不会报错（otel-bridge fire-and-forget 静默忽略发送失败），所以"看不到数据"第一步查后端而非查 Moss。

## 五、错误处理

本轮无新错误路径，守住既有两条保证：

1. otel-bridge 发送失败静默忽略（`otel-bridge.ts:97` 的 `.catch(() => {})`）。文档（4.4 第 5 节）据此提醒用户："看不到数据"先查后端。
2. 删依赖后若 `npm install`/构建报缺失模块，说明有隐藏引用——**停下来与用户确认**，不擅自把依赖加回别处。

## 六、改动清单

| 文件 | 改动 | 说明 |
|------|------|------|
| `D:\otel\README.md` | 改写 | 双后端"二选一"结构，端口/启动/查看/占用检查 |
| `package.json` | 删 4 项 devDep | 未使用的 `@opentelemetry/*` |
| `package-lock.json` | 同步 | `npm install` 自动更新 |
| `packages/moss-agent/src/observability/otel-bridge.ts` | 补注释 | 说明故意不依赖 SDK |
| `docs/observability.md` | 新增 | 启用方式、后端选择、本地导出、排查 |

## 七、测试与验证

本轮无新功能代码，**不新增单测**，靠现有套件兜底：

1. `npm run verify`（`check:boundaries && check:hygiene && build && typecheck && lint && test`）必须全绿——删依赖后最关键的一道闸，确认无隐藏 `@opentelemetry/*` 引用。
2. 链路冒烟（手动，可选但推荐）：起一个后端 → 设 `MOSS_OTEL_URL` → 跑一次 `moss` 对话 → 在面板/Jaeger 确认 `session → agent.llm_turn → tool.execute` 三级 span 可见。

**验收清单：**
- [ ] `package.json` 不再含 4 个 `@opentelemetry/*` 包，`package-lock.json` 已同步
- [ ] `otel-bridge.ts` 顶部注释说明"故意不依赖 SDK"
- [ ] `D:\otel\README.md` 改成"二选一"结构，两个后端端口/启动/查看方式写清
- [ ] `docs/observability.md` 新增，覆盖启用方式、后端选择、本地导出、排查
- [ ] `npm run verify` 全绿
- [ ] （可选）手动冒烟：三级 span 在后端可见

## 八、后续 spec（本轮不做）

- metrics 指标体系（接 OTel SDK Metrics API + Prometheus exporter）
- W3C context propagation（跨进程链路，web_search/web_fetch 下游）
- 采样策略（高并发下 4318 压力）
- 持久化存储（receiver/Jaeger 当前全内存，重启即丢）
- 本地 Collector 层（同时扇出到多后端）
