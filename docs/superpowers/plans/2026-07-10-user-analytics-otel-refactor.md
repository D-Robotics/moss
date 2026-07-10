# User Analytics OTel 重构 + 测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于现有 tracing 基础设施，将 user-analytics 从自定义事件收集器重构为 Span 数据后处理器（TraceFileExporter），并在 Agent 循环中新增 tool.execute 和 session 级别的 Span。

**Architecture:** 新增 TraceFileExporter 将 Span 序列化为 JSONL 写入 `.moss/analytics/traces.jsonl`；tracing.ts 新增 `enableLocalTracing()` 便捷方法；删除死代码 user-analytics.ts；在 execute-tool-call.ts 和 moss-agent.ts 中新增 withSpan 包裹。

**Tech Stack:** TypeScript, Node.js fs/promises, Vitest, Moss 现有 tracing.ts

## Global Constraints

- Node.js >= 22.16
- 默认不启用，零开销（noop tracer）
- 采集层永不抛出异常影响 Agent 运行
- 测试文件放在 `__tests__/observability/`（gitignore 排除）
- ESM 模块，import 使用 `.js` 扩展名

---

### Task 1: 创建 TraceFileExporter

**Files:**
- Create: `packages/moss-agent/src/observability/trace-exporter.ts`

**Interfaces:**
- Produces: `TraceFileExporter` class, `SerializedSpan` interface

- [ ] **Step 1: 创建文件并实现完整代码**

```ts
/**
 * TraceFileExporter — serializes TraceSpans to a local JSONL file.
 *
 * Default: no-op until init() is called. When enabled, spans are buffered in
 * memory and flushed to .moss/analytics/traces.jsonl every 30 seconds.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

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

export class TraceFileExporter {
  private enabled = false;
  private buffer: SerializedSpan[] = [];
  private analyticsDir: string | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  init(workspaceDir: string): void {
    this.enabled = true;
    this.analyticsDir = path.join(workspaceDir, '.moss', 'analytics');
    this.flushTimer = setInterval(() => this.flush(), 30_000);
  }

  exportSpan(span: SerializedSpan): void {
    if (!this.enabled) return;
    this.buffer.push(span);
  }

  async flush(): Promise<void> {
    if (!this.enabled || !this.analyticsDir || this.buffer.length === 0) return;
    try {
      await fs.mkdir(this.analyticsDir, { recursive: true });
      const file = path.join(this.analyticsDir, 'traces.jsonl');
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

  /** Read aggregated stats from the JSONL file (for CLI reporting). */
  async getStats(): Promise<TraceStats> {
    if (!this.analyticsDir) return emptyStats();
    const file = path.join(this.analyticsDir, 'traces.jsonl');
    let lines: string[];
    try {
      const content = await fs.readFile(file, 'utf-8');
      lines = content.split('\n').filter(Boolean);
    } catch {
      return emptyStats();
    }

    const stats: TraceStats = {
      totalSpans: 0,
      totalErrors: 0,
      errorRate: 0,
      byName: {},
      toolSpans: [],
    };

    for (const line of lines) {
      try {
        const span: SerializedSpan = JSON.parse(line);
        stats.totalSpans++;
        if (span.status === 'error') stats.totalErrors++;

        const name = span.name;
        if (!stats.byName[name]) {
          stats.byName[name] = { count: 0, errors: 0, avgDurationMs: 0 };
        }
        const entry = stats.byName[name];
        entry.count++;
        if (span.status === 'error') entry.errors++;
        const duration = span.endTime - span.startTime;
        entry.avgDurationMs =
          (entry.avgDurationMs * (entry.count - 1) + duration) / entry.count;

        if (name === 'tool.execute') {
          const toolName = String(span.attributes.toolName || 'unknown');
          let toolEntry = stats.toolSpans.find((t) => t.toolName === toolName);
          if (!toolEntry) {
            toolEntry = { toolName, count: 0, errors: 0, avgDurationMs: 0 };
            stats.toolSpans.push(toolEntry);
          }
          toolEntry.count++;
          if (span.status === 'error') toolEntry.errors++;
          toolEntry.avgDurationMs =
            (toolEntry.avgDurationMs * (toolEntry.count - 1) + duration) / toolEntry.count;
        }
      } catch {
        // Skip corrupted lines
      }
    }

    stats.errorRate = stats.totalSpans > 0 ? stats.totalErrors / stats.totalSpans : 0;
    stats.toolSpans.sort((a, b) => b.count - a.count);
    return stats;
  }
}

function emptyStats(): TraceStats {
  return { totalSpans: 0, totalErrors: 0, errorRate: 0, byName: {}, toolSpans: [] };
}

/** Global singleton */
export const globalTraceExporter = new TraceFileExporter();
```

