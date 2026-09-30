# 对抗性评审报告 — task-3（adversarial-reviewer）

评审对象、方法与全部命令输出可复现。评审 worktree：
`/Users/d-robotics/Desktop/RDK_Studio/moss-team-review`（team/review），
基线 origin/main=dd27b023（fast-forward 验证），cherry-pick c9b42586 为 192dd5e2，
另拷入 capability-value 的 5 个未提交文件做集成验证。两人的 worktree 只读访问，未在其中执行任何写操作或构建。

---

## 一、loop-intelligence — 提交 c9b42586（修复历史注入 + TaskRepairNudge）

### 判定 1：修复历史注入有真实上界 — ✅ 成立

- 证据：`src/core/task/task-engine.ts`（c9b42586 后）`REPAIR_HISTORY_MAX_ENTRIES=3`、`REPAIR_HISTORY_MAX_CHARS=200`，`repairHistoryFrom` 对 `repairs`/`openFailures` 各取尾 3 条、每条 clip 200 字符；snapshot 在 repair-prompt 构建时新鲜获取（verifyRepairLoop 内 getTaskStateSnapshot，dist 对应 task-engine.js:181 调用链）。
- 反证实验（我在 review worktree 实跑，/tmp/adversarial-repair-bound.mjs）：预置 10 条 10KB 的 repair + 10 条 10KB 的 unresolved failure，第二个 repair prompt 总长 **2421 字符**，只含最新 3 条（R9/S9 在场），无任何 300+ 字符未截断段。**prompt 撑爆被证伪：上界真实存在（约 2.5KB 硬顶）。**
- 字段形状核对：repair.action / failure.symptom / failure.resolved 与 `src/contracts/task-runtime.ts:84-108`（FailureRecord/RepairRecord）一致；resolved 由 record_failure 生命周期真实维护（task-tools.ts:334）。

### 判定 2：TaskRepairNudge 触发语义 — ✅ 基本成立，附 3 项新问题

反证实验（/tmp/adversarial-nudge-check.mjs，全部打真实 dist）：

| 反例                                                                            | 结果                                                                   |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A. 真实契约格式 FAIL verdict（dist formatAcceptanceVerdict 生成）+ 真实消息形状 | fire=true ✅ 集成无裂缝                                                |
| B. 40KB 巨型 verdict（截断保头尾后首行仍在）                                    | fire=true ✅ 不因截断失明                                              |
| C. partial verdict                                                              | silent（设计使然，见新问题 3）                                         |
| D. attempts=1 二次触发 / attempts=2 静默                                        | 封顶=2 成立，不会无限触发                                              |
| E. 无修复直接重跑 task_acceptance 再 FAIL                                       | 仍触发 ✅ 无假抑制                                                     |
| F. registry 全链路：FAIL 注入→PASS 清零→新 FAIL 再触发                          | 成立（taskRepairNudgeAttempts 1→0→1）                                  |
| G. 无 acceptance 活动的普通 run                                                 | 零注入 ✅ 无噪声                                                       |
| H. **多任务遮蔽**                                                               | **task B 的 FAIL 被随后 task A 的 PASS 遮蔽 → 永不触发**（见新问题 1） |

