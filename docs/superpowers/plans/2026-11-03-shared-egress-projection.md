# Shared egress projection implementation plan

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SDK 工具结果和远程压缩请求建立有界、跨字段的安全投影，保留可验证的正常数据，并使无法完成检查的输出关闭。

**Architecture:** 先从不可信数据建立有界的自有数据属性快照，再在一个投影范围内收集带来源的敏感值，最后使用相同上下文构造新输出。SDK 工具结果与一次远程压缩请求各有独立作用域；不向全局秘密缓存登记临时发现的值，也不把输入对象或其可覆盖方法带过边界。

**Tech Stack:** TypeScript / ESM、Node.js 22、现有 `node:test`、Moss SDK 测试和仅监听 `127.0.0.1` 的 HTTP fixture；不新增依赖。

---

## 范围、事实与边界

基线是独立 worktree 的 `060b94839341cdc5cd16198d5ada423cb16faa04`。五项问题目前来自静态复审，执行者必须先用下列 fixture 在此基线上观察红灯；如果某一 fixture 已通过，应记录实际结果并调整测试数据，不能把它报告为修复前已复现。所有值均为合成数据；不得使用真实 key、非回环 mock 服务器，也不得重试或转交先前被自动审批拒绝的动态 Node 探针。

本机执行前将 Node 22 放在 `PATH` 首位并确认版本；其他平台使用本机的 Node 22 路径。后续各阶段的 `npm` 命令均在指定隔离 worktree 中执行：

```sh
export PATH=/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
node --version
```

| 入口和消费者 | 当前实际数据                                                                                                                                                                                                                                                                                            | 本计划的信任和输出约束                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 工具执行 | `executeStructured()` 返回 `content` 与 `isError`，或抛出 `MossError` / 其他错误；普通工具返回文本。post-tool / post-failure hook 可替换结果文本。工具还可通过 `reportProtectedPathChanges` 报告路径和原因。                                                                                            | 工具结果、错误、结构化块和报告视为不可信数据；宿主 hook 是能看到原始结果的同进程受信代码，不属于沙箱。快照须早于读取块的 `type` / `text`、读取错误详情和展开路径报告。                            |
| SDK 消费者   | `recordToolOutcome` 发出 `tool_execution_end`；`MossAgent` 据此先调用 `onToolResult(call, result)`，adapter 再发出 `tool_end`。`tool_end` 还可能含 `protectedPathChanges`。会话的 `tool_result` 保存文本与结构化内容，不保存该事件的 `MossError`。                                                      | 在 `tool_execution_end` 之前完成投影；`onToolResult` 的结果、`tool_end`、内存会话和后续模型可见的工具结果只引用投影副本。不得通过 hook 后的旧块恢复原文。                                         |
| 远程压缩输入 | `HttpRemoteCompactProvider.compact` 接收 `messages`、可选 `systemPrompt` / `model` / `customInstructions`、token 限额和 `abortSignal`；POST body 使用 `messages`、`system_prompt`、`model`、`custom_instructions` 及两个数值限额。配置的 API key 作为目标服务的 `Authorization`，是有意发送的服务凭据。 | 对完整 POST body 的字符串和结构使用一次共享发现上下文；`abortSignal` 是宿主控制对象，不序列化。压缩入口先快照，不能信任调用者的 `map`、迭代器或对象访问器。                                       |
| 远程压缩输出 | 远端返回 `summary`、可选 `compacted_messages`、`tokens_saved`；当前只检查 summary 非空和消息为数组。`hybridCompact` 可把 summary 转成会话消息。                                                                                                                                                         | 远端响应是外部输入；本计划不承诺它已防 prompt injection，也不声称本计划已验证其所有字段。响应验证另属后续任务。                                                                                   |
| 其他边界     | `tool_execution_start` 的 `args` 在工具执行前发出，`onToolResult` 的 `call.input` 也携带输入；已有持久记录可能只有掩码。`hybridCompact` 先估算 token，远程错误会调用 `localSummarize`，该函数可能调用外部模型。                                                                                         | 本计划可读取输入中的已分类秘密用于保护结果，但不改变 `tool_start` / `call.input` 的公开语义，也不追溯清理历史。投影失败的本次压缩不得 POST 或触发摘要回退；不能据此声称后续普通模型调用已被阻止。 |

