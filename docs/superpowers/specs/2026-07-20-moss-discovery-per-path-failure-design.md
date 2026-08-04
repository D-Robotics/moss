# moss 优化:discovery 工具失败计数改 per-path

**Date**: 2026-07-20
**Status**: Design / 待 review
**来源**: moss-eval trial1 实测证据(L3-02 moss 运行,19 步绕弯修一个除零 bug)
**Scope**: 仅 `packages/moss-agent/src/core/tools/tool-loop-guard.ts` 一处模块的计数策略调整 + 配套测试。不改工具实现、不改其他守卫。

## 背景与问题

### 现象(实测)
moss-eval L3-02 任务(修 divide 除零)中,moss 用 19 步才完成,远超必要:

1. 模型先用**错误路径** `fixtures/sample-lib/src/calc.ts` 调 `read_file`,失败 2 次(file not found)
2. 第 3 次用**正确路径** `src/calc.ts`(文件**存在**)→ 被 `tool-loop-guard` **误阻断**:
   `read_file has failed 2 time(s) in this user turn. Discovery is failing repeatedly — STOP`
3. 模型被迫绕路:`search_code` ×6 → `edit_file` 被 `requirePriorReadError` 守卫拦(没读到文件不许编辑)→ `exec cat` 才看到文件 → 写临时 `.cjs` 脚本去 patch → 删除

第 2 步是核心问题:**路径明明对了、文件明明在,却因前两次(不同路径)的失败被禁止调 read_file**。

### 根因(源码确认)
`packages/moss-agent/src/core/tools/tool-loop-guard.ts`:

- discovery 工具(`read_file`/`search_code`/`search_files`/`list_directory`,见 `DISCOVERY_TOOLS` set,~line 24)的**失败计数在 `byToolFailure`**(`Map<string, number>`,key 是工具名)→ **tool 级,不是 path 级**。
- 故路径 A 的失败会让整个 `read_file` 工具被标记为「失败 2 次」,从而阻断对路径 B 的读取。
- 对比:`web_fetch` 已按 URL 计数(`byWebFetchUrlFailure`,~line 115/283),`edit_file`/`multi_edit`/`apply_patch` 已按 path 计数(`byEditPathFailure`,~line 121/297)。源码 line 289-292 注释明确写明原则:**「Do NOT also bump tool-level failure — that would block edits on other files after three thrashing retries on one path」**。
- 即:**moss 团队已认识到此原则,并已应用到 web_fetch(按 URL)和 surgical-edit(按 path),但漏给了 discovery 工具**。grep 确认无 `byReadPathFailure` / `byDiscoveryPathFailure`。

### 为何之前未暴露
L3-02 moss 最终 `fixMatched=true`(功能修对了),耗时 9 turns 仍在 `maxTurns=30` 内。表面「任务完成」,掩盖了中间 ~15 步绕弯。只有逐帧看 `stream.jsonl` 才能抓到第 2 步的误阻断。

## 目标

让 discovery 工具的失败计数也按 path(或 path+pattern)隔离,使「错路径失败 N 次」只阻断**该路径**,不污染对**其他路径**的读取。预期收益:L3-02 类场景里,模型错路径试 2 次后,正确路径的 read_file **不再被误阻断**,可直接读到文件 → 直接 edit,省掉 ~15 步绕弯。且**不影响**真正的同路径死循环防护(同 path 仍 2 次后阻断)。

## 非目标

- 不改 `DISCOVERY_TOOLS` 的成员清单。
- 不改 `DEFAULT_DISCOVERY_FAILURE_LIMIT = 2` 的默认值(同 path 阈值不变)。
- 不改 `requirePriorReadError`(edit-before-read 守卫)—— 它行为正确,只是上游 read 被误断后连带触发。
- 不改 `validateToolInputObject`/schema 校验(评估已确认它无问题,见 [[moss-discovery-failure-per-path-gap]])。
- 不改其他守卫(identical-input、single-tool、total、web_search variation)。

## 设计

### 1. 新增 per-path 失败计数 state

`ToolLoopGuardState` 加一个字段(类比 `byEditPathFailure`):

```typescript
byDiscoveryPathFailure: Map<string, number>;
```

key = 归一化后的「discovery 目标」(path / path+pattern,见 §2)。`createToolLoopGuardState()` 同步初始化。

