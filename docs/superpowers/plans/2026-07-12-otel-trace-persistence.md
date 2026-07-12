# OTel 链路持久化地基（spec1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** receiver 落本地 SQLite，重启不丢，面板可查历史，为后续 metrics spec 定义存储模型。

**Architecture:** 给 receiver 加 SQLite 存储层——OTLP 收发协议/端口/面板接口契约全不动，只把数据源从"内存数组"换成"SQLite（+热缓存）"。改动全在 `D:\otel`（非 git）。

**Tech Stack:** Node.js ESM、`better-sqlite3`（同步 API）、SQLite。两个目录：`D:\otel`（receiver，非 git，文件直接落盘）与 `D:\moss-from-remote`（git，spec/plan 在此）。

**对应 spec:** `docs/superpowers/specs/2026-07-12-otel-trace-persistence-design.md`

## Global Constraints

- **不改 Moss 仓库任何代码**：所有改动在 `D:\otel`，Moss 仍 POST 到 4318，收发协议/端口不变。
- **面板接口契约不变**：`/api/traces`、`/api/sessions` 返回同样形状的 JSON，面板 HTML/JS 不动。
- **收发永不因存储失败阻塞或报错给 Moss**：SQLite 写失败只日志，收发仍返回 200。
- **存储地基失败要硬**：SQLite 打不开/建表失败 → 启动报错退出（区别于遥测的 fire-and-forget）。
- **不引入 Collector**（留作 spec2）、**不改 Jaeger**、**不碰 Moss 埋点**。
- **环境变量带默认值**：`MOSS_TRACE_DB`=`D:\otel\moss-traces.db`、`MOSS_TRACE_RETENTION_DAYS`=`14`、`MOSS_TRACE_HOT_CACHE`=`500`。

---

## File Structure

| 文件 | 动作 | 责任 |
|------|------|------|
| `D:\otel\package.json` | 新增 | 声明 better-sqlite3，type module |
| `D:\otel\otel-receiver.mjs` | 修改 | SQLite 初始化 + 写库 + 改读路径 + 清理定时器 + 退出 flush |
| `D:\otel\README.md` | 修改 | 后端 A 段补持久化说明 |

任务顺序：先装依赖建 package.json（Task 1，后续都靠它）→ SQLite 初始化与建表（Task 2，地基）→ 写路径接库（Task 3）→ 读路径改从库读（Task 4）→ 清理定时器+退出 flush（Task 5）→ README 补持久化说明（Task 6）→ 端到端验证含重启（Task 7）。

---

### Task 1: 给 D:\otel 装 better-sqlite3 依赖

**Files:**
- Create: `D:\otel\package.json`
- Test: `cd D:\otel && node -e "import('better-sqlite3').then(m=>console.log('ok'))"`

**Interfaces:**
- Consumes: 无
- Produces: 一个可 `import 'better-sqlite3'` 的 `D:\otel` 环境，供 Task 2+ 使用。

- [ ] **Step 1: 写 package.json**