保留原有权威规则：显式 `content` 字符串包括空串均优先于旧 `structuredContent.text`；宿主 hook 即使返回相同文本，只要显式返回 `{ result }`，旧结构化块也不复活。正常资源保留 URI、名称、MIME 和与可见正文一致的文本；正常 SDK 图片保留其数据和可安全投影的元数据。远程压缩继续省略图片数据，并只允许与权威正文一致的结构化文本。

## 交付切分与文件职责

**首阶段 A：安全快照与失败路径。** 独立交付数组方法覆盖、访问器、预算和安全回退；不声称四项内容识别问题已解决。SDK 投影失败时返回固定占位结果、标记结果错误，并明确只表示结果无法安全呈现，不能声称工具未执行；抛出错误的安全 code / cause 类型在可证明安全时保留。远程投影失败抛内部安全错误，不发送该请求的 POST，同次压缩不调用摘要模型。

**阶段 B：共享发现与投影。** 在 A 的快照上实现跨字段传播，覆盖其余四项及正向兼容，完成五项回归。两个阶段分别可构建、运行聚焦测试并交付；阶段 B 不以“修了 A”为由跳过自身红灯。

**后续独立范围：** 工具开始事件和 `call.input`、历史记录迁移、压缩返回值的语义校验、普通模型请求和压缩失败后 agent 是否继续下一轮。这些都不由 A/B 的结果出口保证；若产品要求全局不外发，需另立契约和测试。

计划改动文件，均为后续实现范围，当前计划提交不修改它们：

- 新建 `src/safety/egress-projection.ts`：内部快照、预算、临时发现上下文、明确的投影失败类型；不从 `src/index.ts` 导出。
- 修改 `src/safety/tool-output-redact.ts`、`src/safety/secret-sanitizer.ts` 和必要时 `src/safety/known-secrets.ts`：复用现有识别规则并让检测器报告实际识别值 / 来源；保留原有文本 API。
- 修改 `src/core/tools/execute-tool-call.ts`：在首次读取不可信结构前取快照、收集并投影文本 / 结构 / 错误 / 路径报告；只输出安全副本。
- 修改 `src/context/remote-compaction.ts` 和 `src/context/compaction.ts`：请求快照、共享投影和安全失败穿透；远程不可用等普通错误沿用既有回退。
- 修改 `test/security-tool-redaction.spec.mjs`、`test/remote-compaction-redaction.spec.mjs` 及已有相关 compaction 测试；修改 `CHANGELOG.md` 记录 0.x 语义和迁移。

## 固定契约与资源预算

内部接口使用以下形状；具体实现不能把临时秘密放进错误、日志或公开事件：

```ts
export type ProjectionFailure = 'accessor' | 'cycle' | 'limit' | 'unsupported';
export type SnapshotValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SnapshotValue[]
  | { [key: string]: SnapshotValue };
export type SnapshotResult =
  | { ok: true; value: SnapshotValue }
  | { ok: false; reason: ProjectionFailure };

export interface DiscoveryContext {
  readonly values: Set<string>;
  incomplete: boolean;
  matchUnits: number;
}

export function snapshotProjectionInput(input: unknown): SnapshotResult;
export function discoverEgressValues(input: SnapshotValue, context: DiscoveryContext): void;
export function projectEgressValue(input: SnapshotValue, context: DiscoveryContext): SnapshotValue;
```