### 2. 提取 discovery 目标 key(区分对待,见「待决 1」)

新增纯函数 `collectDiscoveryTargetKeys(input): string[]`(类比已有的 `collectSurgicalEditPathKeys`),按工具类型区分 key 形态:

- **按 path**(`read_file` / `list_directory` / `device_file_read` / `device_file_list`):key = `normalizePathKey(input.path)`。失败本质是路径错,只按 path 隔离。
- **按 path+pattern**(`search_code` / `search_files`):key = `normalizePathKey(input.path ?? '.')` + `'::'` + `String(input.pattern ?? '')`。两者都用 `input.pattern` 字段(search_files 描述写 "Glob pattern" 但字段名也是 `pattern`,已核实 `search-tools.ts:354`)。失败本质是搜不到,pattern 进 key 避免不同搜索互染。`path` 缺省时用 `'.'`(与工具默认一致)。

返回 `string[]`(多数情况 1 个元素;留数组形式与 `collectSurgicalEditPathKeys` 对齐)。无可用 path 时返回 `[]`,回落到现有 tool-level 计数(不丢信号)。

> 归一化:复用现有 `normalizePathKey`(trim + 反斜杠转正斜杠 + 小写)。

### 3. recordToolLoopOutcome:discovery 失败只计 per-path,不 bump tool-level

在 `recordToolLoopOutcome` 里,`SURGICAL_EDIT_TOOLS` 分支后、`byToolFailure` 分支前,插入 discovery 分支(完全类比 surgical-edit 的写法,line 293-304):

```typescript
if (DISCOVERY_TOOLS.has(toolName)) {
  const targetKeys = collectDiscoveryTargetKeys(input);
  if (targetKeys.length > 0) {
    for (const key of targetKeys) {
      state.byDiscoveryPathFailure.set(
        key,
        (state.byDiscoveryPathFailure.get(key) ?? 0) + 1,
      );
    }
    return; // 不 bump byToolFailure —— 避免一个路径失败污染整个工具
  }
  // 无 path 可 key(不应发生)→ 落到下面 tool-level,不丢信号
}
state.byToolFailure.set(toolName, (state.byToolFailure.get(toolName) ?? 0) + 1);
```

### 4. shouldShortCircuitToolCall:discovery 改 per-path 判断

在 `shouldShortCircuitToolCall` 里,discovery 工具的失败判断从 tool-level 改为 per-path(完全类比 surgical-edit 的 line 626-634 + web_fetch 的 line 652-663):

```typescript
if (DISCOVERY_TOOLS.has(toolName) && effectiveFailureLimit !== undefined) {
  const targetKeys = collectDiscoveryTargetKeys(input);
  if (targetKeys.length > 0) {
    for (const key of targetKeys) {
      const pathFails = state.byDiscoveryPathFailure.get(key) ?? 0;
      if (pathFails >= effectiveFailureLimit) {
        return `discovery on ${key} has failed ${pathFails} time(s) in this user turn`;
      }
    }
    // 有 path key 且未超阈 → 不阻断(即使 tool-level byToolFailure 有值也不再用)
    // 但仍走下面 identical-input / single-tool / total 守卫
  }
  // 无 path key → 回落到原 tool-level 判断(byToolFailure),保持兼容
}
```

注意:`effectiveFailureLimit` 对 discovery 工具已经是 `DEFAULT_DISCOVERY_FAILURE_LIMIT = 2`(line 619-622 的现有逻辑),所以同 path 仍是 2 次后阻断,阈值不变。

### 5. 守卫消息:discovery 失败改成「此路径,换路径」

`formatToolLoopGuardMessage` 里,discovery 失败的分支(line 555-562)调整文案,从「整个 read_file 别再调」改为「此路径失败,换路径/工具」:

