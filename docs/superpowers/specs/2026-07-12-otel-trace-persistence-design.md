# OTel 链路持久化地基（spec1）

> 2026-07-12 · 分支 2026_07_08 · receiver 落本地 SQLite，重启不丢，为后续 metrics spec 定义存储模型。这是"补齐监控四个短板"系列的第 1 个 spec。

## 一、背景

上一轮加固后（cf19de9~1c89764），Moss 监控链路端到端打通：埋点（session→agent.llm_turn→tool.execute）→ otel-bridge（纯 fetch OTLP/JSON）→ receiver 面板 / Jaeger。但 receiver 是**全内存**：`traces` 数组（上限 1000）+ `sessions` 数组（上限 200），重启即清。这是本轮（spec1）要解决的第一个短板——**持久化**。后续三个短板（metrics+SDK/采样/跨进程传播）留作 spec2/3，spec1 不碰。

## 二、目标与范围

**目标：** receiver 收的 span 和会话摘要持久化到本地 SQLite，重启不丢，面板可查历史；为后续 spec2（metrics）定义可复用的数据存储模型。不改 Moss 埋点代码、不改 OTLP 协议、不引入 Collector。

**纳入范围：**
- receiver 新增 SQLite 存储层（`D:\otel\moss-traces.db`），span 与 session 各一表
- 收到数据时写库；面板 `/api/traces`、`/api/sessions` 改从库读（带时间窗口过滤）
- 内存数组保留作热缓存（面板快读），真相源是 SQLite
- 后台清理超期数据（默认 14 天，可配）
- `D:\otel\README.md` 补持久化说明

**排除范围：** Moss 侧埋点代码、OTLP 协议、Collector、Jaeger 持久化、metrics、采样、跨进程传播——全部留作 spec2/3 或不在本轮。

## 三、架构

本轮数据流（收发协议不变，仅存储层替换）：

```
Moss → POST :4318/v1/traces  ┐
Moss → POST :4318/v1/session-summary ┐
                         ↓
              otel-receiver.mjs
                ├─ 内存热缓存（面板快读，上限 500）
                └─ SQLite（moss-traces.db）  ← 真相源，持久化
                         ↑
              /api/traces、/api/sessions 从库读
                         ↑
              面板 :3000（HTML/JS 不变）
```

核心：OTLP 收发协议、端口、面板接口契约**全不动**；只把数据源从"内存数组"换成"SQLite（+热缓存）"。

## 四、组件改动

### 4.1 `D:\otel\package.json`（新增）

receiver 现无 package.json（靠全局 node 跑）。新增：
```json
{
  "type": "module",
  "dependencies": { "better-sqlite3": "^11.0.0" }
}
```
启动前 `cd D:\otel && npm install` 一次。依赖自包含，不污染 Moss 仓库。

### 4.2 `D:\otel\otel-receiver.mjs`（修改）

#### 4.2.1 SQLite 初始化（文件顶部）

- `import Database from 'better-sqlite3'`（顶层 import）。
- 启动 `open` `MOSS_TRACE_DB`（默认 `D:\otel\moss-traces.db`）。
- `journal_mode=DELETE` + `synchronous=FULL`：每条 INSERT 同步刷盘，进程被强杀也不丢已提交数据。比 WAL 慢，但 receiver 量小、且这是存储地基，持久性优先于速度。（实现期验证：WAL 模式下进程持有期间数据可见，但 checkpoint 时序依赖进程存活；DELETE+FULL 更稳妥。）
- 建表 SQL（IF NOT EXISTS）见 §五。
- 预编译 insert（`INSERT INTO spans ...`、`INSERT OR REPLACE INTO sessions ...`）。
- 打不开/建表失败 → 启动报错退出（地基没起来就别起，避免静默丢数据）。

#### 4.2.2 `/v1/traces` 写路径

现状遍历 span push 内存数组 + 轮转。改后：遍历 span ①仍 push 内存热缓存（上限降至 500）②同时 insert SQLite。写库失败只日志，不阻塞收发。

#### 4.2.3 `/v1/session-summary` 写路径

`INSERT OR REPLACE INTO sessions`（按 time 主键）写 SQLite，内存保留。

#### 4.2.4 `/api/traces`、`/api/sessions` 读路径

改从 SQLite 读。`/api/traces` 默认返回最近 200 条 span（start_time desc），`/api/sessions` 最近 200 条会话（time desc）。带可选 `?since=<ms>` 时间过滤。统计字段（total/errors/avgDuration）改 SQL 算：`SELECT count(*), sum(status='error'), avg(duration) FROM spans`。

#### 4.2.5 后台清理定时器

每 1 小时：`DELETE FROM spans WHERE start_time < ?`、`DELETE FROM sessions WHERE time < ?`（14 天前 ms）。保留期从 `MOSS_TRACE_RETENTION_DAYS` 读，默认 14。清理数写日志。

#### 4.2.6 进程退出 flush

`process.on('SIGINT'/'SIGTERM')` 关 db（`db.close()`），刷 WAL。