创建 `D:\otel\package.json`：
```json
{
  "name": "otel-receiver",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run:
```bash
cd /d/otel && npm install
```
Expected: 安装成功，生成 `node_modules/` 与 `package-lock.json`。若报编译错误（better-sqlite3 原生模块需编译工具），**停下来与用户确认**——可能需要 `npm install --build-from-source` 或预编译二进制。

- [ ] **Step 3: 验证可 import**

Run:
```bash
cd /d/otel && node -e "import('better-sqlite3').then(m=>console.log('ok', typeof m.default))"
```
Expected: 输出 `ok function`（能动态 import，且 default 是构造函数）。若报 `Cannot find module`，回到 Step 2 排查。

- [ ] **Step 4: 无 git 提交（D:\otel 非 git）**

确认非 git：
```bash
cd /d/otel && git rev-parse --is-inside-work-tree 2>&1
```
Expected: `fatal: not a git repository`。文件直接落盘，无提交动作。

---

### Task 2: SQLite 初始化与建表

**Files:**
- Modify: `D:\otel\otel-receiver.mjs`（顶部 import 后、`const traces = []` 附近）

**Interfaces:**
- Consumes: Task 1 的 better-sqlite3。
- Produces: 模块级 `db`（Database 实例）、`insertSpan`/`insertSession`（预编译 insert Statement），供 Task 3 使用；两表 + 索引建好。

- [ ] **Step 1: 在 import 块后加 SQLite 加载与建表**

在 `otel-receiver.mjs` 的 `import { fileURLToPath } from 'node:url';` 之后、`const __dirname = ...` 之前插入：
```js
import Database from 'better-sqlite3';
```

然后在 `const MAX_SESSIONS = 200;` 之后插入 SQLite 初始化块：
```js
// ── SQLite persistent storage ───────────────────────────────────────────────
const DB_PATH = process.env.MOSS_TRACE_DB || path.join(__dirname, 'moss-traces.db');
const RETENTION_DAYS = Number(process.env.MOSS_TRACE_RETENTION_DAYS ?? 14);
const HOT_CACHE = Number(process.env.MOSS_TRACE_HOT_CACHE ?? 500);