解析器与真实 loop 消息形状核对：`src/core/loop/agent-loop-tool-execution.ts:265-274` 的 tool_result 块带 name + content（字符串），nudge 的 name/id 双通道解析兼容；正则 \`^Task acceptance \\(...\\): FAIL/m\` 与 `src/contracts/task.ts:123` 输出头行逐字匹配，且 task-tools.ts 的 task_acceptance 原样返回该文本。**"永不触发"的怀疑被证伪。**

**新问题（均可写成 spec）：**

1. **多任务遮蔽（中低）**：scanMessages 只保留全局最新一条 acceptance 结果。task A PASS 排在 task B FAIL 之后时，B 的修复引导永久静默。spec 雏形：两任务交错 acceptance（B FAIL → A PASS），断言对 B 的 open FAIL 仍应考虑触发（或文档化为已知限制）。
2. **record_evidence 单独可静音 nudge（低）**：REPAIR_PATH_TOOLS 含 record_evidence，只记证据不修复也能抑制触发。软性 + 封顶 2 次，损害有限，建议文档化或从集合中移除。
3. **partial verdict 不触发（低）**：partial 时引擎照样进修复流（verdict.passed=false），tool 结果尾部也明说 "repair what failed"，但 nudge 静默。与引擎行为不一致，建议触发弱化版或文档化。

### 判定 3：bench 对照结论 — ❌ 不成立（as delivered）

task-2 验收要求 "task-os-c-failure-repair --samples 3 对照证明轮数不升、成功率不降"。事实：

- 数据存在（bench/results/loop-intel-{post,post2,s1,s2,s3}，全部 gitSha=c9b42586），但 **未写任何对照报告**（.autopilot/reports/ 只有前一会话的 closeout/night，时间戳 01:32 早于提交 01:46）。
- **3 个失败样本全部是 HTTP 429 限流杀死**（post/03：5 轮后死；post2/03：1 轮即死；post2/02 退出码 6 但工件齐全判 PASS）——两份 stderr.log 尾部均为 HTTP 429: Rate limit exceeded（requests 限额）。干净样本 6/6 PASS。
- **轮数"下降"是统计假象**：summary.json 的 meanTurns 9/8 被 429 早死样本（5 轮、1 轮）拉低；只看真实完成样本为 11–14 轮（均值约 12.1，n=7），对比 task-2 引言的 ON 臂基线 11 轮**并无下降**。引用 meanTurns=8/9 作为改善即误导。
- worktree 内没有 pre-fix 基线臂（11/9 来自更早的不同环境 A/B），严格说不构成同环境对照。
- 结论：**代码改动本身未被证伪（干净样本全 PASS，轮数未恶化超出噪声），但"回合数改善/不升"的度量主张当前无数据支撑**。需一次无 429 污染的 3-sample 重跑 + 同环境基线 + 报告落盘才算完成验收。

### 判定 4：红→绿 spec 与 verify 主张 — ✅ 成立（附保留）

- 两个 spec 在我集成的树上通过（test:filter 各 1 file passed）。
- 保留意见：两个 spec 都是新增模块 spec，"修复前失败"以模块缺失形式成立；engine spec 的断言（repair2 prompt 含 do-not-repeat/旧 repair 文本）对"撤掉注入但保留模块"的回归真实有效，属可接受实践。
- 其 "npm run verify green (179 spec files)" 与我的集成验证一致（见第三节）。

---

## 二、capability-value — 未提交产出（bench 任务 + fixture + spec + A/B 数据）

### 判定 5：fixture 真的被 bench 工作区装载（.moss/mcp.json 链路）— ✅ 成立

我独立实跑全链（/tmp/adversarial-chain.mjs，review worktree 的 dist）：
loadMcpConfigs(工作区) 从 files/.moss/mcp.json 读出 warehouse/stdio → 三个 ENV 引用（SERVER/SECRET/LOG）全部正确展开（实现：src/cli/mcp-config.ts:37-42 expandEnvRefs，覆盖 command/args/env）→ stdio 连接 → tools/list 返回 3 工具 → ledger_lookup 返回的 checksum 与 sha256(secret|ORD-4771) 逐字节相等 → 服务器侧 mcp-calls.jsonl 落账。他们的 A/B 数据（两臂 toolSequence 都出现 mcp**warehouse**ledger_lookup、服务器日志有真实 tools/call）与我的复现互相印证。

### 判定 6：oracle 防作弊 — ✅ 成立

files/check-goal.mjs 双条件：checksum.txt 必须 === sha256(secret|ORD-4771) **且** 服务器日志必须含 ledger_lookup(ORD-4771) 真实调用。外层 agent 自己写文件、模型瞎猜都过不了第二条；A/B 驱动每样本 randomBytes(16) 新 secret（ab-run.mjs），跨样本不可复用答案。唯一理论缺口：bench-harness 路径 secret 是 task.json 常量，嵌套 agent 可从自身 env 读到并自算 sha256——但 oracle 仍强制真实 tool call，度量对象（工具须被发现并调用）不受影响。

### 判定 7：新 spec 质量 — ✅ 成立（但被 prettier 卡死，见判定 9）

test/mcp-bench-server.spec.mjs 经真实 dist McpClient 走 stdio 线协议锁 fixture 契约（目录形状、checksum 推导、错误路径、请求日志），在集成树上通过。

### 判定 8：A/B 结论 — ⏳ 未完成，且现有数据部分证伪机制主张

- capability-mcp-ab 只有 samples.json（summary.json 仅在全程跑完才写）→ 运行中断，**无结论落盘**；smoke-on 仅 1 样本。
- 中期数据（每臂 3 样本）：pass OFF 2/3、ON 2/3；两个失败（off#2、on#2）均为 exit 2 引擎崩溃，栈顶同为 dist task-engine.js:181（verifyRepairLoop 调用处）——**驱动器只保留 stderr 尾 4 行，无法从工件定因**（改进项：保留完整 stderr 或错误类别）。
- **机制主张被自己的数据削弱**：ON 臂全部完成样本的 firstMcpAction 仍是 search（先 search 1 次再直调），"选中→reveal→免搜索直调"（docs/capability-layer.md 第 3 条的端到端效果）**未被观测到**；实际收益形态是 search 次数 3→1、toolUses 34/42/37→24/30/8、wall 变短（on#3 32s vs off 约 120s）。n=3 且每臂 1 崩溃，无统计功效下不能宣称正收益。
- 任务书要求"若 ON 臂不占优，如实报告并分析原因"——等待其跑完后补评；以现有数据，ON 未占优亦未落败，机制层面确实降低了搜索成本但未消除搜索回合。

### 判定 9：交付门禁 — ❌ npm run verify 因这 5 个文件变红

实跑（集成树，cherry-pick + 拷入文件后）：
npm run check exit 1，Prettier 恰好命中全部 5 个交付文件：
bench/tasks/capability-mcp-ledger/ab-run.mjs、.../files/check-goal.mjs、.../task.json、test/fixtures/mcp-bench-server.mjs、test/mcp-bench-server.spec.mjs。
AGENTS.md："Prettier 负责格式"、"verify 交付前必须绿"。**修复成本一行（prettier --write），但提交前必须做。** 我在评审 worktree 对副本执行 --write 后 check 转绿，确认无其他问题。

### 小项（不阻塞）

- ab-run.mjs 用 execSync(git rev-parse)：工具执行路径禁 execSync 的约束不覆盖 bench 脚本，且 scripts/run-benchmark.mjs 同样直接 spawn；可接受，注明即可。
- 凭据：API key 写入 tmp 下 0600 config.json，finally 删除——但 --keep 时会留存于磁盘；建议 --keep 路径也清理 config 子目录。

---

## 三、集成验证（我的 worktree，dd27b023 + c9b42586 + cap 5 文件）

| 门                                            | 结果                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| npm run check（format+lint+typecheck）        | capability 文件 **prettier --write 前 exit 1**；修格式后 **exit 0**               |
| npm run test                                  | **exit 0，180 spec 文件全过**（基线 178 + loop 2 + cap 1，与 loop 自报 179 一致） |
| npm run smoke                                 | PASS（version/help/PTY REPL）                                                     |
| loop 两个新 spec + cap 新 spec（test:filter） | 全部通过                                                                          |

即：**代码层面双方产出可共存、可合入；唯一的门禁红灯是 capability 文件的格式问题。**

## 四、总裁决

- **loop-intelligence c9b42586：代码可合入**（两项修复真实、有界、有回归测试、verify 绿）。但 task-2 的 bench 验收（同环境对照 + 无污染 3-sample + 报告落盘）**未完成**——建议合码与验收分开处理，要求补一次无 429 的重跑与诚实报告（含"轮数未见下降"的可能结论）。
- **capability-value：需返工后合入**：(1) prettier --write 全部 5 文件（否则 verify 红）；(2) 跑完 A/B 并落盘 summary+结论（ON 不占优就如实写，重点解释 ON 臂为何仍先 search 一次）；(3) ab-run.mjs 保留完整 stderr 以便定因崩溃样本。fixture/oracle/spec/driver 设计质量高，方向不需要改。

## 五、可写成 spec 的反例清单（给下一轮）

1. 多任务 acceptance 交错：B FAIL → A PASS → 断言对 B 的引导不应被永久静音（task-repair-nudge）。
2. 巨型 repair/failure 记录：断言 repair prompt 长度 < 3KB（repair-history 上界锁死）。
3. partial verdict：明确断言当前 silent 行为（锁死语义，防止未来误改）或改为触发。
4. mcp-bench fixture：对 task.json 常量 secret 路径补一条"自算 checksum 但无 tool call 必 FAIL"的 oracle 反例（已隐式成立，显式化更稳）。

---

## 六、补评（2026-10-01 深夜）— capability-value A/B 跑完后的增量评审

A/B 已完成并落盘 `.autopilot/reports/capability-mcp-ab-report.md` + summary.json + crashretry 两臂复跑。逐项复核：

1. **数据自洽性 — ✅**：合并统计的算术逐项对过原始 JSON：OFF toolUses 34/37/31→34.0、ON 24/8/25→19.0、wall OFF 118.6/128.0/84.7→110.4s、ON 103.9/32.3/64.9→67.0s，与报告表格一致。
2. **selection 预检主张 — ✅ 独立复核**：我用评审树 dist 的 matchTaskCapabilities 对 bench goal 实跑：`mcp__warehouse__ledger_lookup` score=8 入选，两个 decoy score=0 连 candidates 都不进——"ON 臂 reveal 恰好一个工具"成立，且 goal 措辞避开了 wire-name 污染。
3. **崩溃样本定因 — ⚠️ 可接受但工件不足**：两臂各 1 次 exit 2 对称发生，报告归因"LLM 调用抛错（瞬态）"。samples.json 只留 4 行 stderr（栈帧在 runTurn），单靠工件不能证明"瞬态"；但 crashretry 两臂复跑均 PASS，间接支撑。改进项维持：驱动器保留完整 stderr。
4. **结论的诚实度 — ✅ 高**：明确写了负结果（引擎回合 2.0 vs 2.0 持平，"能力层不省引擎回合"）、明确写了细微负发现（ON 3/3 仍有 1 次 planning 期自主 search）、明确承认 n=3 无显著性检验。我对中期数据"ON 仍先 search → 机制未观测"的质疑，报告用"消除的是执行路径发现成本，不是探索行为"回应——与 OFF 臂反复 search(3)+重查 ledger_lookup(3) vs ON 一次直调(1) 的数据一致，接受该解释；注：docs 第 3 条的字面"without a search round trip"依赖模型行为，不是层能保证的硬承诺，建议 docs 措辞对齐。
5. **验收对照 task-1 — 部分达成**："两臂数据 + 结论写入 .autopilot/reports/" ✅；"ON 臂占优"在机制级指标（search −2/任务、toolUses −44%、wall −39%）方向一致地占优 ✅，在引擎回合上如实报告持平 ❌（诚实负结果）。以任务书"若 ON 臂不占优，如实报告并分析原因"的标准，此交付合格。
6. **prettier — ❌ 仍未修**：补评时再跑 `pretttier --check`，5 个交付文件仍然全部 warn。这是合入前唯一硬阻塞。

### 补评后总裁决（更新第二节）

capability-value：**A/B 交付合格（数据+诚实结论落盘），返工清单从 3 项缩为 1 项硬阻塞 + 1 项建议**：

- 硬阻塞：prettier --write 5 个文件（否则 npm run verify 红，AGENTS.md 门禁）。
- 建议：ab-run.mjs 保留完整 stderr；docs/capability-layer.md 第 3 条措辞与实测对齐。

---

## 七、最终闭环复核（集成 main = 4f1c50a3）

### e6330564（多任务遮蔽修复）— 已关闭

- spec case 8-9 精确对应我的发现 1（B FAIL 不再被 A PASS 遮蔽 + per-task 修复归因）；case 11-12 把发现 2/3 锁为已知限制（理由成立：evidence 是合法进度、partial 非 red），属合理处置。
- 我在集成树 dist 上跑 6 项反例（真实 formatAcceptanceVerdict 格式）：①B-FAIL 不再被 A-PASS 遮蔽且 correction 指名 task_B；②A 的 repair 不再静音 B；③B 自身 repair 仍正确静音；⑤registry 注入/PASS 清零不变；⑥双 pending 取最新。全部符合。
- **新问题（低，残留边界）**：无归因的 task_acceptance 调用（省略 task_id——工具 schema 明文允许的"评估最新契约"用法）仍会遮蔽其他任务的 pending FAIL（isRepairActivityFor 的保守分支 use.taskId === undefined 对所有任务生效）。实证：B FAIL → 无 id 的 task_acceptance（实际评估 A，PASS）→ B 仍静音。建议后续从 acceptance 结果文本回填 task id 或写入 spec 注释。

### 73ae4488（cap 返工）— 已关闭（附 2 项精确 caveat）

- prettier：7 个交付文件 --check 全过；集成树 format:check 绿。
- 数据对账：提交的 samples/summary 与报告表格逐项一致（合并均值重算：asst 22.0 vs 14.0、tools 34.0 vs 19.0、wall 110.4s vs 67.0s 全对）。
- docs b4fe0088：第 3 条措辞已按实测改写（含 engine turns are not reduced 负结果）。
- 完整 stderr：驱动器已写 logs/<arm>-<sample>.{out,err}.log（提交代码 334-339 行）成立，但 (a) 提交的三组数据跑在改动之前，崩溃样本无完整日志可查；(b) .gitignore 的 \*.log 使未来日志也不会入库——定因依据仍是 4 行尾 + 对称复跑 PASS。非阻塞，未来跑批注意。
- --keep 密钥清理：已提交代码 finally 无条件删 configDir 成立。

### 集成验证 — 已关闭

npm run verify 于 4f1c50a3 exit 0（180 spec + smoke 全过）。注：首次跑挂在我自己的报告 markdown 上（.autopilot/reports 转为跟踪目录后被 prettier 扫到），格式化本人文件后全绿——两位开发者的代码从未红过。

### 最终裁决

能力层与两项团队产出达到可发布标准；仅余两项低优先跟进（无归因 acceptance 的遮蔽残留、bench 日志不入库的定因局限），不阻塞发布。