### 4.3 `D:\otel\README.md`（修改）

在现有"二选一"结构基础上，后端 A 段补持久化说明：DB 文件位置、保留期、清理周期、相关环境变量、重启不丢的特性。

## 五、SQLite 表结构

### 表 1：spans

| 列 | 类型 | 说明 |
|---|---|---|
| `trace_id` | TEXT | 同 trace 共享（索引） |
| `span_id` | TEXT | 主键 |
| `parent_span_id` | TEXT | 父 span；root NULL |
| `name` | TEXT | session/agent.llm_turn/tool.execute |
| `service` | TEXT | service.name |
| `start_time` | INTEGER | 毫秒（索引，时间窗口+清理） |
| `end_time` | INTEGER | 毫秒 |
| `duration` | INTEGER | 毫秒 |
| `status` | TEXT | ok/error |
| `status_message` | TEXT | 失败原因；成功 NULL |
| `tool_name` | TEXT | 仅 tool.execute；其它 NULL |
| `attrs` | TEXT | span 属性 JSON 串 |
| `events` | TEXT | 事件数组 JSON 串 |

主键 `span_id`；索引 `idx_spans_trace(trace_id)`、`idx_spans_start(start_time)`。

### 表 2：sessions

| 列 | 类型 | 说明 |
|---|---|---|
| `session_key` | TEXT | 会话键 |
| `run_id` | TEXT | 运行 id |
| `trace_id` | TEXT | 关联根 trace |
| `user_message` | TEXT | 用户提问 |
| `assistant_summary` | TEXT | LLM 摘要 |
| `tools_used` | TEXT | 工具名数组 JSON 串 |
| `outcome` | TEXT | completed/error/cancelled/... |
| `turns` | INTEGER | 轮次 |
| `tool_calls` | INTEGER | 工具调用数 |
| `duration_ms` | INTEGER | 耗时 |
| `tokens_in` | INTEGER | |
| `tokens_out` | INTEGER | |
| `error_detail` | TEXT | 失败详情；无 NULL |
| `time` | INTEGER | 毫秒（主键+索引） |

主键 `time`；索引 `idx_sessions_time(time)`。

**设计决定：**
- `attrs`/`events`/`tools_used` 用 JSON 串存——形状不固定（JSONL 时代亦然），拆列不划算；本轮不依赖 `json_extract`。
- 字段命名 snake_case，receiver 查询层做与面板 JS camelCase 的转换，不改面板。
- 不新增 metrics 列（spec2 的事）。

## 六、配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MOSS_TRACE_DB` | `D:\otel\moss-traces.db` | SQLite 文件路径 |
| `MOSS_TRACE_RETENTION_DAYS` | `14` | 保留天数 |
| `MOSS_TRACE_HOT_CACHE` | `500` | 内存热缓存条数 |

## 七、错误处理

- SQLite 打不开/建表失败 → 启动报错退出（地基未起就别起，避免静默丢数据）。
- 单条 insert 失败 → 日志，不阻塞该批其它 span。
- 清理定时器异常 → 捕获日志，下周期继续。
- 原则：存储层稳定优先，单条遥测失败可丢；收发永不因存储失败而阻塞或报错给 Moss。

## 八、测试与验证

receiver 纯 JS 脚本无现成测试框架，本轮不新建（避免超范围）：

1. **手动端到端**（主验证）：起 receiver → 跑 Moss 对话 → 面板见 trace → **重启 receiver** → 再开面板，历史数据仍在（本轮核心卖点）。
2. **SQLite 直查**（辅助）：`sqlite3 moss-traces.db "SELECT count(*) FROM spans"`、`SELECT * FROM spans WHERE status='error'`。
3. **清理验证**：临时 `MOSS_TRACE_RETENTION_DAYS=0`，跑清理，确认老数据被删。
4. 不新增单测框架。

## 九、改动清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `D:\otel\package.json` | 新增 | 声明 better-sqlite3，type module |
| `D:\otel\otel-receiver.mjs` | 修改 | SQLite 初始化 + 写库 + 改读路径 + 清理定时器 + 退出 flush |
| `D:\otel\README.md` | 修改 | 后端 A 段补持久化说明 |

全在 `D:\otel`（非 git），文件直接落盘，无 git 提交。Moss 仓库不动。

## 十、验收清单

- [ ] `D:\otel` 有 package.json 含 better-sqlite3，npm install 成功
- [ ] receiver 启动建出 moss-traces.db + 两表 + 索引
- [ ] span/session 入库，面板从库读显示正常
- [ ] **重启 receiver 后历史数据仍在**（核心）
- [ ] 14 天清理逻辑存在且可配
- [ ] `D:\otel\README.md` 补持久化说明
- [ ] 手动端到端冒烟通过

## 十一、后续 spec

- spec2：metrics + OTel SDK 接入 + 采样（引入本地 Collector 中转，依赖 spec1 的存储模型）
- spec3：跨进程 W3C context propagation（web_search/web_fetch 下游）