- [ ] **Step 2: 提交**

```bash
git add packages/moss-agent/src/observability/trace-exporter.ts
git commit -m "feat: add TraceFileExporter for Span-to-JSONL persistence"
```

---

### Task 2: 编写 trace-exporter 测试

**Files:**
- Create: `packages/moss-agent/__tests__/observability/trace-exporter.test.ts`

**Interfaces:**
- Consumes: `TraceFileExporter` from Task 1, `SerializedSpan` from Task 1

- [ ] **Step 1: 创建测试文件**

```ts
/**
 * Tests for trace-exporter.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TraceFileExporter, type SerializedSpan } from '../../src/observability/trace-exporter.js';

let workspaceDir: string;
let exporter: TraceFileExporter;

function makeSpan(overrides: Partial<SerializedSpan> = {}): SerializedSpan {
  return {
    name: 'tool.execute',
    startTime: Date.now() - 100,
    endTime: Date.now(),
    attributes: { toolName: 'write_file', runId: 'test-1' },
    events: [],
    status: 'ok',
    ...overrides,
  };
}

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-exporter-test-'));
  exporter = new TraceFileExporter();
});

afterEach(async () => {
  await exporter.cleanup();
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('TraceFileExporter', () => {
  describe('init', () => {
    it('初始化后 enabled', () => {
      exporter.init(workspaceDir);
      // exportSpan should not throw when enabled
      exporter.exportSpan(makeSpan());
    });
  });

  describe('exportSpan + flush', () => {
    it('flush 后 JSONL 文件存在且格式正确', async () => {
      exporter.init(workspaceDir);
      exporter.exportSpan(makeSpan({ name: 'tool.execute', attributes: { toolName: 'read_file', runId: 'r1' } }));
      exporter.exportSpan(makeSpan({ name: 'agent.llm_turn', attributes: { model: 'deepseek', runId: 'r1' } }));

      await exporter.flush();

      const file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0]);
      expect(first.name).toBe('tool.execute');
      expect(first.attributes.toolName).toBe('read_file');
      expect(first.status).toBe('ok');
    });

    it('error 状态的 Span 正常记录', async () => {
      exporter.init(workspaceDir);
      exporter.exportSpan(makeSpan({ status: 'error', statusMessage: 'timeout' }));

      await exporter.flush();

      const file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
      const content = await fs.readFile(file, 'utf-8');
      const span = JSON.parse(content.trim());
      expect(span.status).toBe('error');
      expect(span.statusMessage).toBe('timeout');
    });
  });

  describe('未启用时', () => {
    it('不调用 init 时 exportSpan 不写文件', async () => {
      exporter.exportSpan(makeSpan());
      await exporter.flush();

      const file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
      await expect(fs.access(file)).rejects.toThrow();
    });
  });

  describe('cleanup', () => {
    it('cleanup 后停止定时器并 flush 剩余数据', async () => {
      exporter.init(workspaceDir);
      exporter.exportSpan(makeSpan());

      await exporter.cleanup();

      // Data should be flushed during cleanup
      const file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
      const content = await fs.readFile(file, 'utf-8');
      expect(content.trim()).toBeTruthy();
    });
  });

  describe('getStats', () => {
    it('空文件返回空统计', async () => {
      exporter.init(workspaceDir);
      await exporter.flush();

      const stats = await exporter.getStats();
      expect(stats.totalSpans).toBe(0);
      expect(stats.totalErrors).toBe(0);
    });

    it('有数据时返回正确的聚合统计', async () => {
      exporter.init(workspaceDir);
      const now = Date.now();
      exporter.exportSpan({ name: 'tool.execute', startTime: now - 200, endTime: now, attributes: { toolName: 'write_file' }, events: [], status: 'ok' });
      exporter.exportSpan({ name: 'tool.execute', startTime: now - 100, endTime: now, attributes: { toolName: 'write_file' }, events: [], status: 'error', statusMessage: 'fail' });
      exporter.exportSpan({ name: 'agent.llm_turn', startTime: now - 300, endTime: now, attributes: {}, events: [], status: 'ok' });

      await exporter.flush();
      const stats = await exporter.getStats();

      expect(stats.totalSpans).toBe(3);
      expect(stats.totalErrors).toBe(1);
      expect(stats.errorRate).toBeCloseTo(1 / 3);
      expect(stats.byName['tool.execute'].count).toBe(2);
      expect(stats.byName['tool.execute'].errors).toBe(1);
      expect(stats.byName['agent.llm_turn'].count).toBe(1);

      expect(stats.toolSpans.length).toBe(1);
      expect(stats.toolSpans[0].toolName).toBe('write_file');
      expect(stats.toolSpans[0].count).toBe(2);
      expect(stats.toolSpans[0].errors).toBe(1);
    });

    it('损坏的 JSONL 行跳过不报错', async () => {
      exporter.init(workspaceDir);
      const file = path.join(workspaceDir, '.moss', 'analytics', 'traces.jsonl');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, 'not valid json\n{"name":"ok","startTime":1,"endTime":2,"attributes":{},"events":[],"status":"ok"}\n', 'utf-8');

      const stats = await exporter.getStats();
      expect(stats.totalSpans).toBe(1); // corrupted line skipped
    });
  });
});
```

