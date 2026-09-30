# 能力层 MCP 富集环境正收益 bench 证据（capability-mcp-ledger A/B）

- 日期：2026-10-01（晚）
- Worktree：`/Users/d-robotics/Desktop/RDK_Studio/moss-team-cap`，分支 `team/capability-value`，基线 `58026e9b`（feat(capability): adversarial round 2 + measured layer diet + A/B switch）
- 模型：deepseek-flash@latest（openai-compatible，`~/.moss-ap-env` 提供 key），MOSS_TEMPERATURE=0
- 原始数据：`.autopilot/reports/capability-mcp-ab/`{samples,summary}.json`（主实验 3+3）、`.autopilot/reports/capability-mcp-ab-crashretry-{off,on}/`（429 崩溃样本复跑）

## 实验设计

**为什么必须走 `moss task run` 而不是 `moss -p`**：能力层唯一的生产注入点是
`src/cli/task-run.ts` 的 `buildCapabilityLayerForGoal` → task engine 的 planning prompt
（`src/core/task/task-engine.ts` planningPrompt）。`moss -p` 一次性模式不经过该路径，
`MOSS_CAPABILITY_LAYER` 在 `-p` 下不起作用。因此 A/B 驱动器
（`bench/tasks/capability-mcp-ledger/ab-run.mjs`）按 `scripts/run-benchmark.mjs`
的工作区准备逻辑（mkdtemp 工作区 + files/ 拷贝 + 0600 scratch config.json + 固定 env），
直接对每个样本执行：

```
node dist/cli.js task run --goal "<goal>" --accept "node check-goal.mjs"
```

两臂唯一差异是 `MOSS_CAPABILITY_LAYER=off|on`。每样本完整 stdout/stderr 落盘在
`<label>/logs/<arm>-<sample>.{out,err}.log`（崩溃可归因）；scratch config 目录（含
API key）无论是否 --keep 都在收尾时删除。

**任务与 fixture**：stdio MCP fixture 服务器 `test/fixtures/mcp-bench-server.mjs`
（"warehouse" 域，3 个语义可区分工具：`ledger_lookup`（目标工具）、`inventory_count`、
`shipping_eta` 两个 decoy）。工作区 `.moss/mcp.json` 以 `${MOSS_MCP_BENCH_SERVER}` 指向它。
goal（"Look up the verification checksum of order ORD-4771 in the ledger …"）必须经
`ledger_lookup(ORD-4771)` 才能得到 checksum（sha256(nonce|order)，nonce 每样本随机、
只经 env 传递）；check 要求 checksum.txt 值正确 **且** 服务器请求日志里确有该 tools/call
——本地推导无法绕过工具调用。（变量名从 `*_SECRET` 改为 `*_NONCE`：safeChildEnv 的
凭据模式会剥离 `SECRET$` 结尾的变量，导致嵌套 exec 链路拿不到它——见"发现"节。）

**选中正确性预检（无 API 消耗）**：goal 经 `dist/core/task/capability.js` 匹配，
`mcp__warehouse__ledger_lookup` score=8，两个 decoy score=0——ON 臂 reveal 恰好一个工具。
（server 名 `warehouse` 与 "MCP" 一旦出现在 goal 里会经 wire name 段污染 decoy
选中——goal 措辞刻意避开这两个 token。）

## 真实命令与结果

```
set -a; . ~/.moss-ap-env; set +a
node bench/tasks/capability-mcp-ledger/ab-run.mjs --samples 3 --arms off,on --label capability-mcp-ab
```

```
arm   pass      turns  wall(s)  asstMsg  toolUses  search  direct  layerFired
off  2/3          2   122.9      24       38      3       3         0/3
on   2/3          2    79.7      14       21      1       1         3/3
```

逐样本（主实验；turns=引擎回合printed/事件重算）：

| arm | sample | pass        | 引擎回合 | wall   | 助手消息 | 工具调用 | search | direct | layer |
| --- | ------ | ----------- | -------- | ------ | -------- | -------- | ------ | ------ | ----- |
| off | 1      | PASS        | 2        | 118.6s | 24       | 34       | 3      | 4      | 0     |
| off | 2      | FAIL(exit2) | —(ev5)   | 122.2s | 27       | 42       | 3      | 4      | 0     |
| off | 3      | PASS        | 2        | 128.0s | 20       | 37       | 3      | 2      | 0     |
| on  | 1      | PASS        | 2        | 103.9s | 19       | 24       | 1      | 1      | 1     |
| on  | 2      | FAIL(exit2) | —(ev4)   | 103.0s | 15       | 30       | 1      | 1      | 1     |
| on  | 3      | PASS        | 2        | 32.3s  | 7        | 8        | 1      | 1      | 1     |

两个 FAIL 的归因：moss 进程 exit 2，栈顶在 task-engine 的 runTurn（LLM 调用抛错）。
当晚后续的嵌套冒烟（smoke3）里模型明确报告 **"429 budget exceeded" provider 错误**——
两个崩溃样本与此同源：provider 侧限流/预算，对称命中两臂各 1 次，与任务逻辑无关。
复跑验证（各 1 次，约 10 分钟后）：

```
node bench/tasks/capability-mcp-ledger/ab-run.mjs --samples 1 --arms off --label capability-mcp-ab-crashretry-off
# off #1 PASS (engineTurns=2, wall=84.7s, asst=22, tools=31, search=3, layer=0)
node bench/tasks/capability-mcp-ledger/ab-run.mjs --samples 1 --arms on  --label capability-mcp-ab-crashretry-on
# on  #1 PASS (engineTurns=2, wall=64.9s, asst=16, tools=25, search=1, layer=1)
```

剔除 429 崩溃后的合并统计（每臂 n=3：主实验 2 个完成样本 + 复跑 1 个）：

| 指标                                | OFF（n=3）                    | ON（n=3）                   | 差异           |
| ----------------------------------- | ----------------------------- | --------------------------- | -------------- |
| 任务成功率                          | 3/3                           | 3/3                         | 持平           |
| 引擎回合（planning+execute+repair） | 2/2/2 → **2.0**               | 2/2/2 → **2.0**             | **持平**       |
| 助手消息（agent-loop 回合）         | 24/20/22 → **22.0**           | 19/7/16 → **14.0**          | **−36%**       |
| 工具调用总数                        | 34/37/31 → **34.0**           | 24/8/25 → **19.0**          | **−44%**       |
| search 元工具调用                   | 3/3/3 → **3.0**               | 1/1/1 → **1.0**             | **−2 次/任务** |
| ledger_lookup 调用次数              | 4/2/3 → **3.0**               | 1/1/1 → **1.0**             | **−67%**       |
| wall 时间                           | 118.6/128.0/84.7 → **110.4s** | 103.9/32.3/64.9 → **67.0s** | **−39%**       |
| 能力层实际注入                      | 0/3                           | 3/3                         | 开关有效       |

## 结论

1. **ON 臂占优，但优势不在引擎回合数上。** 粗粒度的引擎回合（planning→execute→verify）
   两臂都是 2——一次执行回合内可以容纳"search→call→write"链，发现成本被粗粒度吸收。
   这本身是如实的负结果：**能力层不省引擎回合**（在该任务形状下）。
2. **机制级的正收益真实且方向一致**：每个 ON 样本的 search 元工具调用都更少（1 vs 3）、
   ledger_lookup 重复调用更少（1 vs 3）、agent-loop 消息更少（14 vs 22，−36%）、工具调用
   更少（19 vs 34，−44%）、wall 更短（−39%）。OFF 臂模型反复 search + 重复调
   ledger_lookup 校验；ON 臂在执行回合一次直调即完成。
3. **ON 臂 3/3 样本的 firstMcpAction 仍是 search**（planning 回合先 search 1 次再在
   执行回合直调）——"免搜索直调"在"第一个 MCP 动作"意义上**未被观测到**。机制解释：
   能力层的提示注入在 planning prompt，它**命名**工具但不**禁止**探索；模型（该基准
   模型）在 planning 回合仍习惯性 search 一次核对服务器目录（冒烟转录可见：planning
   回合 read_file + search，然后才 task_define）。层消除的是**执行路径对 search 的
   依赖**（ON 执行回合全部直调、无 search；OFF 执行回合靠 search 发现工具），不是模型
   的自主目录查看行为。对 `docs/capability-layer.md` 第 3 条（"planner can call them
   without a search round trip"）的措辞含义：**"可免搜索调用"成立（能力面）**——工具已
   reveal、执行回合确实零 search 直调；**"必然免搜索"不成立（行为面）**——planning
   回合的目录核对仍在。建议措辞保持"can call without"（能力表述），不要写成
   "skips the search"（行为表述）。
4. **A/B 开关本身有效**：layerFired 3/3 vs 0/3（session 里 planning prompt 是否含
   "Task capability discovery"），与 `MOSS_CAPABILITY_LAYER` 语义一致。

## 过程中发现（产品行为，非本任务改动）

- **safeChildEnv 剥离 `*SECRET` 命名变量**：嵌套 `moss -p` → exec → 内层 moss 链路中，
  名为 `MOSS_MCP_BENCH_SECRET` 的变量被 exec 工具的 `childEnv`（safeChildEnv 封装）按
  凭据模式剥离（`MOSS_MCP_BENCH_LOG` 同在 task.env 却能通过）。这使"经 env 向嵌套
  runtime 传 bench 参数"对命名敏感。已将变量改名 `MOSS_MCP_BENCH_NONCE` 规避；若
  未来有同类需求，这是文档级的坑。
- **moss 启动时加载工作区 `.env`（仅填未定义变量）**：smoke1 中内层 agent 在 429 受阻
  期间自写 `.env`（含 fixture 默认 nonce）让后续嵌套 moss 能起——不影响 A/B（驱动器
  直跑、工作区无 .env），但 bench 工作区里 agent 可通过写 .env 影响后续进程 env。

## 嵌套 `-p` bench 形态的验证状态（诚实边界）

task.json 的 `-p` 形态（外层 agent exec 嵌套 `moss task run`）设计上让该任务在
`npm run bench` 语料里也经过能力层路径，且 `requiresEnv: ["MOSS_MCP_BENCH_SERVER"]`
保证未配置时跳过、不影响既有 baseline。三次冒烟：

- smoke1：外层 600s 预算耗尽（嵌套 run 被前台 exec 300s 超时打断后重启）→ 预算提到
  900s + prompt 加 exec 超时指引；
- smoke2：bench 级 check 跑在极简 env（无 task.env）看不到 nonce → check.mjs 改为从
  task.json 恢复 nonce；外层又被 429 截断；
- smoke3：嵌套 run **已成功连接 warehouse MCP 服务器**（stderr 有 "connected (3 tools)"，
  nonce/config 透传链路全通），但 LLM 调用撞 429 budget exceeded，未得到绿色样本。

即：设计缺陷已逐个修复并以日志证实；**全绿样本被 provider 429 预算阻塞，待额度恢复后
一条命令即可复验**。A/B 结论数据不依赖该嵌套路径。

## 交付物与未做

- 新增：`bench/tasks/capability-mcp-ledger/`（task.json + files/.moss/mcp.json +
  files/check-goal.mjs + check.mjs + ab-run.mjs）、`test/fixtures/mcp-bench-server.mjs`、
  `test/mcp-bench-server.spec.mjs`（fixture 契约：catalog 形状、sha256 推导、请求日志；
  4/4 绿）。
- 未做：未改任何 src/；未跑 SWE-bench；3 samples/臂是小样本，方向一致但无显著性检验；
  事件重算回合数（ev 列）与 printed 回合数偶有偏差（task_acceptance 工具也会落
  verification 事件），以 printed 为准；嵌套 `-p` 形态的全绿样本待 provider 额度。