- 使用每次调用独立的 `WeakMap` 区分共享引用和真正的递归环；普通对象使用自有数据属性，数组使用自有 `length` 与每个索引的数据描述符；稀疏数组按原位置保留空槽，不能读取原型上的值。拒绝访问器、循环、无法复制的值和抛错的描述符操作；`Error` 使用其自有 `message`、`stack`、`cause` 和受限字段专门复制。非文本二进制、函数和 symbol 不作为原引用放入投影。`SnapshotValue` 是无原型行为的数据模型，调用处校验各自 schema 后才恢复 `Message`、`MossError` 等具体类型，不将快照直接断言为原始泛型。
- 初始上限为深度 16、每个数组 10,000 项、总节点 100,000、总字符串和键 8,388,608 个 UTF-16 code unit、发现值 256 个、单个发现值 16,384 个 code unit、匹配工作量 134,217,728 code unit。计数包含字段名；SDK 图片数据计入总字符串预算。远程已确认的图片数据字段可直接省略，不读取其内容；但字段本身是 accessor 时仍拒绝，未知类型不得借此跳过检查。任一上限命中时整个相关投影失败，不先输出已检查的前半部分。
- 快照及投影同步完成后再发事件或发请求；避免对源值使用 `map`、`flatMap`、`join`、`for...of`、展开运算符、`toJSON` 或 getter。快照保留合法字段的值和数组顺序，输出对象不能继续引用原始对象。描述符操作对 Proxy 仍可能执行 trap；抛错时拒绝，但同进程恶意代码可伪造 trap，不能声称这是代码沙箱。
- 已识别的非空敏感值在当前作用域内去重、按长度从长到短匹配所有自由文本、元数据和动态键。对由明确密码字段或参数发现的短值也传播；它们可能大幅遮盖普通文本，若会破坏必需的协议字段，拒绝整个投影。环境和配置的短值仍遵守现有已知秘密收集策略，不能声称它们都可全局识别。
- 扫描器优先在识别处报告原值、字段和来源。逐段改造 `redactEgress` 的 PEM、已知值、URL、赋值、argv、header 与独立 token 处理；某条现有规则能遮盖但无法给出可靠原值时置 `incomplete`，不得仅以模糊的前后文本 diff 宣称发现完成。已遮盖历史记录无法恢复原值时，隐藏该旧结果中无法验证的元数据，并明确无法保护其他消息中的无标签副本。
- URL 只对查询参数的 form 解释把 `+` 视为空格；路径中的 `+` 保持原意。逐参数处理百分号编码，保留未受影响的原始字符；解析不完整时隐藏整个受影响查询值，不能因同一 URI 中的 `%FF` 漏掉另一段已知值。不要对未知编码无限递归解码。
- `Password ***required***` 按完整 Markdown 强调内容处理，保留正文与正常资源；明确的 `password=***` 和 `[REDACTED]` 仍按已遮盖历史内容保守处理。无法区分的文本是兼容性限制，不是识别保证。
- 已知 gcc / clang 程序的 `-pthread`、`-pipe` 保留；已知 mysql / mariadb / sshpass 的 `-pVALUE` 以及具名密码参数继续遮盖。只有 `args` 而无可信程序名时保守处理 `-pVALUE`，可能误伤普通参数；普通 `lines` 数组不按 argv 解释。

## 阶段 A — 快照、失败与回退

### Task A1：先锁定可覆盖数组和访问器的红灯

**Files:** `test/remote-compaction-redaction.spec.mjs`, `test/security-tool-redaction.spec.mjs`。

- [ ] 在现有远程测试文件中添加以下测试；使用已有 `captureRemoteRequest` 与合成 `fakeToken`：

```js
test('remote message array cannot replace the projected input through map', async () => {
  const messages = [{ role: 'user', timestamp: 0, content: 'ordinary observation' }];
  Object.defineProperty(messages, 'map', {
    value: () => [{ role: 'user', timestamp: 0, content: fakeToken }],
  });
  const received = await captureRemoteRequest(messages);
  assert.equal(JSON.stringify(received).includes(fakeToken), false);
  assert.equal(received.messages[0].content, 'ordinary observation');
});
```

- [ ] 新增同一测试文件内的本地拒绝 helper 和访问器 / 超限测试。helper 必须计数 POST，而不只断言异常：

```js
async function expectProjectionRefusal(messages) {
  let posts = 0;
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') posts += 1;
    for await (const _chunk of request) {
      /* consume only the local request */
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ summary: 'safe summary' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider = new HttpRemoteCompactProvider({
      endpoint: `http://127.0.0.1:${server.address().port}`,
    });
    await assert.rejects(
      provider.compact({ messages, maxOutputTokens: 100, contextWindowTokens: 1000 }),
      (error) => error?.code === 'PROVIDER_UPSTREAM_ERROR' && /projection/i.test(error.message)
    );
    assert.equal(posts, 0);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

test('remote refuses accessor metadata without calling the accessor or posting', async () => {
  let reads = 0;
  const resource = { type: 'resource', uri: 'fixture://safe/guide' };
  Object.defineProperty(resource, 'name', {
    enumerable: true,
    get() {
      reads += 1;
      return opaquePassword;
    },
  });
  await expectProjectionRefusal([
    {
      role: 'user',
      timestamp: 0,
      content: [
        { type: 'tool_result', content: 'ordinary observation', structuredContent: [resource] },
      ],
    },
  ]);
  assert.equal(reads, 0);
});