- [ ] **Step 2: 运行测试验证通过**

```bash
npx vitest run __tests__/observability/trace-exporter.test.ts --config __tests__/vitest.config.ts --root __tests__
```
Expected: 10 tests PASS

- [ ] **Step 3: 提交**

```bash
git add packages/moss-agent/__tests__/observability/trace-exporter.test.ts
git commit -m "test: add TraceFileExporter tests"
```

---

### Task 3: 修改 tracing.ts 添加 enableLocalTracing()

**Files:**
- Modify: `packages/moss-agent/src/observability/tracing.ts`
- Test: `packages/moss-agent/__tests__/observability/tracing.test.ts` (create)

**Interfaces:**
- Consumes: `TraceFileExporter` from Task 1, `TraceRegistry` from tracing.ts (existing)
- Produces: `enableLocalTracing(workspaceDir: string): void`

- [ ] **Step 1: 在 tracing.ts 末尾添加 enableLocalTracing**

在 `packages/moss-agent/src/observability/tracing.ts` 末尾追加：

```ts
import { globalTraceExporter, type SerializedSpan } from './trace-exporter.js';

/**
 * Enable local file-based tracing. Spans are written to
 * .moss/analytics/traces.jsonl. Call once at session start.
 * Default is no-op (zero overhead). Call cleanup() on the
 * globalTraceExporter at session end.
 */
export function enableLocalTracing(workspaceDir: string): void {
  globalTraceExporter.init(workspaceDir);
  defaultTraceRegistry.setTracer({
    startSpan(name, attributes, parent) {
      const startTime = Date.now();
      const events: SerializedSpan['events'] = [];
      let status: SerializedSpan['status'] = 'ok';
      let statusMessage: string | undefined;

      return {
        setAttribute() {},
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
            attributes: attributes ?? {},
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

- [ ] **Step 2: 创建 tracing 补充测试**

创建 `packages/moss-agent/__tests__/observability/tracing.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { enableLocalTracing, withSpan, setTracer } from '../../src/observability/tracing.js';
import { globalTraceExporter } from '../../src/observability/trace-exporter.js';

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'moss-tracing-test-'));
});