```typescript
if (/^discovery on .+ has failed \d+ time/.test(reason)) {
  return [
    `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
    'This specific path/target is not returning usable results — STOP retrying THIS path.',
    'Other paths are fine: you may read/search a different path, or use a different discovery tool.',
    'If the path was wrong, fix the path. Never invent file contents you did not actually read.',
  ].join(' ');
}
```

(完全类比 web_fetch per-URL 失败的文案,line 327-334。)

### 6. identical-input 守卫保持不变

`identical input was already requested`(line 667-669)按 signature 计数,已经天然是 per-(tool+input),不会误伤 —— **保留不动**。所以「同路径同参数重复」仍被 identical-input 守卫拦,「同路径不同参数」被新的 per-path 失败守卫拦,「不同路径」不再被误拦。三层互补。

## 接口与契约(供下游 + 测试)

- `ToolLoopGuardState` 新增 `byDiscoveryPathFailure: Map<string, number>`。
- 新增导出 `collectDiscoveryTargetKeys(input?: Record<string, unknown>): string[]`(供测试,类比 `collectSurgicalEditPathKeys` 已导出)。
- `recordToolLoopOutcome` / `shouldShortCircuitToolCall` 签名不变。
- `shouldShortCircuitToolCall` 对 discovery 工具新增返回原因字符串 `discovery on <key> has failed N time(s) in this user turn`(供 `formatToolLoopGuardMessage` 匹配)。

## 测试

新增/扩展 `tool-loop-guard` 的单元测试(该模块已有测试文件,`@internal exported for tests` 注释表明 `collectSurgicalEditPathKeys` 已为测试导出,同模式):

1. **per-path 隔离(核心)**:`read_file` 路径 A 失败 2 次 → 第 3 次对路径 A 仍阻断(per-path 阈值),但对路径 B 的 `read_file` **不阻断**(旧行为会阻断)。
2. **同 path 阈值不变**:路径 A 失败 2 次(`DEFAULT_DISCOVERY_FAILURE_LIMIT=2`)第 3 次阻断 —— 阈值与旧版一致。
3. **identical-input 仍生效**:同 path 同 input 第 3 次被 identical-input 守卫拦(不被 per-path 取代)。
4. **search_code 的 path+pattern 组合 key**:不同 pattern 对同 path 不互相污染(或明确决定:同 path 不同 pattern 是否算同一目标 —— 见「待决」)。
5. **无 path 的 discovery 调用**:回落 tool-level 判断,不丢信号、不崩。
6. **surgical-edit / web_fetch 行为不变**:回归测试,确保新分支不影响已有 per-path 逻辑。

## 待决(已定稿)

1. **search_code 同 path 不同 pattern** —— **区分对待**(已定):
   - `read_file` / `list_directory` / `device_file_read` / `device_file_list`:失败本质是**路径错**(file not found / 路径无效)→ **按 path 隔离**(key = `normalizePathKey(path)`)。错路径不污染对路径。
   - `search_code` / `search_files`:失败本质是**搜不到**(pattern/glob 不匹配,不一定是路径错)→ **按 path+pattern 隔离**(key = `normalizePathKey(path) :: pattern/glob`)。不同搜索互不污染。
   - 兜底:同 path+同 pattern 第 3 次仍被 **identical-input 守卫**拦(signature 含完整 input,天然 per-input)—— 故「换 pattern 挣扎」的兜底由 identical-input 守卫负责,per-path 失败守卫不承担该职责。实测 L3-02 的 6 次 search_code 其实均 `ok=true`(未触发失败守卫),故此改动对它们无影响。
   - 无 path 时(search_code 的 `path=undefined` 全仓搜):用 `path='.'`(与工具默认一致)归一化进 key。
2. **device_file_read / device_file_list 是否同步加 per-path** —— **是**(已定,一致性)。其 input 若有 `path` 字段则走 per-path;无则回落 tool-level,无害。

## 风险

- **低**:改动隔离在一处模块 + 一处 state,签名不变,下游(`agent-loop-tool-execution.ts` line 115/240)无需改。
- **回归风险**:discovery 工具的失败阻断行为改变 —— 旧行为是「read_file 失败 2 次后整个工具停」,新行为是「同 path 失败 2 次后该 path 停,其他 path 继续」。可能让某些原本被「误断」提前收敛的场景现在多走几步(但通常是好事,因为能读到正确文件)。靠单元测试 + 评估回归验证。
- **评估回归**:改完 moss 后,用 moss-eval 重跑 L3-02(及其他 L3)对比 turns:预期 L3-02 moss 从 19 步降到 ~5-7 步。

## 范围外

- 不改 `DISCOVERY_TOOLS` 成员、不改阈值默认值、不改其他守卫。
- 不改 moss-eval harness(本轮评估已完成,改动后回归用现成 harness)。
- 不处理「claude L2-07/08/09 假完成」的评估盲区(那是评估设计问题,另案)。