test('remote refuses an over-budget input before posting', async () => {
  await expectProjectionRefusal([{ role: 'user', timestamp: 0, content: 'x'.repeat(8_388_609) }]);
});
```

- [ ] 在 SDK 测试文件中添加结构化 accessor 红灯。这里验证的是返回值，而不是先前被拒的独立探针：

```js
test('SDK withholds an accessor block before the getter can run', async () => {
  let reads = 0;
  const resource = { type: 'resource', uri: 'fixture://safe/guide' };
  Object.defineProperty(resource, 'name', {
    enumerable: true,
    get() {
      reads += 1;
      return opaquePassword;
    },
  });
  const result = await runTool({
    executeStructured: async () => ({ content: [{ type: 'text', text: 'ok' }, resource] }),
  });
  assert.equal(reads, 0);
  assert.match(result.end.content, /withheld/i);
  assert.equal(result.end.isError, true);
  assert.equal(containsValue(result.events, opaquePassword), false);
  assert.equal(containsValue(result.observed, opaquePassword), false);
  assert.equal(containsValue(result.messages, opaquePassword), false);
});
```

- [ ] 为现有 `runTool` 增加 `transientRetry = false` 参数：该值为 true 时工具元数据设置 `transientRetry: true`，且不要注册 `onBeforeToolExec`，否则审批会禁用工具自动重试。先加下列红灯；这是测试产品自己的重试日志，不是此前被拒的探针：

```js
// Add to existing imports: import { getRootLogger } from '../dist/logger.js';
test('tool transient retry never logs its raw error', async () => {
  const root = getRootLogger();
  const priorLevel = root.getLevel();
  const priorWrite = process.stderr.write;
  let captured = '';
  let attempts = 0;
  root.setLevel('debug');
  process.stderr.write = function (chunk) {
    captured += String(chunk);
    return true;
  };
  try {
    await runTool({
      transientRetry: true,
      executeStructured: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error(`temporarily unavailable ${opaquePassword}`);
        return { content: [{ type: 'text', text: 'recovered' }] };
      },
    });
    assert.equal(attempts, 2);
    assert.equal(captured.includes(opaquePassword), false);
  } finally {
    process.stderr.write = priorWrite;
    root.setLevel(priorLevel);
  }
});
```

- [ ] 补充同样明确断言的变体：`messages`、`content`、`structuredContent`、`thinking` 和 error context 分别覆盖 `map` / `flatMap` / `join` / `Symbol.iterator`；数组索引 accessor、对象 `toJSON`、抛错 Proxy、共享子对象、真正环和每个预算的边界值。正常共享对象应成功，环和超限应关闭；SDK 还覆盖 `reportProtectedPathChanges` 的 getter，确保读取次数为零且 `tool_end` 不含原报告。
- [ ] 在 Node 22、独立 worktree 先运行 `npm run build`，再运行 `npm run test:filter -- --filter security-tool-redaction --filter remote-compaction-redaction`。预期新增的针对当前漏洞的断言失败；逐项记录失败断言，不以导入失败或连接错误冒充红灯。

### Task A2：实现安全快照并在最早读取处接入

**Files:** `src/safety/egress-projection.ts`, `src/core/tools/execute-tool-call.ts`, `src/context/remote-compaction.ts`, `src/context/compaction.ts`。

- [ ] 在内部模块实现上面的 `SnapshotResult`、预算与数据描述符遍历；对不可证明已完整检查的输入返回失败。下列决策必须逐条体现，不能在失败后回退到源对象：

```ts
import { ErrorCode, MossError } from '../errors.js';

export class ProjectionUnsafeError extends MossError {
  constructor() {
    super({
      code: ErrorCode.PROVIDER_UPSTREAM_ERROR,
      message: 'Safe projection could not be completed.',
    });
  }
}