afterEach(async () => {
  await globalTraceExporter.cleanup();
  // Reset to noop
  setTracer({
    startSpan: () => ({
      setAttribute() {},
      addEvent() {},
      setStatus() {},
      end() {},
    }),
  });
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

describe('enableLocalTracing', () => {
  it('启用后 withSpan 产生 Span 数据', async () => {
    enableLocalTracing(workspaceDir);

    await withSpan('test.span', { key: 'value' }, async (span) => {
      span.addEvent('midpoint', { step: 1 });
    });

    await globalTraceExporter.flush();
    const stats = await globalTraceExporter.getStats();
    expect(stats.totalSpans).toBe(1);
    expect(stats.byName['test.span'].count).toBe(1);
  });

  it('启用后 error Span 正确记录', async () => {
    enableLocalTracing(workspaceDir);

    try {
      await withSpan('test.error_span', {}, async () => {
        throw new Error('boom');
      });
    } catch {
      // expected
    }

    await globalTraceExporter.flush();
    const stats = await globalTraceExporter.getStats();
    expect(stats.totalSpans).toBe(1);
    expect(stats.totalErrors).toBe(1);
  });
});
```

- [ ] **Step 3: 运行测试**

```bash
npx vitest run __tests__/observability/ --config __tests__/vitest.config.ts --root __tests__
```
Expected: 12 tests PASS (10 from Task 2 + 2 from Task 3)

- [ ] **Step 4: 提交**

```bash
git add packages/moss-agent/src/observability/tracing.ts packages/moss-agent/__tests__/observability/tracing.test.ts
git commit -m "feat: add enableLocalTracing() to tracing layer"
```

---

### Task 4: 更新导出 + 删除 user-analytics.ts

**Files:**
- Modify: `packages/moss-agent/src/observability/index.ts`
- Delete: `packages/moss-agent/src/observability/user-analytics.ts`

**Interfaces:**
- Consumes: `TraceFileExporter`, `SerializedSpan`, `TraceStats`, `globalTraceExporter` from Task 1
- Consumes: `enableLocalTracing` from Task 3
- Removes: all `user-analytics.ts` exports

- [ ] **Step 1: 更新 observability/index.ts**

将 `packages/moss-agent/src/observability/index.ts` 中的 user-analytics 导出块替换为：

```ts
// Trace exporter (local file-based Span persistence)
export {
  TraceFileExporter,
  globalTraceExporter,
} from './trace-exporter.js';
export type {
  SerializedSpan,
  TraceStats,
} from './trace-exporter.js';
```

同时删除原有的 user-analytics 导出块（lines 23-36）。

- [ ] **Step 2: 删除 user-analytics.ts**

```bash
rm packages/moss-agent/src/observability/user-analytics.ts
```

- [ ] **Step 3: 验证编译**

```bash
npx tsc --noEmit -p packages/moss-agent/tsconfig.json
```

- [ ] **Step 4: 运行全部测试确认无回归**

```bash
npx vitest run __tests__/ --config __tests__/vitest.config.ts --root __tests__
```

- [ ] **Step 5: 提交**

```bash
git add packages/moss-agent/src/observability/index.ts
git rm packages/moss-agent/src/observability/user-analytics.ts
git commit -m "refactor: replace user-analytics with trace-exporter; update exports"
```

---

### Task 5: 在 execute-tool-call.ts 中添加 tool.execute Span

**Files:**
- Modify: `packages/moss-agent/src/core/tools/execute-tool-call.ts`

**Interfaces:**
- Consumes: `withSpan` from tracing.ts (existing), `toolAttributes` from tracing.ts (existing)

- [ ] **Step 1: 添加 import**

在 `packages/moss-agent/src/core/tools/execute-tool-call.ts` 顶部已有 import 区域追加：

```ts
import { withSpan, toolAttributes } from '../../observability/tracing.js';
```

- [ ] **Step 2: 用 withSpan 包裹工具执行**

在 `executeOneToolCall` 函数中，将 lines 340-511（从 `const startMs = Date.now()` 到 `return` 语句）包裹在 `withSpan` 中。

找到 line 341-342：
```ts
const startMs = Date.now();
let text = '';
```

改为：
```ts
const startMs = Date.now();
let text = '';
let errFlag = false;

// ... 紧接在 let startMs = Date.now() 之后，用 withSpan 包裹整个执行逻辑
```

具体做法：将 lines 340-511 的执行逻辑提取到 withSpan 回调中，不改变原有逻辑。

在 `executeOneToolCall` 的 return 之前（line 541-548），计算 duration 时使用 Span 记录的时间。

简化的做法——在 `const startMs = Date.now()` 后立即包裹：

```ts
const startMs = Date.now();
const runId = deps.sessionKey; // 使用 sessionKey 作为 runId
const outcome = await withSpan(
  'tool.execute',
  toolAttributes(runId, call.name, call.id),
  async (span) => {
    // ... 原有的 lines 341-511 逻辑全部移入这里
    
    // 在 finally 或 return 前设置 span 属性
    span.setAttribute('success', !errFlag);
    span.setAttribute('durationMs', Date.now() - startMs);
    if (errFlag) {
      span.setStatus(false, text);
    }
    
    return { ... }; // 原有的返回结构
  }
);
```

**注意**：这是关键改动，需要仔细重构。保持原有重试逻辑、心跳、超时、abort 的完整行为不变。

- [ ] **Step 3: 运行测试**

```bash
npx vitest run __tests__/ --config __tests__/vitest.config.ts --root __tests__
```
Expected: 所有已有测试 PASS + 确认无回归

- [ ] **Step 4: 提交**

```bash
git add packages/moss-agent/src/core/tools/execute-tool-call.ts
git commit -m "feat: add tool.execute span to executeOneToolCall"
```

---

### Task 6: 在 moss-agent.ts 中添加 session Span

**Files:**
- Modify: `packages/moss-agent/src/core/agent/moss-agent.ts`

**Interfaces:**
- Consumes: `withSpan` from tracing.ts (existing)

- [ ] **Step 1: 添加 import**

在 `packages/moss-agent/src/core/agent/moss-agent.ts` 已有 import 区域追加：

```ts
import { withSpan } from '../../observability/tracing.js';
```

- [ ] **Step 2: 用 withSpan 包裹 run 方法**

在 `MossAgent.run()` 方法中，将整个 run 逻辑包裹在 `withSpan('session', ...)` 中。

找到 run 方法的主体（约 line 828 之后），在 `const runId = options?.runId ?? crypto.randomUUID();` 之后包裹：

```ts
const runId = options?.runId ?? crypto.randomUUID();

const modelId = this.config.modelId ?? 'default';
const result = await withSpan(
  'session',
  { runId, model: modelId },
  async (span) => {
    span.addEvent('start', { sessionKey });
    
    // ... 原有的 run 方法主体逻辑
    
    span.addEvent('end', { outcome: outcome ?? 'completed' });
    return { ... }; // 原有的返回值
  }
);

return result;
```

- [ ] **Step 3: 运行全部测试**

```bash
npx vitest run __tests__/ --config __tests__/vitest.config.ts --root __tests__
```
Expected: 所有已有测试 PASS

- [ ] **Step 4: 提交**

```bash
git add packages/moss-agent/src/core/agent/moss-agent.ts
git commit -m "feat: add session span to MossAgent.run()"
```

---

### Task 7: 最终验证

- [ ] **Step 1: 运行全部测试**

```bash
npx vitest run __tests__/ --config __tests__/vitest.config.ts --root __tests__
```
Expected: 全部 PASS

- [ ] **Step 2: 类型检查**

```bash
npx tsc --noEmit -p packages/moss-agent/tsconfig.json
```
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: final verification — all tests pass, typecheck clean"
```