let db;
try {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS spans (
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL PRIMARY KEY,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      service TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      duration INTEGER,
      status TEXT,
      status_message TEXT,
      tool_name TEXT,
      attrs TEXT,
      events TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
    CREATE INDEX IF NOT EXISTS idx_spans_start ON spans(start_time);

    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT,
      run_id TEXT,
      trace_id TEXT,
      user_message TEXT,
      assistant_summary TEXT,
      tools_used TEXT,
      outcome TEXT,
      turns INTEGER,
      tool_calls INTEGER,
      duration_ms INTEGER,
      tokens_in INTEGER,
      tokens_out INTEGER,
      error_detail TEXT,
      time INTEGER NOT NULL PRIMARY KEY
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(time);
  `);
} catch (err) {
  console.error('[otel-receiver] FATAL: cannot open SQLite:', err.message);
  process.exit(1);
}

const insertSpan = db.prepare(`
  INSERT OR REPLACE INTO spans
    (trace_id, span_id, parent_span_id, name, service, start_time, end_time,
     duration, status, status_message, tool_name, attrs, events)
  VALUES (@traceId, @spanId, @parentSpanId, @name, @service, @startTime,
          @endTime, @duration, @status, @statusMessage, @toolName, @attrs, @events)
`);
const insertSession = db.prepare(`
  INSERT OR REPLACE INTO sessions
    (session_key, run_id, trace_id, user_message, assistant_summary, tools_used,
     outcome, turns, tool_calls, duration_ms, tokens_in, tokens_out, error_detail, time)
  VALUES (@sessionKey, @runId, @traceId, @userMessage, @assistantSummary, @toolsUsed,
          @outcome, @turns, @toolCalls, @durationMs, @tokensIn, @tokensOut, @errorDetail, @time)
`);
```

- [ ] **Step 2: 验证建表**

Run:
```bash
cd /d/otel && node -e "import('./otel-receiver.mjs')" &
sleep 2 && sqlite3 moss-traces.db ".tables" 2>&1
```
Expected: 输出含 `sessions  spans`（两表建出）。若 sqlite3 不可用，用 node 查：`node -e "import('better-sqlite3').then(m=>{const db=new m.default('moss-traces.db');console.log(db.prepare('SELECT name FROM sqlite_master WHERE type=\"table\"').all())})"`。
然后停掉 receiver 进程。

- [ ] **Step 3: 验证启动失败保护**

临时把 DB 路径设成不可写位置：
```bash
cd /d/otel && MOSS_TRACE_DB=/nonexistent-dir/x.db node otel-receiver.mjs 2>&1 | head -3
```
Expected: 输出 `FATAL: cannot open SQLite` 并退出（exit 非 0）。验证后正常启动确认无报错。

- [ ] **Step 4: 无 git 提交（非 git）**

直接落盘。

---

### Task 3: 写路径接库（span + session 入库）

**Files:**
- Modify: `D:\otel\otel-receiver.mjs`（`/v1/traces` 与 `/v1/session-summary` 两个 POST handler 内部）

**Interfaces:**
- Consumes: Task 2 的 `insertSpan`/`insertSession`。
- Produces: span/session 同时入内存热缓存与 SQLite。

- [ ] **Step 1: 在 /v1/traces 的 span 循环里加写库**

定位 `/v1/traces` handler 里遍历 span 的循环（现有 `traces.push({...})` 处）。在每条 span push 进内存之后，加 SQLite insert。把现有的 push 块改为同时写库：

在 `traces.push({...})` 之后（同一循环体内）加：
```js
              try {
                insertSpan.run({
                  traceId: span.traceId ?? '',
                  spanId: span.spanId ?? '',
                  parentSpanId: span.parentSpanId || null,
                  name: span.name,
                  service: serviceName,
                  startTime,
                  endTime,
                  duration: endTime - startTime,
                  status: span.status?.code === 2 ? 'error' : 'ok',
                  statusMessage: span.status?.message || null,
                  toolName: attrs.toolName || null,
                  attrs: JSON.stringify(attrs),
                  events: JSON.stringify((span.events ?? []).map((e) => ({
                    name: e.name,
                    time: Number(BigInt(e.timeUnixNano ?? '0') / 1_000_000n),
                  }))),
                });
              } catch (e) {
                console.error('[otel-receiver] span insert failed:', e.message);
              }
```
注意 `startTime`/`endTime` 变量在现有循环里已有（从 `startTimeUnixNano` 解析的毫秒值），复用。

- [ ] **Step 2: 在 /v1/session-summary 加写库**

定位 `/v1/session-summary` handler 里 `sessions.push({...})` 处，在 push 之后加：
```js
        try {
          insertSession.run({
            sessionKey: data.sessionKey || '',
            runId: data.runId || '',
            traceId: data.traceId || '',
            userMessage: data.userMessage || '',
            assistantSummary: data.assistantSummary || '',
            toolsUsed: JSON.stringify(data.toolsUsed || []),
            outcome: data.outcome || 'unknown',
            turns: data.turns || 0,
            toolCalls: data.toolCalls || 0,
            durationMs: data.durationMs || 0,
            tokensIn: data.tokensIn || 0,
            tokensOut: data.tokensOut || 0,
            errorDetail: data.errorDetail || null,
            time: data.time || Date.now(),
          });
        } catch (e) {
          console.error('[otel-receiver] session insert failed:', e.message);
        }
```
注意：现有 push 用 `time: Date.now()`（见原文件 line ~102），写库也用同一时间语义；若 `data.time` 存在优先用它，否则 `Date.now()`。

- [ ] **Step 3: 内存热缓存上限改用 HOT_CACHE**

把现有 `while (traces.length > MAX_TRACES) traces.shift();` 改为 `while (traces.length > HOT_CACHE) traces.shift();`，同理 sessions 的 `MAX_SESSIONS` 轮转改 `HOT_CACHE`。（MAX_TRACES/MAX_SESSIONS 常量可保留作 fallback 或删，本轮统一用 HOT_CACHE。）

- [ ] **Step 4: 手动验证写库**

起 receiver，发一条假 span：
```bash
cd /d/otel && node otel-receiver.mjs &
sleep 1
curl -s -X POST http://localhost:4318/v1/traces -H 'Content-Type: application/json' -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"test"}}]},"scopeSpans":[{"scope":{"name":"x"},"spans":[{"traceId":"abc123","spanId":"sp1","name":"session","startTimeUnixNano":"1000000000","endTimeUnixNano":"2000000000","attributes":[{"key":"runId","value":{"stringValue":"r1"}}]}]}]}]}'
sleep 1
sqlite3 moss-traces.db "SELECT name, service, duration FROM spans WHERE span_id='sp1'"
```
Expected: 输出一行 `session|test|1000`。证明写库通了。然后停 receiver。

---

### Task 4: 读路径改从库读

**Files:**
- Modify: `D:\otel\otel-receiver.mjs`（`/api/traces` 与 `/api/sessions` 两个 handler）

**Interfaces:**
- Consumes: Task 2/3 的 `db`、写好的数据。
- Produces: 面板两个 API 改从 SQLite 读，接口契约（返回 JSON 形状）不变。

- [ ] **Step 1: 改 /api/traces 从库读**

定位 `/api/traces` handler（现有 `const recent = [...traces].reverse().slice(0, 200);` 等）。替换为：
```js
  } else if (req.url.startsWith('/api/traces')) {
    const since = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0);
    const rows = since
      ? db.prepare('SELECT * FROM spans WHERE start_time >= ? ORDER BY start_time DESC LIMIT 200').all(since)
      : db.prepare('SELECT * FROM spans ORDER BY start_time DESC LIMIT 200').all();
    const outTraces = rows.map(r => ({
      name: r.name, startTime: r.start_time, endTime: r.end_time, duration: r.duration,
      service: r.service, traceId: r.trace_id, spanId: r.span_id, parentSpanId: r.parent_span_id || undefined,
      toolName: r.tool_name || undefined, status: r.status, statusMessage: r.status_message,
      attrs: JSON.parse(r.attrs || '{}'),
      events: JSON.parse(r.events || '[]'),
    }));
    const total = db.prepare('SELECT count(*) AS c FROM spans').get().c;
    const errors = db.prepare("SELECT count(*) AS c FROM spans WHERE status='error'").get().c;
    const avgDuration = total > 0
      ? Math.round(db.prepare('SELECT COALESCE(avg(duration),0) AS a FROM spans').get().a)
      : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total, errors, avgDuration, traces: outTraces }));
  }
```
关键：返回对象字段名与面板 JS 期望一致（camelCase：`startTime`/`traceId`/`spanId`/`parentSpanId`/`toolName`/`statusMessage`），即把库的 snake_case 转回 camelCase。

- [ ] **Step 2: 改 /api/sessions 从库读**

定位 `/api/sessions` handler。替换为：
```js
  } else if (req.url === '/api/sessions') {
    const rows = db.prepare('SELECT * FROM sessions ORDER BY time DESC LIMIT 200').all();
    const out = rows.map(r => ({
      sessionKey: r.session_key, runId: r.run_id, traceId: r.trace_id,
      userMessage: r.user_message, assistantSummary: r.assistant_summary,
      toolsUsed: JSON.parse(r.tools_used || '[]'), outcome: r.outcome,
      turns: r.turns, toolCalls: r.tool_calls, durationMs: r.duration_ms,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out, errorDetail: r.error_detail,
      time: r.time,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: out }));
  }
```

- [ ] **Step 3: 手动验证读路径**

（接 Task 3 Step 4 已有 sp1 数据）起 receiver，curl 两个 API：
```bash
cd /d/otel && node otel-receiver.mjs &
sleep 1
curl -s http://localhost:3000/api/traces | head -c 300
echo
curl -s http://localhost:3000/api/sessions | head -c 300
```
Expected: `/api/traces` 返回的 JSON 含 `"name":"session"` 且字段是 camelCase；`/api/sessions` 返回 `{"sessions":[]}`（除非也发了会话摘要）。面板字段形状与改前一致。停 receiver。

---

### Task 5: 清理定时器 + 退出 flush

**Files:**
- Modify: `D:\otel\otel-receiver.mjs`（文件末尾，两个 server.listen 之后）

**Interfaces:**
- Consumes: Task 2 的 `db`、`RETENTION_DAYS`。
- Produces: 超期数据被周期清理；进程退出时 db.close() 刷盘。

- [ ] **Step 1: 加清理定时器**

在文件末尾（最后一个 `}).listen(PORT, ...)` 之后）加：
```js
// ── Retention cleanup ───────────────────────────────────────────────────────
function cleanupOld() {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    const s = db.prepare('DELETE FROM spans WHERE start_time < ?').run(cutoff);
    const t = db.prepare('DELETE FROM sessions WHERE time < ?').run(cutoff);
    if (s.changes || t.changes) {
      console.log(`[otel-receiver] cleanup: ${s.changes} spans, ${t.changes} sessions removed (>${RETENTION_DAYS}d)`);
    }
  } catch (e) {
    console.error('[otel-receiver] cleanup failed:', e.message);
  }
}
setInterval(cleanupOld, 60 * 60 * 1000); // hourly
cleanupOld(); // run once on startup

process.on('SIGINT', () => { try { db.close(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { db.close(); } catch {} process.exit(0); });
```

- [ ] **Step 2: 验证清理逻辑**

起 receiver，临时设保留期 0 天 + 插一条老数据：
```bash
cd /d/otel && MOSS_TRACE_RETENTION_DAYS=0 node otel-receiver.mjs &
sleep 1
sqlite3 moss-traces.db "INSERT OR REPLACE INTO spans (trace_id,span_id,name,start_time,end_time,duration,status,attrs,events) VALUES('old','old1','session',1,2,1,'ok','{}','[]')"
sleep 2   # 等启动时 cleanupOld() 跑过
sqlite3 moss-traces.db "SELECT count(*) AS c FROM spans WHERE span_id='old1'"
```
Expected: 输出 `0`（老数据被启动时那次 cleanup 删了）。停 receiver，**删除测试 db**：`rm moss-traces.db moss-traces.db-*`（清掉测试残留，下一步用干净库）。

- [ ] **Step 3: 无 git 提交（非 git）**

直接落盘。

---

### Task 6: README 补持久化说明

**Files:**
- Modify: `D:\otel\README.md`（后端 A 段内）

**Interfaces:**
- Consumes: Task 1-5 的实际行为（DB 路径/保留期/环境变量）。
- Produces: 后端 A 段说明持久化特性。

- [ ] **Step 1: 在后端 A 段补持久化说明**

定位 `D:\otel\README.md` 的"后端 A：自写 OTLP 收器 + 面板"段。在该段末尾（"零依赖..."那句之后，或紧随其下）追加：
```markdown
### 持久化

receiver 把 span/会话写入本地 SQLite（`D:\otel\moss-traces.db`），**重启不丢**，面板可查历史。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `MOSS_TRACE_DB` | `D:\otel\moss-traces.db` | SQLite 文件路径 |
| `MOSS_TRACE_RETENTION_DAYS` | `14` | 保留天数，超过自动删 |
| `MOSS_TRACE_HOT_CACHE` | `500` | 内存热缓存条数（面板快读） |

首次启动前需 `cd D:\otel && npm install`（装 better-sqlite3）。每小时自动清理超期数据。
```

- [ ] **Step 2: 检查文档与代码一致**

对照 `otel-receiver.mjs` 里 Task 2 的默认值（`MOSS_TRACE_DB`/`MOSS_TRACE_RETENTION_DAYS`/`MOSS_TRACE_HOT_CACHE` 的 fallback），确认 README 表格三者一致。不一致则改文档对齐代码。

- [ ] **Step 3: 无 git 提交（非 git）**

直接落盘。

---

### Task 7: 端到端验证（含重启不丢）

**Files:**
- 无文件改动，仅运行验证。

**Interfaces:**
- Consumes: Task 1-6 全部。
- Produces: 验收清单全部打勾，证明持久化生效。

- [ ] **Step 1: 干净起步**

```bash
cd /d/otel && rm -f moss-traces.db moss-traces.db-*   # 清测试残留
node otel-receiver.mjs &
sleep 1
```
Expected: receiver 启动，新建空库，无报错。

- [ ] **Step 2: 发数据 + 面板可见**

发一条 span + 一条会话摘要：
```bash
curl -s -X POST http://localhost:4318/v1/traces -H 'Content-Type: application/json' -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"moss"}}]},"scopeSpans":[{"scope":{"name":"x"},"spans":[{"traceId":"t1","spanId":"s1","name":"session","startTimeUnixNano":"1000000000","endTimeUnixNano":"2000000000","attributes":[{"key":"runId","value":{"stringValue":"r1"}}]}]}]}]}'
curl -s -X POST http://localhost:4318/v1/session-summary -H 'Content-Type: application/json' -d '{"sessionKey":"k1","runId":"r1","traceId":"t1","userMessage":"hi","assistantSummary":"hello","toolsUsed":["bash"],"outcome":"completed","turns":1,"toolCalls":1,"durationMs":100,"tokensIn":10,"tokensOut":20}'
sleep 1
curl -s http://localhost:3000/api/traces | grep -o '"name":"session"'
curl -s http://localhost:3000/api/sessions | grep -o '"userMessage":"hi"'
```
Expected: 两条 grep 都有匹配（面板能从库读到数据）。

- [ ] **Step 3: 重启不丢（核心）**

停掉 receiver，重启，再查：
```bash
kill %1 2>/dev/null; sleep 1
cd /d/otel && node otel-receiver.mjs &
sleep 1
curl -s http://localhost:3000/api/traces | grep -o '"name":"session"'
curl -s http://localhost:3000/api/sessions | grep -o '"userMessage":"hi"'
```
Expected: 重启后两条 grep **仍有匹配**——数据从 SQLite 恢复，不丢。这是本轮核心卖点。

- [ ] **Step 4: SQLite 直查（辅助）**

```bash
sqlite3 /d/otel/moss-traces.db "SELECT count(*) FROM spans; SELECT count(*) FROM sessions;"
```
Expected: 两个 count 都 ≥1。

- [ ] **Step 5: 验收清单核对**

逐项确认：
- [ ] `D:\otel` 有 package.json 含 better-sqlite3，npm install 成功
- [ ] receiver 启动建出 moss-traces.db + 两表 + 索引
- [ ] span/session 入库，面板从库读显示正常
- [ ] **重启 receiver 后历史数据仍在**（核心，Step 3 已证）
- [ ] 14 天清理逻辑存在且可配（Task 5 Step 2 已证）
- [ ] `D:\otel\README.md` 补持久化说明
- [ ] 手动端到端冒烟通过（Step 2-3）

- [ ] **Step 6: 收尾**

停掉 receiver（`kill %1`），清理测试 db（`rm -f /d/otel/moss-traces.db*`）或保留作真实起点（按用户意愿，默认保留——这是真实库不是测试残留）。向用户报告 7 任务完成情况与验收状态。

---

## Self-Review 已完成

对照 spec 逐条：
- §4.1 package.json → Task 1 ✅
- §4.2.1 SQLite 初始化+建表 → Task 2 ✅
- §4.2.2/4.2.3 写路径 → Task 3 ✅
- §4.2.4 读路径 → Task 4 ✅
- §4.2.5 清理定时器 → Task 5 ✅
- §4.2.6 退出 flush → Task 5 ✅
- §4.3 README → Task 6 ✅
- §八 测试与验证（端到端+直查+清理验证，不新建测试框架）→ Task 7 ✅
- §九 改动清单三文件 → Task 1/2-5/6 ✅
- §十 验收清单 → Task 7 Step 5 ✅

无占位符；字段名（snake_case 库列 / camelCase 接口）一致；环境变量名全文统一；scope 聚焦持久化单一目标。