export function requireSnapshot(input: unknown): SnapshotValue {
  const snapshot = snapshotProjectionInput(input);
  if (!snapshot.ok) throw new ProjectionUnsafeError();
  return snapshot.value;
}
```

SDK 在调用处捕获此错误并生成固定的 withheld 结果；远程路径向上传递该错误。

该内部错误不得带原始内容、原错误或 accessor 作为 cause。

- [ ] `executeStructured` 返回后、`textFromStructuredContent` 之前快照内容；错误在读取 `message` / `cause` 之前快照，路径报告在当前 `{ ...c }` 之前快照。失败时 `isError: true`、固定文本 `[tool result withheld by redaction]`，清除结构化块和路径报告；错误对象只含固定消息和安全枚举 code，不保留原始 cause 引用。正常工具执行、hook 替换与 safe cause 原有行为不变。
- [ ] 消除工具重试 debug 消息中的 `rawMsg.slice(...)`；只记录固定文本、重试序号和延迟。保留用原始本地文本判断是否可重试的行为，但不把其内容写入日志。用现有 SDK fixture 的合成临时错误和捕获的日志验证。
- [ ] 在 `HttpRemoteCompactProvider.compact` 对将序列化的 body 建立快照；在 `hybridCompact` 的 token 估算前对消息建立快照；若配置了远程 provider，`compactHistoryIfNeeded` 在消息估算、剪枝和自定义数组方法之前建立快照。控制用 `AbortSignal` 不进快照 body。检查该早期复制导致的对象身份和性能变化，并记录为兼容变化。

### Task A3：安全失败不能落入摘要模型回退

**Files:** `src/safety/egress-projection.ts`, `src/context/remote-compaction.ts`, `src/context/compaction.ts`, `test/remote-compaction-redaction.spec.mjs` 及已有 compaction 测试。

- [ ] 阶段 A2 中的 `ProjectionUnsafeError` 是本任务唯一透传的安全失败类型；不改变普通网络错误的现有回退。

- [ ] 在远程测试中引入 `hybridCompact` 和 `compactHistoryIfNeeded`，并加入以下 loopback 测试。它同时覆盖两层 catch，且不把普通网络失败误认为安全拒绝：

```js
// Extend existing imports:
// import { HttpRemoteCompactProvider, hybridCompact } from '../dist/context/remote-compaction.js';
// import { compactHistoryIfNeeded } from '../dist/context/compaction.js';
// import { ProjectionUnsafeError } from '../dist/safety/egress-projection.js';
test('incomplete projection never falls back to a summarizer', async () => {
  let reads = 0;
  let posts = 0;
  let summaries = 0;
  const resource = { type: 'resource', uri: 'fixture://safe/guide' };
  Object.defineProperty(resource, 'name', {
    enumerable: true,
    get() {
      reads += 1;
      return opaquePassword;
    },
  });
  const messages = [
    {
      role: 'user',
      timestamp: 0,
      content: [{ type: 'tool_result', content: 'ok', structuredContent: [resource] }],
    },
    { role: 'assistant', timestamp: 1, content: 'answer' },
  ];
  const server = createServer(async (request, response) => {
    if (request.method === 'POST') posts += 1;
    for await (const _chunk of request) {
      /* consume only the local request */
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ summary: 'safe summary' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const provider = new HttpRemoteCompactProvider({
      endpoint: `http://127.0.0.1:${server.address().port}`,
    });
    const localSummarize = async () => {
      summaries += 1;
      return 'local summary';
    };
    const isProjectionError = (error) =>
      error?.code === 'PROVIDER_UPSTREAM_ERROR' && /projection/i.test(error.message);
    await assert.rejects(
      hybridCompact(
        {
          remoteProvider: provider,
          localSummarize,
          contextWindowTokens: 1000,
        },
        messages
      ),
      isProjectionError
    );
    await assert.rejects(
      compactHistoryIfNeeded({
        summarize: localSummarize,
        messages,
        contextWindowTokens: 1000,
        forceCompaction: true,
        remoteCompactProvider: provider,
      }),
      isProjectionError
    );
    assert.equal(reads, 0);
    assert.equal(posts, 0);
    assert.equal(summaries, 0);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test('a projection failure from the provider cannot trigger a model fallback', async () => {
  let summaries = 0;
  const remoteProvider = {
    isAvailable: async () => true,
    compact: async () => {
      throw new ProjectionUnsafeError();
    },
  };
  const localSummarize = async () => {
    summaries += 1;
    return 'local summary';
  };
  const messages = [
    { role: 'user', timestamp: 0, content: 'safe input' },
    { role: 'assistant', timestamp: 1, content: 'safe answer' },
  ];
  await assert.rejects(
    hybridCompact(
      {
        remoteProvider,
        localSummarize,
        contextWindowTokens: 1000,
      },
      messages
    ),
    ProjectionUnsafeError
  );
  await assert.rejects(
    compactHistoryIfNeeded({
      summarize: localSummarize,
      messages,
      contextWindowTokens: 1000,
      forceCompaction: true,
      remoteCompactProvider: remoteProvider,
    }),
    ProjectionUnsafeError
  );
  assert.equal(summaries, 0);
});

test('ordinary remote failures still use the existing summarizer fallback', async () => {
  let summaries = 0;
  const result = await hybridCompact(
    {
      remoteProvider: {
        isAvailable: async () => true,
        compact: async () => {
          throw new Error('synthetic connection failure');
        },
      },
      localSummarize: async () => {
        summaries += 1;
        return 'local summary';
      },
      contextWindowTokens: 1000,
    },
    [{ role: 'user', timestamp: 0, content: 'safe input' }]
  );
  assert.equal(result.method, 'local_fallback');
  assert.equal(summaries, 1);
});
```

- [ ] `npm run build` 后运行 `npm run test:filter -- --filter remote-compaction-redaction`；A2 的早期快照可能已使 accessor 例通过，但 provider 抛出 `ProjectionUnsafeError` 的断言应因现有 catch 调用摘要而失败。记录该红灯后再修改 catch。
- [ ] 在 `hybridCompact` 和 `compactHistoryIfNeeded` 的策略 catch 中对 `ProjectionUnsafeError` 直接重新抛出；对连接失败、非 2xx 和普通远程错误保留原有摘要回退。断言普通远程错误仍调用一次现有 fallback，投影失败则不调用。`runCompactionCore` 目前会捕获压缩失败并可能继续 agent loop，本阶段不宣称阻止后续普通模型请求。
- [ ] 更新 `CHANGELOG.md` 的中英文 0.x 说明，先记录阶段 A 已交付的 accessor / 超限降级、结果错误、远程投影失败不触发摘要回退和消息对象身份变化；不要提前声称阶段 B 的识别问题已修复。
- [ ] 重新 build 并运行 A1 的两个过滤测试、现有 compaction 家族过滤测试、`npm run typecheck` 和 `npm run check`；全部通过后阶段 A 才可作为独立交付。核对 `git diff` 仅包含 A 对应文件，并按实际文件逐一暂存；后续实现提交必须保留要求的 Co-Authored-By trailer。

## 阶段 B — 同作用域的发现与投影

### Task B1：先添加五项公开出口红绿测试

**Files:** `test/security-tool-redaction.spec.mjs`, `test/remote-compaction-redaction.spec.mjs`。

- [ ] 在 SDK 测试中加入以下四个测试。它们直接检查 SDK `tool_end`、`onToolResult` 和内存会话；每次修改环境变量都恢复原值。

```js
test('SDK removes a known secret encoded with plus in a query', async () => {
  const secret = 'Synthetic value 482';
  const encoded = 'Synthetic+value+482';
  const previous = process.env.MOSS_TEST_PROJECTION_SECRET;
  process.env.MOSS_TEST_PROJECTION_SECRET = secret;
  try {
    const result = await runTool({
      executeStructured: async () => ({
        content: [
          { type: 'text', text: 'ordinary observation' },
          { type: 'resource', uri: `fixture://guide/?q=${encoded}` },
          { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
        ],
      }),
    });
    for (const output of [result.end, result.observed, result.messages]) {
      assert.equal(containsValue(output, encoded), false);
    }
    assert.ok(result.end.structuredContent.some((block) => block.uri === 'fixture://safe/guide'));
  } finally {
    if (previous === undefined) delete process.env.MOSS_TEST_PROJECTION_SECRET;
    else process.env.MOSS_TEST_PROJECTION_SECRET = previous;
  }
});

test('SDK propagates a resource field secret to other result fields', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: 'ordinary observation' },
        { type: 'resource', uri: `fixture://guide/?token=${opaquePassword}`, name: opaquePassword },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png', alt: opaquePassword },
      ],
    }),
  });
  for (const output of [result.end, result.observed, result.messages]) {
    assert.equal(containsValue(output, opaquePassword), false);
  }
  assert.equal(
    result.end.structuredContent.find((block) => block.type === 'image')?.data,
    'AAECAw=='
  );
});

test('SDK preserves emphasized Markdown and safe resource metadata', async () => {
  const result = await runTool({
    executeStructured: async () => ({
      content: [
        { type: 'text', text: 'Password ***required***' },
        { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
      ],
    }),
  });
  assert.equal(result.end.content, 'Password ***required***');
  assert.ok(
    result.end.structuredContent.some(
      (block) =>
        block.type === 'resource' &&
        block.uri === 'fixture://safe/guide' &&
        block.name === 'safe guide'
    )
  );
});

test('SDK preserves gcc flags in error context', async () => {
  const result = await runTool({
    executeStructured: async () => {
      throw new MossError({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
        message: 'compiler failed safely',
        context: { argv: ['gcc', '-pthread', '-pipe', '-O2'] },
      });
    },
  });
  assert.deepEqual(result.end.error.context.argv, ['gcc', '-pthread', '-pipe', '-O2']);
});
```

- [ ] 在远程测试中加入对应四例。保留同样的合成值和 `try/finally`，直接用现有 `captureRemoteRequest` 验证实际 POST body：

```js
test('remote removes a known secret encoded with plus in a query', async () => {
  const secret = 'Synthetic value 482';
  const encoded = 'Synthetic+value+482';
  const previous = process.env.MOSS_TEST_PROJECTION_SECRET;
  process.env.MOSS_TEST_PROJECTION_SECRET = secret;
  try {
    const received = await captureRemoteRequest([
      {
        role: 'user',
        timestamp: 0,
        content: [
          {
            type: 'tool_result',
            content: 'ordinary observation',
            structuredContent: [
              { type: 'resource', uri: `fixture://guide/?q=${encoded}` },
              { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
            ],
          },
        ],
      },
    ]);
    assert.equal(JSON.stringify(received).includes(encoded), false);
    assert.match(JSON.stringify(received), /fixture:\/\/safe\/guide/);
  } finally {
    if (previous === undefined) delete process.env.MOSS_TEST_PROJECTION_SECRET;
    else process.env.MOSS_TEST_PROJECTION_SECRET = previous;
  }
});

test('remote propagates secrets discovered in resource metadata', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'user',
      timestamp: 0,
      content: [
        {
          type: 'tool_result',
          content: 'ordinary observation',
          structuredContent: [
            {
              type: 'resource',
              uri: `fixture://guide/?token=${opaquePassword}`,
              name: opaquePassword,
            },
          ],
        },
      ],
    },
  ]);
  assert.equal(JSON.stringify(received).includes(opaquePassword), false);
});

test('remote preserves emphasized Markdown and safe resource metadata', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'user',
      timestamp: 0,
      content: [
        {
          type: 'tool_result',
          content: 'Password ***required***',
          structuredContent: [
            { type: 'resource', uri: 'fixture://safe/guide', name: 'safe guide' },
          ],
        },
      ],
    },
  ]);
  const result = received.messages[0].content[0];
  assert.equal(result.content, 'Password ***required***');
  assert.equal(result.structuredContent[0].uri, 'fixture://safe/guide');
  assert.equal(result.structuredContent[0].name, 'safe guide');
});

test('remote preserves gcc flags while protecting credential commands', async () => {
  const received = await captureRemoteRequest([
    {
      role: 'assistant',
      timestamp: 0,
      content: [
        {
          type: 'tool_use',
          id: 'gcc-1',
          name: 'fixture',
          input: {
            argv: ['gcc', '-pthread', '-pipe', '-O2'],
            mysql: ['mysql', `-p${opaquePassword}`],
          },
        },
      ],
    },
  ]);
  const input = received.messages[0].content[0].input;
  assert.deepEqual(input.argv, ['gcc', '-pthread', '-pipe', '-O2']);
  assert.equal(JSON.stringify(input).includes(opaquePassword), false);
});
```

- [ ] 第五项是阶段 A 的 `messages.map` 测试；重新运行它以确认阶段 B 未回归。对每个 B1 新测试先运行聚焦 suite 并记录基线失败断言，尤其核实 `?q=` 未被其他规则提前遮盖；若 fixture 没有产生预期红灯，调整合成值或构造，不先改产品代码。
- [ ] 补充跨结果字段、消息和请求字段的顺序反转测试：先出现无标签副本、后出现 `Authorization` / `password` / resource URI；同时覆盖 `systemPrompt`、`customInstructions`、thinking、tool input、error context、路径报告。断言原值及其查询编码均不存在，正常文本、header、图片和资源仍存在。扩展远程 helper 接收 `systemPrompt` / `customInstructions` 时，只在 provider 的 `compact` 参数中传入这些合成值。

### Task B2：让检测器显式报告值并统一投影

**Files:** `src/safety/tool-output-redact.ts`, `src/safety/secret-sanitizer.ts`, `src/safety/known-secrets.ts`, `src/safety/egress-projection.ts`, `src/core/tools/execute-tool-call.ts`, `src/context/remote-compaction.ts`。

- [ ] 给现有检测器增加内部发现回调，保留原有调用者的字符串返回契约。字段来源至少区分已知值、header、argv、URL、赋值和 PEM；确切原值不可恢复的分支设置 `context.incomplete = true`。以下签名用于连接旧入口和新边界，不能把发现值写到 `noteKnownSecret`：

```ts
export interface EgressDiscovery {
  add(value: string, source: 'known' | 'header' | 'argv' | 'url' | 'assignment' | 'pem'): void;
  markIncomplete(): void;
}
// Keep redactEgress's existing return type and optional parameters compatible;
// pass EgressDiscovery only through an internal options field or internal wrapper.
```

- [ ] 在快照上先完成所有字段发现，之后才投影结果；重复值、转义和支持的 URL 表示使用统一上下文。对于保留的 error，递归生成新的 `MossError` / `Error`、安全 stack / hint / context 与可观察 cause 链；宿主 hook 显式替换时维持原有错误详情隐藏策略。
- [ ] 按固定契约处理查询 `+` / `%FF`、Markdown 掩码、命令上下文、短值和旧记录；对只含安全文本的普通 `lines`、有效 URL 中的字面路径 `+`、正常 headers、图片与资源增加正向断言。覆盖先后顺序、空 `content`、same-text hook、resource text 与 visible text 的包含关系，以及无法识别值时整份受影响投影关闭。
- [ ] 再次 build 并运行两个 B1 suite；应观察 B1 的每一项由红变绿，A1 维持绿灯。运行 `structured-tool-projection`、`tool-structured-text-budget`、`fresh-observation` 的过滤测试，确认旧结构化文本和 hook 语义不回归。

### Task B3：性能、SDK 迁移和最终验证

**Files:** `test/security-tool-redaction.spec.mjs`, `test/remote-compaction-redaction.spec.mjs`, `CHANGELOG.md`。

- [ ] 使用合成 fixture 检查预算：恰好上限可完成，上限加一拒绝；1000 条正常消息、每条约 256 字符、64 个已发现值的投影不得超过工作量预算。记录 Node 22 同机至少三次的阶段前后耗时和输入大小，不把依赖机器性能的绝对毫秒值放入 CI 断言；若正常数据频繁触发预算，先调整有证据的阈值并补相应边界测试。
- [ ] 更新 `CHANGELOG.md` 的中英文 0.x 行为说明：哪些内容保留 / 隐藏、无程序名的 `-pVALUE`、Markdown、URL、短值误删、accessor / 超限结果错误、远程投影失败不回退、消息快照可能改变对象身份，以及宿主应把结构化字段缺失或 withheld 当作安全降级而非工具未运行。记录现有公开导出不变；若实际新增 `src/index.ts` 导出，按项目 SDK 快照和 semver 规则另行更新。
- [ ] 在独立 worktree 用 Node 22 运行以下命令；每条都检查退出码。`test:filter` 不自动 build，故 build 必须先成功。`cli-print-redact` 使用既有仅回环监听的 CLI fixture；它是 CLI 安全冒烟，不能代称五项都经过真实远程服务验证。

```sh
npm run build
npm run test:filter -- --filter security-tool-redaction --filter remote-compaction-redaction
npm run test:filter -- --filter structured-tool-projection --filter tool-structured-text-budget --filter fresh-observation
npm run test:filter -- --filter compaction --filter cli-print-redact
npm run check
```

- [ ] 审查 `git diff --check`、精确路径及每个测试的真实结果；不运行全量 `npm run verify`，不 push。按阶段分别提交时只暂存本阶段文件，提交信息末尾使用 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 明确不保证

未标注、未配置且不匹配现有检测器的任意秘密，未知或多层编码、加密、分片与图片像素 / 压缩数据中的内容无法保证识别；保留 SDK 图片能力意味着宿主以后仍可能自行外发这些字节。恶意同进程代码、被篡改的全局内建对象与能够伪造描述符的 Proxy 不受进程内投影沙箱保护。既往事件、日志和已经发出的请求不能回收；本计划也不把远程服务返回的摘要视为可信指令。
